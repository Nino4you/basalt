//! Self-update of the desktop packages (AppImage, .deb, Windows installer)
//! through `tauri-plugin-updater`.
//!
//! The release workflow publishes `latest.json` and a minisign signature for
//! every package; the updater only installs a download whose signature matches
//! the public key in `tauri.conf.json` and was made for the announced version
//! (`requireSignedVersion`). Nothing is installed without the user asking:
//! the frontend first checks, then calls `app_update_install` on request.
//! Android installs release APKs through the patched activity instead (see
//! `tools/patch_android.mjs` and `installAndroidUpdate` in the frontend).

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, State, ipc::Channel};

/// The update found by the last check, kept until it is installed.
#[derive(Default)]
pub struct PendingUpdate {
    #[cfg(desktop)]
    update: Mutex<Option<tauri_plugin_updater::Update>>,
    #[cfg(mobile)]
    #[allow(dead_code)]
    update: Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(mobile, allow(dead_code))]
pub struct AvailableUpdate {
    version: String,
    notes: String,
    /// False when Basalt runs outside a package the updater can replace
    /// (e.g. a binary built from source); the user then downloads by hand.
    installable: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(mobile, allow(dead_code))]
pub struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// Asks the update endpoint for a newer signed release.
#[tauri::command]
pub async fn app_update_check(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<AvailableUpdate>, String> {
    #[cfg(mobile)]
    {
        let _ = (app, pending);
        Err("Updates are installed through the app store or the APK on this platform".into())
    }
    #[cfg(desktop)]
    {
        use tauri_plugin_updater::UpdaterExt;
        let update = app
            .updater()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?;
        let info = update.as_ref().map(|update| AvailableUpdate {
            version: update.version.clone(),
            notes: update.body.clone().unwrap_or_default(),
            installable: installable(),
        });
        *pending.update.lock().map_err(|e| e.to_string())? = update;
        Ok(info)
    }
}

/// Downloads, verifies and installs the update found by the last check, then
/// restarts Basalt. The frontend saves every open buffer before calling this.
#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    on_progress: Channel<Progress>,
) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = (app, pending, on_progress);
        Err("Updates are installed through the app store or the APK on this platform".into())
    }
    #[cfg(desktop)]
    {
        if !installable() {
            return Err("This copy of Basalt was not installed from a release package".into());
        }
        let update = pending
            .update
            .lock()
            .map_err(|e| e.to_string())?
            .take()
            .ok_or("No update was found to install")?;
        let mut downloaded = 0u64;
        let result = update
            .download_and_install(
                |chunk, total| {
                    downloaded += chunk as u64;
                    // A closed channel only means the window went away.
                    let _ = on_progress.send(Progress { downloaded, total });
                },
                || {},
            )
            .await;
        if let Err(error) = result {
            // Allow another attempt without a new check.
            if let Ok(mut slot) = pending.update.lock() {
                *slot = Some(update);
            }
            return Err(error.to_string());
        }
        // The Windows installer has already ended the process; Linux
        // replaced the AppImage or package and starts the new version here.
        app.restart();
    }
}

/// Whether the running copy came from a package the updater can replace.
#[cfg(desktop)]
fn installable() -> bool {
    use tauri::utils::{config::BundleType, platform::bundle_type};
    matches!(
        bundle_type(),
        Some(BundleType::AppImage | BundleType::Deb | BundleType::Nsis)
    )
}

/// Registers the updater plugin and the pending-update state.
pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder.manage(PendingUpdate::default())
}
