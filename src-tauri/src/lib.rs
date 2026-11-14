use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;
use vault_core::{
    BackupKind, BinaryVaultStorage, DirectoryVault, EntryKind, FileStats, MetadataVaultStorage,
    VaultPath, VaultStorage,
};

#[cfg(target_os = "android")]
mod android;
mod request;
mod resources;
#[cfg(any(target_os = "android", test))]
mod saf_cache;

/// Whether a SAF provider created an entry exactly where it was asked to.
/// `tauri-plugin-android-fs` reports the created path relative to the base
/// directory with a leading `/` (`/data.json`), which is not a rename.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn provider_kept_path(actual: &std::path::Path, requested: &str) -> bool {
    actual
        .to_str()
        .is_some_and(|actual| actual.trim_start_matches('/') == requested)
}

trait HostVaultStorage: BinaryVaultStorage + MetadataVaultStorage {}
impl<T: BinaryVaultStorage + MetadataVaultStorage> HostVaultStorage for T {}

struct Session {
    storage: Box<dyn HostVaultStorage + Send + Sync>,
    id: String,
    name: String,
    /// Resource URL grants; replacing the session on vault switch drops them.
    resources: resources::Grants,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultInfo {
    id: String,
    name: String,
    files: Vec<String>,
    platform: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", content = "root")]
enum SavedRoot {
    Directory(PathBuf),
    #[cfg(target_os = "android")]
    Android(tauri_plugin_android_fs::FsUri),
}

type AppState = Mutex<Session>;
type Result<T> = std::result::Result<T, String>;

fn error(value: impl std::fmt::Display) -> String {
    value.to_string()
}

fn info(session: &Session) -> Result<VaultInfo> {
    Ok(VaultInfo {
        id: session.id.clone(),
        name: session.name.clone(),
        files: session
            .storage
            .document_files()
            .map_err(error)?
            .into_iter()
            .map(|path| path.as_str().to_owned())
            .collect(),
        platform: std::env::consts::OS.to_owned(),
    })
}

fn session_for(_app: &tauri::AppHandle, root: &SavedRoot) -> Result<Session> {
    match root {
        SavedRoot::Directory(path) => {
            let path = path.canonicalize().map_err(error)?;
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            Ok(Session {
                id: path.to_string_lossy().into_owned(),
                name,
                storage: Box::new(DirectoryVault::open(path).map_err(error)?),
                resources: Default::default(),
            })
        }
        #[cfg(target_os = "android")]
        SavedRoot::Android(uri) => android::session_for(_app, uri),
    }
}

fn root_file(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(error)?
        .join("vault.json"))
}

#[tauri::command]
async fn vault_info(state: State<'_, AppState>) -> Result<VaultInfo> {
    let session = state.lock().map_err(error)?;
    info(&session)
}

fn lock_session<'a>(state: &'a AppState, vault_id: &str) -> Result<MutexGuard<'a, Session>> {
    let session = state.lock().map_err(error)?;
    if session.id != vault_id {
        return Err("The selected vault changed; this operation was cancelled".into());
    }
    Ok(session)
}

const MAX_PLUGIN_BYTES: usize = 64 * 1024 * 1024;
const MAX_PLUGIN_BASE64: usize = MAX_PLUGIN_BYTES.div_ceil(3) * 4;

#[derive(Serialize)]
struct PluginStats {
    ctime: u64,
    mtime: u64,
    size: u64,
}

impl From<FileStats> for PluginStats {
    fn from(value: FileStats) -> Self {
        Self {
            ctime: value.ctime,
            mtime: value.mtime,
            size: value.size,
        }
    }
}

#[derive(Serialize)]
struct PluginEntry {
    path: String,
    kind: &'static str,
    stat: PluginStats,
}

#[derive(Serialize)]
struct PluginWrite {
    version: String,
    stat: PluginStats,
}

#[derive(Serialize)]
struct PluginRead {
    data: String,
    version: String,
    stat: PluginStats,
}

fn plugin_path(path: &str) -> Result<VaultPath> {
    let parsed = VaultPath::parse(path).map_err(error)?;
    if path.split('/').any(|part| part.starts_with('.')) {
        return Err("Hidden vault paths are not available to plugins".into());
    }
    if path.split('/').count() > 65 {
        return Err("Vault nesting exceeds 64 folders".into());
    }
    Ok(parsed)
}

fn decode_plugin_data(data: &str) -> Result<Vec<u8>> {
    if data.len() > MAX_PLUGIN_BASE64 {
        return Err("Plugin binary payload exceeds the 64 MiB limit".into());
    }
    let bytes = STANDARD.decode(data).map_err(error)?;
    check_plugin_size(bytes.len() as u64)?;
    Ok(bytes)
}

fn check_plugin_size(size: u64) -> Result<()> {
    if size > MAX_PLUGIN_BYTES as u64 {
        return Err("Plugin binary payload exceeds the 64 MiB limit".into());
    }
    Ok(())
}

fn version(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn check_version_token(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Expected version must be a lowercase SHA256 hex digest".into());
    }
    Ok(())
}

fn plugin_read_bytes(session: &Session, path: &VaultPath) -> Result<(Vec<u8>, FileStats)> {
    let stat = session.storage.stat(path).map_err(error)?;
    check_plugin_size(stat.size)?;
    let bytes = session.storage.read_binary(path).map_err(error)?;
    check_plugin_size(bytes.len() as u64)?;
    if stat.size != bytes.len() as u64 || session.storage.stat(path).map_err(error)? != stat {
        return Err("File changed while reading; reload before retrying".into());
    }
    Ok((bytes, stat))
}

fn write_plugin_bytes(
    session: &Session,
    path: &VaultPath,
    bytes: &[u8],
    expected_version: &str,
) -> Result<PluginWrite> {
    check_plugin_size(bytes.len() as u64)?;
    check_version_token(expected_version)?;
    let (current, _) = plugin_read_bytes(session, path)?;
    if version(&current) != expected_version {
        return Err("File changed outside this plugin; reload before saving".into());
    }
    // The backend checks these exact bytes again, backs them up, and never retries conflicts.
    session
        .storage
        .save_binary(path, bytes, &current)
        .map_err(error)?;
    Ok(PluginWrite {
        version: version(bytes),
        stat: session.storage.stat(path).map_err(error)?.into(),
    })
}

#[tauri::command]
async fn plugin_vault_snapshot(
    vault_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<PluginEntry>> {
    let session = lock_session(&state, &vault_id)?;
    Ok(session
        .storage
        .snapshot()
        .map_err(error)?
        .into_iter()
        .map(|entry| PluginEntry {
            path: entry.path.as_str().to_owned(),
            kind: match entry.kind {
                EntryKind::File => "file",
                EntryKind::Folder => "folder",
            },
            stat: entry.stat.into(),
        })
        .collect())
}

#[tauri::command]
async fn plugin_vault_read(
    vault_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<PluginRead> {
    let path = plugin_path(&path)?;
    let session = lock_session(&state, &vault_id)?;
    let (bytes, stat) = plugin_read_bytes(&session, &path)?;
    Ok(PluginRead {
        data: STANDARD.encode(&bytes),
        version: version(&bytes),
        stat: stat.into(),
    })
}

/// Upper bounds for one `plugin_vault_read_many` call. The session lock is held
/// for the whole batch, so it stays small enough not to stall saves.
const MAX_BATCH_FILES: usize = 64;
const MAX_BATCH_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Serialize)]
#[serde(untagged)]
enum PluginReadItem {
    Read(PluginRead),
    Failed {
        error: String,
        /// Not read because the batch byte budget ran out; read it on its own.
        deferred: bool,
    },
}

fn read_many(session: &Session, paths: &[String]) -> Result<Vec<PluginReadItem>> {
    if paths.len() > MAX_BATCH_FILES {
        return Err(format!("A batch may read at most {MAX_BATCH_FILES} files"));
    }
    let mut budget = MAX_BATCH_BYTES;
    Ok(paths
        .iter()
        .map(|path| {
            let failed = |error: String| PluginReadItem::Failed {
                error,
                deferred: false,
            };
            let path = match plugin_path(path) {
                Ok(path) => path,
                Err(error) => return failed(error),
            };
            match session.storage.stat(&path) {
                Ok(stat) if stat.size > budget => {
                    return PluginReadItem::Failed {
                        error: "Batch byte budget exhausted".into(),
                        deferred: true,
                    };
                }
                Ok(_) => (),
                Err(error) => return failed(error.to_string()),
            }
            match plugin_read_bytes(session, &path) {
                Ok((bytes, stat)) => {
                    budget = budget.saturating_sub(bytes.len() as u64);
                    PluginReadItem::Read(PluginRead {
                        data: STANDARD.encode(&bytes),
                        version: version(&bytes),
                        stat: stat.into(),
                    })
                }
                Err(error) => failed(error),
            }
        })
        .collect())
}

/// Reads several files in one IPC round-trip; each entry succeeds or fails on its own.
#[tauri::command]
async fn plugin_vault_read_many(
    vault_id: String,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<PluginReadItem>> {
    let session = lock_session(&state, &vault_id)?;
    read_many(&session, &paths)
}

#[tauri::command]
async fn plugin_vault_create(
    vault_id: String,
    path: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<PluginWrite> {
    let path = plugin_path(&path)?;
    let bytes = decode_plugin_data(&data)?;
    let session = lock_session(&state, &vault_id)?;
    session
        .storage
        .create_binary(&path, &bytes)
        .map_err(error)?;
    Ok(PluginWrite {
        version: version(&bytes),
        stat: session.storage.stat(&path).map_err(error)?.into(),
    })
}

#[tauri::command]
async fn plugin_vault_write(
    vault_id: String,
    path: String,
    data: String,
    expected_version: String,
    state: State<'_, AppState>,
) -> Result<PluginWrite> {
    let path = plugin_path(&path)?;
    let bytes = decode_plugin_data(&data)?;
    let session = lock_session(&state, &vault_id)?;
    write_plugin_bytes(&session, &path, &bytes, &expected_version)
}

#[tauri::command]
async fn plugin_vault_delete(
    vault_id: String,
    path: String,
    expected_version: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let path = plugin_path(&path)?;
    let session = lock_session(&state, &vault_id)?;
    delete_plugin_file(&session, &path, &expected_version)
}

fn delete_plugin_file(session: &Session, path: &VaultPath, expected_version: &str) -> Result<()> {
    check_version_token(expected_version)?;
    let (current, _) = plugin_read_bytes(session, path)?;
    if version(&current) != expected_version {
        return Err("File changed outside this plugin; reload before deleting".into());
    }
    // The backend verifies these exact bytes again, backs them up, and refuses
    // to unlink content it did not observe.
    session.storage.remove_file(path, &current).map_err(error)
}

#[tauri::command]
async fn plugin_vault_mkdir(
    vault_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let path = plugin_path(&path)?;
    if path.as_str().split('/').count() > 64 {
        return Err("Vault nesting exceeds 64 folders".into());
    }
    lock_session(&state, &vault_id)?
        .storage
        .create_folder(&path)
        .map_err(error)
}

/// Plugin HTTP outside the WebView, like Obsidian's `requestUrl` (no CORS).
/// Plugins are trusted code with network access already; this only removes
/// the browser's cross-origin restriction for them.
#[tauri::command]
async fn plugin_request_url(request: request::PluginRequest) -> Result<request::PluginResponse> {
    tauri::async_runtime::spawn_blocking(move || request::perform(request))
        .await
        .map_err(error)?
}

/// Grants read-only resource URLs for an activated plugin's own folder in
/// the current vault session; see `resources.rs` for the exact limits.
#[tauri::command]
async fn plugin_resource_grant(
    vault_id: String,
    plugin_id: String,
    state: State<'_, AppState>,
) -> Result<String> {
    lock_session(&state, &vault_id)?.resources.grant(&plugin_id)
}

#[tauri::command]
async fn plugin_resource_revoke(
    vault_id: String,
    plugin_id: String,
    state: State<'_, AppState>,
) -> Result<()> {
    lock_session(&state, &vault_id)?
        .resources
        .revoke(&plugin_id);
    Ok(())
}

fn serve_resource(
    session: &Session,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    resources::respond(
        request,
        |path| session.resources.resolve(path),
        |path| {
            let path = plugin_path(path)?;
            plugin_read_bytes(session, &path).map(|(bytes, _)| bytes)
        },
    )
}

fn resource_response(
    app: &tauri::AppHandle,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    match app.state::<AppState>().lock() {
        Ok(session) => serve_resource(&session, request),
        Err(_) => tauri::http::Response::builder()
            .status(500)
            .body(Vec::new())
            .expect("static response"),
    }
}

#[tauri::command]
async fn read_note(path: String, vault_id: String, state: State<'_, AppState>) -> Result<String> {
    lock_session(&state, &vault_id)?
        .storage
        .read_text(&VaultPath::parse(&path).map_err(error)?)
        .map_err(error)
}

#[tauri::command]
async fn create_note(
    path: String,
    text: String,
    vault_id: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let path = VaultPath::parse(&path).map_err(error)?;
    if !path.is_document() {
        return Err("Only Markdown notes and canvases can be created".into());
    }
    lock_session(&state, &vault_id)?
        .storage
        .create_text(&path, &text)
        .map_err(error)
}

/// `backup: false` skips the history backup; the frontend asks for that only when the
/// replaced content is its own recent, already backed-up write. Missing means `true`.
#[tauri::command]
async fn save_note(
    path: String,
    text: String,
    expected: String,
    vault_id: String,
    backup: Option<bool>,
    state: State<'_, AppState>,
) -> Result<()> {
    let path = VaultPath::parse(&path).map_err(error)?;
    if !path.is_document() {
        return Err("Only Markdown notes and canvases can be edited".into());
    }
    let session = lock_session(&state, &vault_id)?;
    if backup == Some(false) {
        session.storage.save_text_unbacked(&path, &text, &expected)
    } else {
        session.storage.save_text(&path, &text, &expected)
    }
    .map_err(error)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupInfo {
    /// `version` (content before a save) or `deleted` (content of a deleted file).
    kind: &'static str,
    path: String,
    location: String,
    time: u64,
    size: u64,
}

/// Backups newest first. Unless `all` is set, only those of notes and canvases:
/// the note IPC can neither show nor restore attachments. Cleaning up needs all.
fn document_backups(session: &Session, all: bool) -> Result<Vec<BackupInfo>> {
    Ok(vault_core::list_backups(&*session.storage)
        .map_err(error)?
        .into_iter()
        .filter(|backup| all || backup.original.is_document())
        .map(|backup| BackupInfo {
            kind: match backup.kind {
                BackupKind::Version => "version",
                BackupKind::Deleted => "deleted",
            },
            path: backup.original.as_str().to_owned(),
            location: backup.location.as_str().to_owned(),
            time: backup.time,
            size: backup.size,
        })
        .collect())
}

#[tauri::command]
async fn backup_list(
    vault_id: String,
    all: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<BackupInfo>> {
    let session = lock_session(&state, &vault_id)?;
    document_backups(&session, all.unwrap_or(false))
}

/// Permanently deletes backups (old versions and trash entries) and returns how
/// many were removed. Any location that is not a backup is refused.
#[tauri::command]
async fn backup_remove(
    locations: Vec<String>,
    vault_id: String,
    state: State<'_, AppState>,
) -> Result<usize> {
    let session = lock_session(&state, &vault_id)?;
    let locations = locations
        .iter()
        .map(|location| VaultPath::parse(location).map_err(error))
        .collect::<Result<Vec<_>>>()?;
    for location in &locations {
        vault_core::remove_backup(&*session.storage, location).map_err(error)?;
    }
    Ok(locations.len())
}

#[tauri::command]
async fn backup_read(
    location: String,
    vault_id: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let location = VaultPath::parse(&location).map_err(error)?;
    vault_core::read_backup(&*lock_session(&state, &vault_id)?.storage, &location).map_err(error)
}

#[tauri::command]
async fn choose_vault(
    app: tauri::AppHandle,
    vault_id: String,
    state: State<'_, AppState>,
) -> Result<Option<VaultInfo>> {
    #[cfg(not(target_os = "android"))]
    let root = {
        let Some(path) = app
            .dialog()
            .file()
            .set_title("Markdown-Vault öffnen")
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        SavedRoot::Directory(path.into_path().map_err(error)?)
    };
    #[cfg(target_os = "android")]
    let root = {
        use tauri_plugin_android_fs::AndroidFsExt;
        let api = app.android_fs();
        let Some(uri) = api.picker().pick_dir(None, true).map_err(error)? else {
            return Ok(None);
        };
        api.picker().persist_uri_permission(&uri).map_err(error)?;
        SavedRoot::Android(uri)
    };
    let next = session_for(&app, &root)?;
    let result = info(&next)?;
    let mut session = lock_session(&state, &vault_id)?;
    let config = root_file(&app)?;
    std::fs::create_dir_all(config.parent().ok_or("Missing app config directory")?)
        .map_err(error)?;
    std::fs::write(config, serde_json::to_vec(&root).map_err(error)?).map_err(error)?;
    *session = next;
    Ok(Some(result))
}

#[tauri::command]
async fn export_note(app: tauri::AppHandle, name: String, text: String) -> Result<bool> {
    let name = name.rsplit('/').next().unwrap_or("Notiz.md");
    let (label, extensions): (&str, &[&str]) = if name.to_lowercase().ends_with(".html") {
        ("HTML", &["html", "htm"])
    } else {
        ("Markdown", &["md"])
    };
    let Some(path) = app
        .dialog()
        .file()
        .set_file_name(name)
        .add_filter(label, extensions)
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let mut options = tauri_plugin_fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    let mut file = app.fs().open(path, options).map_err(error)?;
    use std::io::Write;
    file.write_all(text.as_bytes()).map_err(error)?;
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_fs::builder().build());
    builder
        .register_asynchronous_uri_scheme_protocol(resources::SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(resource_response(&app, &request));
            });
        })
        .setup(|app| {
            let config = root_file(app.handle()).map_err(std::io::Error::other)?;
            let saved = std::fs::read(config)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<SavedRoot>(&bytes).ok());
            let restored = saved
                .as_ref()
                .and_then(|root| session_for(app.handle(), root).ok());
            let session = match restored {
                Some(session) => session,
                None => {
                    let root = app.path().app_data_dir()?.join("Mein Vault");
                    std::fs::create_dir_all(&root)?;
                    let vault = DirectoryVault::open(&root)?;
                    for (name, text) in [
                        (
                            "Willkommen.md",
                            include_str!("../../examples/demo-vault/Willkommen.md"),
                        ),
                        (
                            "Plugins.md",
                            include_str!("../../examples/demo-vault/Plugins.md"),
                        ),
                        (
                            "Ideenboard.canvas",
                            include_str!("../../examples/demo-vault/Ideenboard.canvas"),
                        ),
                    ] {
                        match vault.create_text(&VaultPath::parse(name)?, text) {
                            Ok(()) => (),
                            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
                            Err(e) => return Err(e.into()),
                        }
                    }
                    Session {
                        id: root.to_string_lossy().into_owned(),
                        name: "Mein Vault".into(),
                        storage: Box::new(vault),
                        resources: Default::default(),
                    }
                }
            };
            app.manage(Mutex::new(session));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_info,
            read_note,
            create_note,
            save_note,
            choose_vault,
            export_note,
            backup_list,
            backup_read,
            backup_remove,
            plugin_vault_snapshot,
            plugin_vault_read,
            plugin_vault_read_many,
            plugin_vault_create,
            plugin_vault_write,
            plugin_vault_delete,
            plugin_vault_mkdir,
            plugin_request_url,
            plugin_resource_grant,
            plugin_resource_revoke
        ])
        .run(tauri::generate_context!())
        .expect("Basalt could not start");
}

#[cfg(test)]
mod tests {
    #[test]
    fn provider_paths_ignore_the_leading_separator_only() {
        use super::provider_kept_path;
        use std::path::Path;
        assert!(provider_kept_path(Path::new("/data.json"), "data.json"));
        assert!(provider_kept_path(Path::new("data.json"), "data.json"));
        assert!(provider_kept_path(
            Path::new("/.basalt/history/a.md/1-0.md"),
            ".basalt/history/a.md/1-0.md"
        ));
        assert!(!provider_kept_path(
            Path::new("/data (1).json"),
            "data.json"
        ));
        assert!(!provider_kept_path(
            Path::new("/data.json.txt"),
            "data.json"
        ));
    }

    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "basalt-plugin-test-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn session(&self) -> Session {
            Session {
                storage: Box::new(DirectoryVault::open(&self.0).unwrap()),
                id: "selected-vault".into(),
                name: "test".into(),
                resources: Default::default(),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // Only this test's uniquely-created temporary directory.
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn plugin_paths_exclude_secrets_and_escaping_paths() {
        for value in [
            "",
            "../escape",
            "/root/file",
            "a/../file",
            "a\\file",
            ".obsidian/config.json",
            "notes/.secret",
            "a//b",
        ] {
            assert!(plugin_path(value).is_err(), "accepted {value}");
        }
        assert!(plugin_path("notes/drawing.ink").is_ok());
        assert!(plugin_path(&format!("{}file.xlsx", "d/".repeat(64))).is_ok());
        assert!(plugin_path(&format!("{}file.xlsx", "d/".repeat(65))).is_err());
    }

    #[test]
    fn plugin_encoding_and_limits_are_explicit() {
        assert_eq!(decode_plugin_data("AP+A").unwrap(), [0, 255, 128]);
        assert!(decode_plugin_data("not base64!").is_err());
        assert!(decode_plugin_data("").unwrap().is_empty());
        assert!(check_plugin_size(MAX_PLUGIN_BYTES as u64).is_ok());
        assert!(check_plugin_size(MAX_PLUGIN_BYTES as u64 + 1).is_err());
        assert_eq!(
            version(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn batch_reads_report_each_file_and_respect_the_limits() {
        let fixture = Fixture::new();
        let session = fixture.session();
        let path = plugin_path("note.md").unwrap();
        session.storage.create_binary(&path, b"# Hi").unwrap();
        let items = read_many(
            &session,
            &["note.md".into(), "missing.md".into(), ".hidden/x.md".into()],
        )
        .unwrap();
        match &items[0] {
            PluginReadItem::Read(read) => {
                assert_eq!(read.data, STANDARD.encode(b"# Hi"));
                assert_eq!(read.version, version(b"# Hi"));
            }
            PluginReadItem::Failed { .. } => panic!("existing file must be read"),
        }
        for item in &items[1..] {
            assert!(matches!(
                item,
                PluginReadItem::Failed {
                    deferred: false,
                    ..
                }
            ));
        }
        let too_many = vec!["note.md".to_owned(); MAX_BATCH_FILES + 1];
        assert!(read_many(&session, &too_many).is_err());
    }

    #[test]
    fn plugin_write_uses_versions_and_preserves_conflicting_changes() {
        let fixture = Fixture::new();
        let session = fixture.session();
        let path = plugin_path("drawing.ink").unwrap();
        session.storage.create_binary(&path, &[0, 255]).unwrap();
        let previous = version(&[0, 255]);
        let result = write_plugin_bytes(&session, &path, &[128, 1, 0], &previous).unwrap();
        assert_eq!(result.version, version(&[128, 1, 0]));
        assert_eq!(result.stat.size, 3);
        assert!(write_plugin_bytes(&session, &path, b"overwrite", &previous).is_err());
        assert!(write_plugin_bytes(&session, &path, b"overwrite", "invalid").is_err());
        assert_eq!(session.storage.read_binary(&path).unwrap(), [128, 1, 0]);
        let backup = std::fs::read_dir(fixture.0.join(".basalt/history/drawing.ink"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(std::fs::read(backup).unwrap(), [0, 255]);
    }

    #[test]
    fn plugin_delete_requires_exact_version_and_preserves_backup() {
        let fixture = Fixture::new();
        let session = fixture.session();
        let path = plugin_path("drawing.ink").unwrap();
        let content = [0, 255, 1];
        session.storage.create_binary(&path, &content).unwrap();
        assert!(delete_plugin_file(&session, &path, "invalid").is_err());
        assert!(delete_plugin_file(&session, &path, &version(b"other")).is_err());
        assert_eq!(session.storage.read_binary(&path).unwrap(), content);
        assert!(!fixture.0.join(".basalt").exists());
        delete_plugin_file(&session, &path, &version(&content)).unwrap();
        assert!(!fixture.0.join("drawing.ink").exists());
        let trash = std::fs::read_dir(fixture.0.join(".basalt/trash"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
            .join("drawing.ink");
        assert_eq!(std::fs::read(trash).unwrap(), content);
    }

    #[test]
    fn backup_listing_covers_documents_only() {
        let fixture = Fixture::new();
        let session = fixture.session();
        let note = VaultPath::parse("note.md").unwrap();
        session.storage.create_text(&note, "old").unwrap();
        session.storage.save_text(&note, "new", "old").unwrap();
        let drawing = plugin_path("drawing.ink").unwrap();
        session.storage.create_binary(&drawing, &[1]).unwrap();
        session.storage.save_binary(&drawing, &[2], &[1]).unwrap();
        session.storage.remove_file(&note, b"new").unwrap();

        let backups = document_backups(&session, false).unwrap();
        assert_eq!(backups.len(), 2);
        assert!(backups.iter().all(|backup| backup.path == "note.md"));
        let deleted = backups.iter().find(|b| b.kind == "deleted").unwrap();
        let version = backups.iter().find(|b| b.kind == "version").unwrap();
        let read = |location: &str| {
            vault_core::read_backup(&*session.storage, &VaultPath::parse(location).unwrap())
        };
        assert_eq!(read(&deleted.location).unwrap(), "new");
        assert_eq!(read(&version.location).unwrap(), "old");
        assert!(read("drawing.ink").is_err());

        // Cleaning up sees the attachment's backup too.
        let all = document_backups(&session, true).unwrap();
        assert_eq!(all.len(), 3);
        assert!(all.iter().any(|backup| backup.path == "drawing.ink"));
    }

    #[test]
    fn resource_urls_read_only_granted_plugin_files_in_this_vault() {
        let fixture = Fixture::new();
        std::fs::create_dir_all(fixture.0.join("Basalt/Plugins/ink/models/tesseract")).unwrap();
        let mut session = fixture.session();
        let lang = plugin_path("Basalt/Plugins/ink/models/tesseract/deu.traineddata.gz").unwrap();
        session.storage.create_binary(&lang, &[31, 139, 8]).unwrap();
        session
            .storage
            .create_text(&VaultPath::parse("Geheim.md").unwrap(), "secret")
            .unwrap();
        let base = session.resources.grant("ink").unwrap();
        let get = |url: String| {
            tauri::http::Request::get(url)
                .header("Origin", "tauri://localhost")
                .body(Vec::new())
                .unwrap()
        };
        let ok = serve_resource(
            &session,
            &get(format!("{base}models/tesseract/deu.traineddata.gz")),
        );
        assert_eq!(ok.status(), 200);
        assert_eq!(ok.body(), &[31, 139, 8]);
        for rest in [
            "../../Geheim.md",
            "..%2F..%2FGeheim.md",
            "models/tesseract",
            "missing",
        ] {
            let response = serve_resource(&session, &get(format!("{base}{rest}")));
            assert_eq!(response.status(), 404, "{rest}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                fixture.0.join("Geheim.md"),
                fixture.0.join("Basalt/Plugins/ink/link.md"),
            )
            .unwrap();
            let response = serve_resource(&session, &get(format!("{base}link.md")));
            assert_eq!(response.status(), 404);
        }
        // A new vault session starts without grants, so old URLs stop working.
        let next = fixture.session();
        let stale = serve_resource(
            &next,
            &get(format!("{base}models/tesseract/deu.traineddata.gz")),
        );
        assert_eq!(stale.status(), 404);
    }

    #[test]
    fn stale_vault_ids_never_acquire_the_session() {
        let fixture = Fixture::new();
        let state = Mutex::new(fixture.session());
        assert!(lock_session(&state, "previous-vault").is_err());
        assert!(lock_session(&state, "selected-vault").is_ok());
        state.lock().unwrap().id = "replacement-vault".into();
        assert!(lock_session(&state, "selected-vault").is_err());
    }
}
