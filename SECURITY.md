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
  loaded version and first writes a copy to `.basalt/history/`.
- On Linux, a save first writes a separate file and replaces the target by rename.
  Uncoordinated external writers can still write between the check and the rename: there is no
  compare-and-swap that is guaranteed across file systems.
- Android SAF providers do not guarantee an atomic replace. There, Basalt backs up before
  writing and checks for conflicts again. An interrupted provider write can damage the current
  file; the previous backup then has to be restored.
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
  scripts, frames and object embeds; external links are never opened automatically. The preview
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
  the error is shown. Timestamps and file permissions may change in the process; links are not
  updated automatically yet. Case-only renames on case-insensitive file systems are not covered.
- These plugin file operations are limited to 64 MiB per file. Trash and version backups are
  not cleaned up automatically; they keep using storage and are not secure deletion. Restoring
  is currently manual.
- No automatic sync, no account and no telemetry.
- Debug-signed Android APKs are test artifacts, not production-signed releases. The fixed
  development key is stored as an Actions secret, not in the git history. Production releases
  are signed through `.github/workflows/release.yml` with a separately managed Android release
  key and an OpenPGP key; both exist only as secrets of the GitHub environment `release` (see
  `docs/release-signing.md`). Releases are created as drafts and published manually.
