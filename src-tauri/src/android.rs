//! Storage Access Framework: user-picked document trees, with persisted permissions.
//! Providers do not guarantee atomic replacement. Previous contents are backed up before writes.

use super::saf_cache::{self, DocCache, SafEntry, SafProvider};
use super::{Result, Session, error, provider_kept_path};
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri_plugin_android_fs::{AndroidFsExt, Entry, FsUri};
use vault_core::{
    BinaryVaultStorage, EntryKind, FileEntry, FileStats, HISTORY_DIR, MetadataVaultStorage,
    TRASH_DIR, VaultPath, VaultStorage, timestamp_millis,
};

static NEXT_BACKUP: AtomicU64 = AtomicU64::new(0);

struct AndroidVault {
    app: tauri::AppHandle,
    root: FsUri,
    /// Document URIs from recent listings, so reads do not list their folder again.
    docs: Mutex<DocCache<FsUri>>,
}

impl SafEntry for Entry {
    type Uri = FsUri;
    fn name(&self) -> &str {
        Entry::name(self)
    }
    fn uri(&self) -> &FsUri {
        Entry::uri(self)
    }
    fn is_file(&self) -> bool {
        Entry::is_file(self)
    }
    fn is_dir(&self) -> bool {
        Entry::is_dir(self)
    }
    fn size(&self) -> u64 {
        self.file_len().unwrap_or(0)
    }
}

impl SafProvider for AndroidVault {
    type Entry = Entry;

    fn resolve_dir(&self, path: &str) -> io::Result<FsUri> {
        if path.is_empty() {
            return Ok(self.root.clone());
        }
        self.app
            .android_fs()
            .resolve_dir_uri(&self.root, path)
            .map_err(io_error)
    }

    fn list(&self, dir: &FsUri) -> io::Result<Vec<Entry>> {
        self.app.android_fs().read_dir(dir).map_err(io_error)
    }

    fn metadata(&self, uri: &FsUri) -> io::Result<Entry> {
        self.app.android_fs().get_metadata(uri).map_err(io_error)
    }
}

pub(super) fn session_for(app: &tauri::AppHandle, uri: &FsUri) -> Result<Session> {
    let api = app.android_fs();
    let name = api.get_name(uri).map_err(error)?;
    api.read_dir(uri).map_err(error)?;
    Ok(Session {
        id: serde_json::to_string(uri).map_err(error)?,
        name,
        resources: Default::default(),
        storage: Box::new(AndroidVault {
            app: app.clone(),
            root: uri.clone(),
            docs: Mutex::default(),
        }),
    })
}

fn io_error(e: impl std::fmt::Display) -> io::Error {
    io::Error::other(e.to_string())
}

fn entry_stats(entry: &Entry) -> FileStats {
    // SAF exposes no creation time: use last-modified consistently for both timestamps.
    let modified = timestamp_millis(entry.last_modified());
    FileStats {
        ctime: modified,
        mtime: modified,
        size: entry.file_len().unwrap_or(0),
    }
}

impl AndroidVault {
    fn docs(&self) -> MutexGuard<'_, DocCache<FsUri>> {
        // The cache holds no invariant a panic could break; recover it instead of failing reads.
        self.docs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn parent<'a>(&self, path: &'a VaultPath) -> io::Result<(FsUri, &'a str)> {
        let (dir, name) = saf_cache::split(path.as_str());
        Ok((self.resolve_dir(dir)?, name))
    }

    /// Read-only lookup: served from cached document URIs, with fresh stats.
    fn entry(&self, path: &VaultPath) -> io::Result<Entry> {
        saf_cache::lookup(self, &mut self.docs(), path.as_str(), Instant::now())
    }

    /// Lookup for writes and their safety checks: always resolves and lists the parent again.
    fn entry_uncached(&self, path: &VaultPath) -> io::Result<Entry> {
        let (dir, name) = saf_cache::split(path.as_str());
        let entries = saf_cache::list_fresh(self, &mut self.docs(), dir, Instant::now())?;
        saf_cache::pick(entries, name)
    }

    /// Drop the cached listing of `path`'s folder after this app changed its children.
    fn forget_parent(&self, path: &VaultPath) {
        self.docs().forget(saf_cache::split(path.as_str()).0);
    }

    fn read_file(&self, entry: &Entry) -> io::Result<Vec<u8>> {
        if !entry.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path is not a file",
            ));
        }
        self.app.android_fs().read(entry.uri()).map_err(io_error)
    }

    fn vacant_parent<'a>(&self, path: &'a VaultPath) -> io::Result<(FsUri, &'a str)> {
        let (parent, name) = self.parent(path)?;
        if self.list(&parent)?.iter().any(|entry| entry.name() == name) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "vault entry already exists",
            ));
        }
        Ok((parent, name))
    }

    fn create_bytes(&self, path: &VaultPath, data: &[u8], mime: Option<&str>) -> io::Result<()> {
        let (parent, name) = self.vacant_parent(path)?;
        self.forget_parent(path);
        // Resolve the parent first: SAF's create API otherwise creates missing parents.
        let api = self.app.android_fs();
        let (uri, actual) = api
            .create_new_file_and_return_relative_path(&parent, name, mime)
            .map_err(io_error)?;
        if !provider_kept_path(&actual, name) {
            return Err(io::Error::other(format!(
                "Provider changed the filename to {}; refresh the vault",
                actual.display()
            )));
        }
        api.write(&uri, data).map_err(io_error)
    }

    fn save_bytes(
        &self,
        path: &VaultPath,
        data: &[u8],
        expected: &[u8],
        text: bool,
    ) -> io::Result<()> {
        let current = self.read_file(&self.entry_uncached(path)?)?;
        if text {
            std::str::from_utf8(&current)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        }
        if current != expected {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "file changed outside this editor; reload before saving",
            ));
        }
        if current == data {
            return Ok(());
        }
        let api = self.app.android_fs();
        let id = format!(
            "{}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(io_error)?
                .as_nanos(),
            NEXT_BACKUP.fetch_add(1, Ordering::Relaxed)
        );
        let extension = if text { "md" } else { "bin" };
        let backup = format!(".basalt/history/{}/{id}.{extension}", path.as_str());
        let (uri, actual) = api
            .create_new_file_and_return_relative_path(&self.root, &backup, None)
            .map_err(io_error)?;
        if !provider_kept_path(&actual, &backup) {
            return Err(io::Error::other(
                "Provider changed the backup path; original file left untouched",
            ));
        }
        api.write(&uri, &current).map_err(io_error)?;
        let target = self.entry_uncached(path)?;
        if !target.is_file() || api.read(target.uri()).map_err(io_error)? != expected {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "file changed while saving; reload before saving",
            ));
        }
        // SAF providers do not offer atomic compare-and-replace. A backup exists, but an
        // uncooperative writer can still race this final provider write (or it can fail partially).
        api.write(target.uri(), data).map_err(io_error)
    }

    fn collect_entries(
        &self,
        uri: &FsUri,
        prefix: &str,
        entries: &mut Vec<FileEntry>,
        depth: usize,
    ) -> io::Result<()> {
        if depth > 64 {
            return Err(io::Error::other("Vault folder nesting exceeds 64 levels"));
        }
        let listing = self.list(uri)?;
        self.docs()
            .record(prefix.trim_end_matches('/'), &listing, Instant::now());
        for entry in listing {
            let name = entry.name();
            if name.starts_with('.') {
                continue;
            }
            VaultPath::parse(name)?;
            if name.contains('/') {
                return Err(io::Error::other("Provider returned an invalid child name"));
            }
            let path = VaultPath::parse(&format!("{prefix}{name}"))?;
            let kind = if entry.is_file() {
                EntryKind::File
            } else if entry.is_dir() {
                EntryKind::Folder
            } else {
                continue;
            };
            entries.push(FileEntry {
                path,
                kind,
                stat: entry_stats(&entry),
            });
            if entry.is_dir() {
                self.collect_entries(entry.uri(), &format!("{prefix}{name}/"), entries, depth + 1)?;
            }
        }
        Ok(())
    }

    fn collect(
        &self,
        uri: &FsUri,
        prefix: &str,
        files: &mut Vec<VaultPath>,
        depth: usize,
    ) -> io::Result<()> {
        if depth > 64 {
            return Err(io::Error::other("Vault folder nesting exceeds 64 levels"));
        }
        let listing = self.list(uri)?;
        self.docs()
            .record(prefix.trim_end_matches('/'), &listing, Instant::now());
        for entry in listing {
            match entry {
                Entry::File { name, .. } if !name.starts_with('.') => {
                    let path = VaultPath::parse(&format!("{prefix}{name}"))?;
                    if path.is_document() {
                        files.push(path);
                    }
                }
                Entry::Dir { uri, name, .. } if !name.starts_with('.') => {
                    VaultPath::parse(&name)?;
                    self.collect(&uri, &format!("{prefix}{name}/"), files, depth + 1)?;
                }
                _ => (),
            }
        }
        Ok(())
    }
}

impl VaultStorage for AndroidVault {
    fn document_files(&self) -> io::Result<Vec<VaultPath>> {
        let mut files = Vec::new();
        self.collect(&self.root, "", &mut files, 0)?;
        files.sort();
        Ok(files)
    }

    fn read_text(&self, path: &VaultPath) -> io::Result<String> {
        String::from_utf8(self.read_binary(path)?)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    fn create_text(&self, path: &VaultPath, text: &str) -> io::Result<()> {
        // A JSON type would let some providers append ".json" to the name.
        let mime = path.is_markdown().then_some("text/markdown");
        self.create_bytes(path, text.as_bytes(), mime)
    }

    fn save_text(&self, path: &VaultPath, text: &str, expected: &str) -> io::Result<()> {
        self.save_bytes(path, text.as_bytes(), expected.as_bytes(), true)
    }
}

impl BinaryVaultStorage for AndroidVault {
    fn read_binary(&self, path: &VaultPath) -> io::Result<Vec<u8>> {
        self.read_file(&self.entry(path)?)
    }

    fn create_binary(&self, path: &VaultPath, data: &[u8]) -> io::Result<()> {
        self.create_bytes(path, data, None)
    }

    fn save_binary(&self, path: &VaultPath, data: &[u8], expected: &[u8]) -> io::Result<()> {
        self.save_bytes(path, data, expected, false)
    }
}

impl MetadataVaultStorage for AndroidVault {
    fn snapshot(&self) -> io::Result<Vec<FileEntry>> {
        let mut entries = Vec::new();
        self.collect_entries(&self.root, "", &mut entries, 0)?;
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }

    fn stat(&self, path: &VaultPath) -> io::Result<FileStats> {
        Ok(entry_stats(&self.entry(path)?))
    }

    fn create_folder(&self, path: &VaultPath) -> io::Result<()> {
        let (parent, name) = self.vacant_parent(path)?;
        self.forget_parent(path);
        let (_, actual) = self
            .app
            .android_fs()
            .create_new_dir_and_return_relative_path(&parent, name)
            .map_err(io_error)?;
        if !provider_kept_path(&actual, name) {
            return Err(io::Error::other(format!(
                "Provider changed the folder name to {}; refresh the vault",
                actual.display()
            )));
        }
        Ok(())
    }

    fn remove_file(&self, path: &VaultPath, expected: &[u8]) -> io::Result<()> {
        let entry = self.entry_uncached(path)?;
        if !entry.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "only files can be removed",
            ));
        }
        let api = self.app.android_fs();
        let current = api.read(entry.uri()).map_err(io_error)?;
        // Verify before any backup exists: a rejected delete must leave the vault
        // untouched, including no trash entry for the bytes it refused.
        if current != expected {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "file changed outside this app; reload before deleting",
            ));
        }
        let id = format!(
            "{}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(io_error)?
                .as_nanos(),
            NEXT_BACKUP.fetch_add(1, Ordering::Relaxed)
        );
        let backup = format!(".basalt/trash/{id}/{}", path.as_str());
        let (uri, actual) = api
            .create_new_file_and_return_relative_path(&self.root, &backup, None)
            .map_err(io_error)?;
        if !provider_kept_path(&actual, &backup) {
            return Err(io::Error::other(
                "Provider changed the backup path; original file left untouched",
            ));
        }
        api.write(&uri, &current).map_err(io_error)?;
        // The backup holds exactly the bytes observed above. Providers can still
        // replace or recreate the entry between this check and the removal; that
        // gap is narrowed, not eliminated (SAF has no compare-and-delete).
        let target = self.entry_uncached(path)?;
        self.forget_parent(path);
        if !target.is_file() || target.uri() != entry.uri() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "file changed while deleting; original file left untouched",
            ));
        }
        if api.read(target.uri()).map_err(io_error)? != current {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "file changed while deleting; original file left untouched",
            ));
        }
        api.remove_file(target.uri()).map_err(io_error)
    }

    fn backup_files(&self) -> io::Result<Vec<(VaultPath, u64)>> {
        Ok(saf_cache::backup_files(self, &[HISTORY_DIR, TRASH_DIR])?
            .into_iter()
            .filter_map(|(path, size)| Some((VaultPath::parse(&path).ok()?, size)))
            .collect())
    }
}
