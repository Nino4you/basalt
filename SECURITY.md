# Data and security boundaries

Basalt is a development preview. Try it on copies of your vaults first.

## Reporting a vulnerability

Please do **not** report security issues as public issues. Report them privately through
["Report a vulnerability"](https://github.com/Nino4you/basalt/security/advisories/new) in this
repository's Security tab. Describe the affected version and how to reproduce the problem. You
will get a response once the report has been reviewed.

## Boundaries

- The Rust core uses `cap-std` instead of joined absolute file paths. Only an explicit vault
  selection opens a new file system root.
- Existing notes are never overwritten when creating a note. Saving checks the previously
  loaded version and first writes a copy to `.basalt/history/`. One exception keeps the history
  readable: while someone keeps typing, the app's own autosaved content is backed up at most
  every five minutes per note (`NoteStore`, `save_note` with `backup: false`). Content the app
  did not write itself in this session, such as the version loaded from disk or an external
  change, is always backed up before it is replaced, and so is everything a restore or a link
  update replaces. Android (SAF) still backs up every save.
- Backups are deleted permanently only by the retention setting (once a day, only when the user
  sets a retention period; off by default) or by "Empty trash" after a confirmation. The `backup_remove`
  command (`vault_core::remove_backup`) accepts backup locations only, refuses symlinked
  folders below `.basalt` and never touches vault content.
- On Linux, a save first writes a separate file and replaces the target by rename.
  Uncoordinated external writers can still write between the check and the rename: there is no
  compare-and-swap that is guaranteed across file systems.
- Android SAF providers do not guarantee an atomic replace. There, Basalt backs up before
  writing and checks for conflicts again. An interrupted provider write can damage the current
  file; the previous backup can then be restored with File recovery.
- Reads on Android remember for up to 10 seconds which SAF document belongs to which path, so
  that not every read lists the whole folder again. Size, modification time and content are
  still queried fresh every time, and the name is cross-checked. With providers that use opaque
  document IDs, a file moved to another folder externally may still be read under its old path
  within that window. Writes, deletions and their conflict checks never use the cache.
- New files can be incomplete after a write error. Errors are passed on.
- Drafts and the browser demo live in local WebView/browser storage, unencrypted. A draft keeps
  its original version base, so restoring it cannot silently overwrite external changes. A full
  or locked storage medium remains an error case.
- Markdown is sanitized with DOMPurify before display. The native CSP blocks remote resources,
  scripts, frames and object embeds; external links are never opened automatically. An
  `obsidian://` link is only handed to the handler an enabled plugin registered for its action,
  never to the system. The preview
  additionally strips remote image sources, also in the browser demo.
- Plugin loader: bundles from `Basalt/Plugins/<id>` only run after explicit activation. There
  is **no sandbox**: plugin code has the same frontend permissions as the app, including the
  DOM, WebView storage, network and the exposed Tauri commands. Only enable trusted bundles.
- `'unsafe-eval'` in the CSP is needed solely for the CommonJS loader. `connect-src` allows
  HTTPS/WSS because sync plugins and plugin resources need network access. `data:` allows
  reading already embedded font bytes during Excalidraw SVG export, not additional network
  targets or script sources. External fonts stay blocked. `worker-src 'self' blob:` allows
  workers from blob URLs that plugins create themselves (for example for OCR). `script-src blob:`
  allows scripts from blob URLs that plugin code creates from its own bytes (for example
  tesseract.js and its Wasm core). This grants no additional rights: only page code that is
  already running can create a blob URL, and because of `'unsafe-eval'` it may run arbitrary
  code anyway. Injected markup cannot create blob URLs; remote scripts stay blocked. There is
  still no generic `window.require('fs')` shim.
- In the native app, `requestUrl` runs outside the WebView like in Obsidian, through the Rust
  command `plugin_request_url`, and is therefore not subject to CORS. Only `http`/`https` are
  allowed, request and response bodies are capped at 64 MiB, and TLS certificates are verified
  against the bundled webpki roots. Plugins already had network access; only the browser's
  cross-origin restriction goes away.
- The update check is off by default. Turned on (or with "Check now" in Settings → General) it
  makes one request at most once a day: the desktop app reads `latest.json` from the latest
  GitHub release, Android and the demo ask `api.github.com/repos/Nino4you/basalt/releases/latest`.
  Nothing is downloaded or installed until the user presses "Install and restart" (desktop) or
  "Install" (Android).
  The desktop app then accepts only a package whose minisign signature matches the public key in
  `src-tauri/tauri.conf.json` and was made for the announced version, so a tampered manifest
  cannot install foreign code or downgrade to an older release. The updater key exists only as a
  GitHub secret and in the maintainer's offline backup.
- On Android the activity (patched in by `tools/patch_android.mjs`) downloads only from
  `https://github.com/Nino4you/basalt/releases/download/` (HTTPS redirects only, 256 MiB cap)
  and accepts the APK only if its package name is Basalt's, its version name is exactly the
  announced version and its signing certificate is one of the installed app's certificates. It
  then hands the APK to the system `PackageInstaller`, which asks the user to confirm and
  enforces the same signature and no downgrade again. The install result arrives through a
  package-bound broadcast that also carries a per-process random token, so other apps cannot
  inject installer confirmations. Builds with `BASALT_ANDROID_STORE=1` (Google Play) leave out
  the installer and the `REQUEST_INSTALL_PACKAGES` permission.
- Content shared to Basalt from other Android apps ("Share" → Basalt) is read by the activity
  only from `content://` URIs of other apps (no `file://`, nothing from Basalt's own providers),
  at most 20 files and 32 MiB per share. Nothing is written until the user picks "Save as new
  note" or "Append"; files go through the normal exclusive attachment import, with names reduced
  to a plain file name.
- The plugin catalog (Settings → Community plugins) downloads the community plugin list and
  download counts from `raw.githubusercontent.com/obsidianmd/obsidian-releases`, and plugin
  releases from `github.com/<owner>/<repo>/releases/latest/download/`, through the same
  `requestUrl` path (Rust in the app, `fetch` in the browser demo). Nothing is downloaded until
  the settings page is used, and nothing updates automatically. Basalt does not verify release
  signatures or review plugin code: the catalog marks the few plugins checked with Basalt and
  calls the rest untested. The "Checked" mark applies only to the catalog's own repository and to
  the exact version that was checked: a fork or any other repository whose manifest reuses a
  checked plugin's id, and every other release, count as untested. Before writing anything, the
  app validates the manifest (for catalog installs and updates, also that its id matches the
  expected one) and the loader's size limits, and asks for confirmation with a
  warning that plugins are not sandboxed. Installing writes only into `Basalt/Plugins/<id>/`
  through the plugin config view, with the usual version checks and backups, and never enables
  the plugin. `basalt-source.json` there records the repository for update checks. Uninstalling
  deletes the plugin's files (backed up to `.basalt/trash/`); the empty folder stays.
- Themes (`Basalt/Config/themes/<name>/theme.css`) and CSS snippets (`Basalt/Config/snippets/`)
  load only when chosen in the settings (stored in `Basalt/Config/appearance.json`, like
  Obsidian). They are plain `<style>` elements: CSS runs no code, and the CSP above still limits
  what `url()` can load (no remote images or fonts). A theme can still make text unreadable;
  choosing "Basalt (default)" removes it.
- Plugin paths under `.obsidian/plugins/<id>` map to `Basalt/Plugins/<id>`. Like `.obsidian` in
  Obsidian, `Basalt/Plugins` is not vault content for plugins: it is missing from `getFiles()`
  and vault events and is reachable only through the adapter and the loader. This keeps sync
  plugins from uploading installed plugin code as attachments.
- `app.loadLocalStorage`/`saveLocalStorage` are separated per vault, so sign-ins (for example
  sync tokens) are not carried over into another vault. `loadData`/`saveData`, on the other
  hand, live in the vault as `Basalt/Plugins/<id>/data.json`, like in Obsidian: whatever a
  plugin stores there sits in plain text next to the notes and is copied and backed up with
  them. All other paths under `.obsidian/` (for example Iconize's icon packs in
  `.obsidian/icons`) land in `Basalt/Config/`, which, like `Basalt/Plugins`, is not vault
  content and is reachable only through the adapter. Other hidden paths (`.basalt/`, hidden
  subfolders) stay blocked; `..` and `.` segments are still rejected, while duplicate, leading
  and trailing slashes are ignored as in Obsidian's `normalizePath`.
- Resource URLs (`adapter.getResourcePath`) exist only for a plugin's own folder and only as
  narrowly as, for example, a Tesseract OCR engine needs them (language data via `langPath` in
  a worker):
  - The native `basalt-resource:` protocol serves only files under `Basalt/Plugins/<id>/` of a
    plugin that is activated in the current vault session. On activation the plugin receives a
    random 256-bit grant in the URL; deactivation revokes it, and switching vaults discards all
    grants. Other plugin folders, notes, attachments and the app data folder have no resource
    URLs.
  - Only `GET`/`HEAD`, no folder listings, no hidden paths. Reads go through the same storage
    path as `plugin_vault_read` (`VaultPath`, `cap-std` or SAF, no symlink escape, 64 MiB).
    Unknown grants, invalid paths and missing files all return 404.
  - Responses are always `application/octet-stream` with `nosniff` and their own `sandbox` CSP.
    The WebView CSP names the protocol only in `connect-src`, not in `script-src`, `img-src`,
    `frame-src` or `worker-src`: the URLs can only be read with `fetch`, never loaded as a
    script, image or frame. CORS is allowed only for Basalt's own origin (`tauri://localhost`,
    on Android `http://tauri.localhost`).
  - Plugin code is not sandboxed and could already read the same bytes through the adapter; the
    URL only adds a second, equally limited read path that workers can use too. There is still
    no broad asset exposure.
- Plugin file deletion checks the observed version, backs the bytes up to `.basalt/trash/`,
  checks again and only then deletes. A race between the last check and the deletion by
  uncoordinated external writers remains possible. Folder deletion is rejected.
- The file menu uses the same native deletion path after confirmation. Loaded and restored note
  drafts are saved first with their original conflict base. Unsaved edits inside a plugin are
  not part of the file backup, so save plugin files first. The browser demo records backup and
  removal together in one local storage operation and hides `.basalt/` from the file list. It is
  not a test of the native file system.
- Renaming is currently not atomic: first an exclusive copy, then a checked deletion of the
  original. If the deletion fails in an unclear way, the target copy is kept for recovery and
  the error is shown. Timestamps and file permissions may change in the process. Case-only
  renames on case-insensitive file systems are not covered.
- After a rename or move in the app, links that pointed to the file are rewritten (setting
  "Automatically update internal links", on by default). Only links whose target would
  otherwise change are touched; each affected note or canvas goes through the normal
  version-checked save, so its previous content is backed up. A file that fails to save keeps
  its content and is named in a notice. The plugin API `FileManager.renameFile` follows the
  same setting and writes each affected file with a version-checked `Vault.process`.
- These plugin file operations are limited to 64 MiB per file. Trash and version backups are
  not cleaned up automatically; they keep using storage and are not secure deletion.
- File recovery lists only backups of notes and canvases (`backup_list`) and reads only such
  backup locations (`backup_read`); other hidden files stay unreadable through it. Restoring a
  version is a normal version-checked save, so the replaced content becomes a backup itself.
  Restoring a deleted file is an exclusive creation, under a new name if the old one is taken.
  Backups of attachments are not listed and still have to be restored by hand.
- No automatic sync, no account and no telemetry.
- Debug-signed Android APKs are test artifacts, not production-signed releases. The fixed
  development key is stored as an Actions secret, not in the git history. Production releases
  are signed through `.github/workflows/release.yml` with a separately managed Android release
  key and an OpenPGP key; both exist only as secrets of the GitHub environment `release` (see
  `docs/release-signing.md`). Releases are created as drafts and published manually.
