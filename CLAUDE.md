# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Basalt (`basalt-notes`) is a local-first Markdown workspace for **Linux and Android**: a Rust vault
core, a Tauri 2 shell, and a framework-free TypeScript WebView UI built on CodeMirror 6. It is an
independent reimplementation with an Obsidian-compatible plugin layer, not an Obsidian fork.

README, SECURITY.md, `docs/`, identifiers and code comments are **English**. The UI defaults to
**English** with German selectable; the German source strings are the message keys
(`src/i18n/`, see `docs/localization.md`). Existing Playwright and unit suites select German and
locate elements by their German accessible names, so renaming a label means updating its key,
`src/i18n/en.ts` and `tests/e2e/app.spec.ts`.

## Commands

Requires Node.js 22+ and stable Rust (edition 2024).

```sh
npm ci
npm run dev                 # browser demo on 127.0.0.1:1420 (localStorage, no real vault)
npm run build               # tsc --noEmit && vite build — this is the only type check
npm test                    # Vitest (jsdom), tests/unit/**/*.test.ts
npx vitest run tests/unit/store.test.ts          # one file
npx vitest run -t "name of the test"             # one test by name
npm run test:e2e            # Playwright against the browser demo; starts the dev server itself
npx playwright test --project=desktop -g "title" # one e2e test; projects: desktop, android-layout

cargo fmt --all -- --check
cargo test --workspace --locked                  # vault-core + vault-cli only
cargo test -p vault-core --test vault <name>     # one core integration test
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo run -p vault-cli -- list examples/demo-vault
cargo run -p vault-cli -- search examples/demo-vault Android

npm run tauri -- dev        # native Linux app (needs the Tauri system dependencies)
npm run tauri -- build
```

`src-tauri` is **excluded from the root Cargo workspace** and has its own `Cargo.lock`, so
`--workspace` commands never touch it. Address it explicitly:

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --lib --release --locked --features tauri/custom-protocol
```

CI (`.github/workflows/ci.yml`) runs, in order: `npm run build`, `npm test`, `cargo fmt`,
`cargo test`, `cargo clippy -D warnings`, `python3 -m py_compile tools/*.py`, then Playwright.
Separate jobs build the Linux bundles (plus a startup smoke test under xvfb) and a debug-signed
Android APK, which `tools/smoke_android.mjs` then drives in an emulator.

Tests against real third-party plugin bundles (e.g. `tests/e2e/iconize.spec.ts`,
`excalidraw.spec.ts`) are skipped unless `BASALT_PLUGIN_DIRS` is set — bundle directories joined by
the **platform** path delimiter (`;` on Windows, `:` on Unix; see `tests/helpers/plugin-fixtures.ts`).
They never run in CI, so green tests are no proof of real-plugin compatibility.

Coverage traps:

- Playwright needs `npx playwright install chromium` once. Both projects (`desktop`,
  `android-layout`) run the browser demo; a passing mobile-layout test verifies neither SAF nor
  Rust IPC.
- The core symlink-escape tests are `#[cfg(unix)]`; a `cargo test` on Windows skips them.
- `node tools/smoke_android.mjs` needs adb, an emulator and a universal debug APK
  (`BASALT_APK_DIR`); it modifies app data and refuses physical devices.
- `src-tauri/gen/android/` is generated (`npm run tauri -- android init --ci
  --skip-targets-install`, then `node tools/patch_android.mjs`, then `npm run tauri -- icon
  public/basalt.svg`), never committed; CI has the exact Android build order and SDK/NDK versions.
  The patch makes the activity forward system bar and keyboard insets to the page
  (`src/ui/android-insets.ts`); skipping it puts the app under the navigation bar and keyboard.
- Local Android builds on Windows need Developer Mode, because Tauri symlinks the Rust library into
  `jniLibs`.

TypeScript/config files are formatted with Prettier defaults (no config file, no npm script).

### Project page (`site/`)

`site/` is the static landing page for GitHub Pages (plain HTML/CSS/JS, English markup with a
German table in `site/main.js`, no third-party requests). `node tools/build_site.mjs` copies it
to `_site/` and builds the browser demo into `_site/demo/` with relative asset paths;
`.github/workflows/pages.yml` deploys that on pushes to `main` and is skipped while the
repository is private. The page seeds the demo with `site/showcase-vault.js` only when the
visitor has no demo data; the same vault feeds `node tools/site_screenshots.mjs`, which
regenerates `site/assets/shot-*.png` from a running demo. Update the page when features or the
status in the README change.

## Architecture

### Three layers, two storage paths

```
src/ (WebView UI)  ──invoke──▶  src-tauri/src/lib.rs (IPC commands)  ──▶  crates/vault-core (traits)
                                                                           ├─ DirectoryVault (cap-std, Linux)
                                                                           └─ AndroidVault (SAF, src-tauri/src/android.rs)
```

- **`crates/vault-core`** is UI-independent. `VaultPath` is the validated relative path type;
  every path crossing a boundary is parsed through it. Storage is expressed as three traits —
  `VaultStorage` (Markdown text), `BinaryVaultStorage` (raw bytes), `MetadataVaultStorage`
  (entry snapshots, mkdir, delete). `DirectoryVault` implements them on a `cap-std` directory
  handle so nothing can escape the vault root; `crates/vault-core/tests/vault.rs` covers path and
  symlink escapes. Saves are compare-and-swap against the previously loaded content and first
  write a backup to `.basalt/history/`.
- **`src-tauri`** holds one `Mutex<Session>` with a boxed storage backend. Commands that read or
  write vault files take a `vaultId` and are rejected (`lock_session`) if it does not match the
  current session, so stale frontend state
  cannot write into a newly chosen vault. The chosen root is persisted as `vault.json` in the app
  config dir. `android.rs` implements the same traits over the Storage Access Framework and is
  only compiled with `cfg(target_os = "android")`.
- There are three IPC families that the frontend uses for different purposes:
  - `vault_info` / `read_note` / `create_note` / `save_note` / `choose_vault` / `export_note` —
    text notes for the app itself, wrapped by `src/backend.ts`. `backup_list` / `backup_read`
    list and read the `.basalt/history/` and `.basalt/trash/` backups of notes and canvases
    (`vault_core::list_backups` / `read_backup`; layouts parsed in `src/backups.ts` too) for
    the file recovery dialog (`src/app/file-recovery.ts`), which restores through the normal
    version-checked save or an exclusive create — never by overwriting.
  - `plugin_vault_*` — base64 binary access with opaque SHA-256 version tokens (64 MiB cap,
    deletes backed up to `.basalt/trash/`), wrapped by `src/compat/native-port.ts`.
  - `plugin_resource_grant` / `plugin_resource_revoke` — per-plugin tokens for the read-only
    `basalt-resource:` URI scheme behind `adapter.getResourcePath`, held in the `Session` and
    wrapped by `src/compat/plugin-resources.ts`.

### Browser demo vs. native

`src/backend.ts` exports a single `backend` chosen by `isTauri()`: `NativeBackend` (IPC) or
`BrowserBackend` (a localStorage-backed demo vault). `npm run dev` and **all Playwright tests run
against the browser demo**. The plugin compatibility session is only created when `native` is
true, so plugin loading, plugin views and binary storage are not reachable from e2e tests — they
are covered by Vitest with in-memory `VaultStoragePort` implementations instead.

### Frontend (`src/`)

No UI framework: DOM is built with the `h()` / `icon()` helpers in `src/ui/dom.ts`.

- `src/app/app.ts` — the `App` class is the central controller: tabs with per-tab history and
  saved editor state, vault switching, autosave, and wiring of every panel. Tabs live in
  editor groups laid out by a split tree (`split.ts`). There is still exactly **one** live
  editor, reading view, canvas and plugin view: they sit in the focused group
  (`app.tabs` / `app.active` refer to it), and every other group shows a read-only
  `GroupMirror` of its active tab. Drag & drop lives in `dock-drag.ts` (panels) and
  `tab-drag.ts` (editor tabs); both resolve targets from the pointer position. `shell.ts` builds the
  static layout and returns element references; the other files in `src/app/` are individual
  views (explorer, search, side panels, reading view, switcher/command palette, settings).
- `src/store.ts` — `NoteStore` serializes saves and keeps localStorage drafts that remember the
  original conflict base, so recovery cannot silently overwrite external changes.
- `src/app/vault-index.ts` — in-memory link/tag/heading index and the search query parser
  (`tag:`, `path:`, `file:`) behind backlinks, outgoing links, tags and search. `LinkResolver`
  resolves links for any file list; `src/app/link-update.ts` compares resolution before and
  after a rename/move and rewrites only links whose target would change (wiki links, embeds,
  Markdown links, canvas file cards), saved through `NoteStore` like any edit.
- `src/editor.ts` + `src/editor/` — the CodeMirror 6 editor: live preview decorations, syntax,
  completion for `[[wiki links]]` and `#tags`.
  - **Markdown stays authoritative.** `rich-preview.ts` renders KaTeX, Mermaid and tables as
    replacement widgets; math/diagrams reveal their source when the selection enters them.
    `table-widget.ts` makes only the clicked cell editable and dispatches narrow source edits
    (`table-model.ts` maps cells to source ranges), so undo/redo and autosave operate on the
    text. Ambiguous/ragged tables and multiline math in nested quotes deliberately stay as
    source rather than render wrong ranges.
  - Block decorations must come from a `StateField`, never a `ViewPlugin` (CodeMirror throws
    `Block decorations may not be specified via plugins`).
  - Registered plugin code-block processors (`plugin-blocks.ts`) take precedence over the
    built-in Mermaid renderer; `MarkdownEditor.refreshPluginBlocks()` re-renders after plugin
    changes.
- `src/app/rich-content.ts` — KaTeX/Mermaid are dynamically imported only when a note uses them,
  to keep vault opening fast; keep heavy renderers (also `pdf-runtime.ts`) out of the initial
  bundle.
- `src/ui/icon-set.ts` statically bundles only the Lucide icons the host names;
  `tests/unit/icon-set.test.ts` fails when a new host icon id is missing there. The full set
  (`src/ui/icon-library.ts`) is a lazy chunk that `PluginBundleHost` loads before any plugin
  runs, because `setIcon` is synchronous. mermaid's KaTeX is deduplicated via `overrides` in
  `package.json`.
- `src/canvas/` — JSON Canvas 1.0 (`.canvas`). Parsing keeps unknown fields so files written by
  other apps round-trip losslessly.
- `src/markdown.ts` — `marked` rendering, always sanitized through DOMPurify; remote image
  sources are stripped.

### Plugin compatibility layer (`src/compat/`)

An independent implementation of the Obsidian plugin API surface, aimed at a selected set of
plugins (see `docs/plugin-compatibility.md`), not at arbitrary community plugins.

- `CompatibilitySession` (`session.ts`) is the per-vault root object that plugins see as `app`:
  it owns `Vault`, `Workspace`, `MetadataCache`, `FileManager`, `PluginRegistry`,
  `PluginServices` and the bundle host. It is disposed and recreated on vault switch.
- `Vault` talks only to a `VaultStoragePort` (`storage-port.ts`). `NativeVaultPort` is the real
  implementation; tests inject in-memory ports. Versions are opaque CAS tokens — the layer never
  retries a failed compare-and-swap.
- Loading pipeline: `VaultPluginBundles` lists `Basalt/Plugins/<id>/` (`manifest.json`,
  `main.js`, optional `styles.css`; a visible folder because Android SAF does not reliably expose
  `.obsidian`) → `plugin-module.ts` validates the manifest and evaluates `main.js` as CommonJS
  with a `require` restricted to the host `obsidian` module plus explicitly passed modules →
  `PluginBundleHost` activates it through `PluginRegistry`. Nothing loads without explicit
  per-plugin opt-in in settings.
- `CompatibilitySession.create` reads every Markdown note once to warm `MetadataCache`, because
  plugins expect `getFileCache` to be synchronous; vault events keep it current afterwards.
- `createObsidianApi` in `obsidian-api.ts` is the **entire** `obsidian` module table (classes,
  DOM helper prototypes, modals, settings, views): a missing export crashes a plugin at load with
  `undefined is not a function`. Check signatures against the official `obsidian.d.ts`, not
  memory. `PluginServices` collects commands, ribbon/status-bar items, setting tabs, code block
  processors and file views, which `App` surfaces in the UI.
- Plugins must receive the **same `@codemirror/state` / `@codemirror/view` instances as the
  host** (passed from `session.ts`); duplicated CodeMirror modules produce incompatible
  extensions. The app's own `MarkdownEditor` wraps the compat `Editor` adapter so plugin editor
  commands act on the shared instance.
- Plugin paths under `.obsidian/plugins/<id>` are remapped to `Basalt/Plugins/<id>`, every other
  `.obsidian/...` path to `Basalt/Config/...`; both are hidden from vault content. Other hidden
  paths stay rejected.

### Invariants worth preserving

These are deliberate and documented in `SECURITY.md` / `docs/`:

- Missing Obsidian APIs must fail visibly; do not add success-returning no-op stubs.
- No generic `window.require('fs')` / Node shim and no broad asset-URL exposure for plugins.
  `adapter.getResourcePath` works only for an activated plugin's own folder, served read-only by
  the `basalt-resource:` protocol (`src-tauri/src/resources.rs`) and allowed only in `connect-src`.
- Plugin code is trusted, not sandboxed. `'unsafe-eval'` in the CSP (`src-tauri/tauri.conf.json`)
  exists solely for the CommonJS loader; do not widen the CSP further without need.
- Writes never overwrite blindly: creation is exclusive, replacement and deletion are
  version-checked and backed up first. Folder deletion is rejected.
- Basalt implements the public `obsidian.d.ts` API surface. Never commit
  Obsidian application code, unpacked app packages or decompiler output.
- Storage changes usually need both paths (note `Backend` and plugin `NativeVaultPort`) and both
  implementations (directory and SAF). Read `SECURITY.md` first, especially on SAF's non-atomic
  writes.

### Docs to trust (and not)

- `docs/plugin-compatibility.md` — current compatibility targets, verified behaviour and known
  limits; update it when compat or live-preview behaviour changes.
- `AGENTS.md` carries overlapping notes for other agents; keep the two in sync.
