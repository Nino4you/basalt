# Basalt: agent notes

## Execution boundaries

- This is Basalt, an independent implementation targeting Linux and Android, not an Obsidian fork. Never commit Obsidian application code, unpacked app packages or decompiler output.
- The root Cargo workspace contains only `vault-core` and `vault-cli`. `src-tauri/` is a separate workspace with its own `Cargo.lock`; root Cargo checks do **not** check the native shell.
- Frontend wiring: `src/main.ts` → `src/app/app.ts`. `src/backend.ts` selects Tauri IPC or a localStorage-only browser demo. `npm run dev` does not access real vaults or activate native plugins.
- Native note IPC lives in `src-tauri/src/lib.rs`; Android SAF storage is in `src-tauri/src/android.rs`. Keep `crates/vault-core/` independent of UI/Tauri/Android dependencies.
- Plugin wiring is `src/compat/session.ts` → `NativeVaultPort` → Rust plugin IPC, separate from the note `Backend` interface. Storage changes may need both paths and both directory/SAF implementations.
- `CompatibilitySession.create` reads every Markdown note once to warm `MetadataCache`; plugins expect `getFileCache` to be synchronous. Vault events keep it current after that.
- Host icons are bundled statically from `src/ui/icon-set.ts` (guarded by `tests/unit/icon-set.test.ts`); the full Lucide set is a lazy chunk that `PluginBundleHost` loads before any plugin runs, because `setIcon` is synchronous.

## Commands (repository root)

Use Node.js 22+ and stable Rust; install JS dependencies with `npm ci`.

| Scope | Command |
| --- | --- |
| Frontend typecheck + production build | `npm run build` (`tsc --noEmit` runs first) |
| Unit tests (jsdom, `tests/unit/`) | `npm test`; focused: `npm test -- tests/unit/store.test.ts -t "pattern"` |
| Core/CLI tests | `cargo test --workspace --locked` |
| One core integration test | `cargo test -p vault-core --locked --test vault conflicting_save_leaves_external_changes_untouched` |
| Rust formatting / lint | `cargo fmt --all -- --check`; `cargo clippy --workspace --all-targets --locked -- -D warnings` |
| Native formatting (separate) | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` |
| Native IPC tests (Linux CI invocation) | `cargo test --manifest-path src-tauri/Cargo.toml --lib --release --locked --features tauri/custom-protocol` |
| Browser E2E | First `npx playwright install chromium`, then `npm run test:e2e`; focused: `npm run test:e2e -- tests/e2e/app.spec.ts --project=desktop -g "pattern"` |
| Native Linux app | `npm run tauri -- dev`; package: `npm run tauri -- build --bundles deb,appimage` |
| Core without UI | `cargo run -p vault-cli -- list examples/demo-vault` |

- `.github/workflows/ci.yml` is the full check/build recipe, including Linux system packages, Python tool syntax checks, Android SDK/NDK versions and signing. Native commands need platform prerequisites; the default bundle targets are Linux-only.
- Android generation order: `npm run tauri -- android init --ci --skip-targets-install`, then `node tools/patch_android.mjs` (forwards system bar and keyboard insets to the page; without it the app draws under the navigation bar and the keyboard), then `npm run tauri -- icon public/basalt.svg`, then the Android build command from CI. `src-tauri/gen/android/` is generated, not checked-in source.
- Local Android builds on Windows need Developer Mode: Tauri symlinks the Rust library into `jniLibs`.
- Project page: `site/` is the static GitHub Pages landing page (English markup, German table in `site/main.js`, no third-party requests). `node tools/build_site.mjs` writes it plus the browser demo (`demo/`, relative asset paths) to `_site/`; `.github/workflows/pages.yml` deploys that from `main` and is skipped while the repository is private. `site/showcase-vault.js` seeds the demo for visitors without demo data and feeds `node tools/site_screenshots.mjs` (regenerates `site/assets/shot-*.png` from a running demo). Update the page when features or the README status change.

## Test coverage traps

- Playwright starts/reuses Vite at `127.0.0.1:1420` (strict port). Both `desktop` and `android-layout` projects exercise the **browser demo**; a passing mobile layout test does not verify SAF or Rust IPC.
- Native Android smoke testing is `node tools/smoke_android.mjs`: requires adb, an emulator and a universal debug APK (`BASALT_APK_DIR` overrides its directory). It installs the APK and modifies emulator app data; it deliberately refuses physical devices.
- Tests against real third-party plugin bundles (`tests/e2e/iconize.spec.ts`, `excalidraw.spec.ts`) require external built plugin folders via `BASALT_PLUGIN_DIRS` (platform path separator: `;` on Windows, `:` on Unix). They skip without plugin bundles, including in CI; ordinary green tests are not proof of real-plugin compatibility.
- Core symlink regression tests are `#[cfg(unix)]`; a Windows-only test run misses them.

## Contracts easy to break

- Vault writes must retain expected-version conflict checks and backups (`.basalt/history/`); deletions back up to `.basalt/trash/`. Preserve the original conflict basis when restoring drafts. Use validated `VaultPath` and capability-scoped storage, not joined ambient paths. See `SECURITY.md` before storage/IPC changes, especially SAF's non-atomic writes.
- Plugins live at `Basalt/Plugins/<id>/`; the adapter maps `.obsidian/plugins/<id>` there because Android SAF cannot reliably expose hidden folders. Every other `.obsidian/...` path maps to `Basalt/Config/...` (also hidden from vault content); other hidden paths stay unavailable. Activation is opt-in (previously enabled IDs are restored per vault).
- Plugins must share host `obsidian` classes and CodeMirror instances (`session.ts` supplies the modules). Do not bundle a second CodeMirror runtime or add an unrestricted Node/fs shim. CommonJS execution needs CSP `unsafe-eval` and is **not a sandbox**. Resource URLs exist only for an activated plugin's own folder (`basalt-resource:`, `src-tauri/src/resources.rs`, `connect-src` only); keep them that narrow.
- `createObsidianApi` in `src/compat/obsidian-api.ts` is the entire `obsidian` module table: a missing export is an `undefined is not a function` crash when a plugin loads. Check signatures and examples against the official `obsidian.d.ts`, never memory, and cover new pure helpers in `tests/unit/`.
- Block decorations in the editor must come from a `StateField`, not a `ViewPlugin`; CodeMirror throws `Block decorations may not be specified via plugins`. Plugin code blocks are rendered by `src/editor/plugin-blocks.ts`, and `MarkdownEditor.refreshPluginBlocks()` re-renders them after plugin changes.
- `docs/plugin-compatibility.md` records compatibility targets and verification limits.
