# Plugin compatibility

Basalt implements the public Obsidian plugin API (`obsidian.d.ts`) as its own compatibility
layer. The goal is compatibility with selected Obsidian plugins, not a blanket promise for any
community plugin. Missing shared APIs are added to the host rather than papered over by changing
plugin bundles.

## Local bundle loader and workspace

### Core live preview

KaTeX, Mermaid and Markdown tables are also rendered in the editor. A table stays visible while
editing; only the active cell shows its Markdown source. Registered plugin code block processors
still take precedence over the built-in Mermaid renderer. Plugin embeds keep their own life
cycle. Multi-line math inside nested blockquotes/callouts and tables that cannot be mapped
unambiguously stay visible as source, to be safe. When an edge cell is emptied, the editor adds
the optional outer table pipe if needed, so GFM does not shift the neighboring cell into another
column. Known rendering limit: an escaped table pipe inside a code span may still show its
backslash in an inactive cell; the source is preserved. The browser tests, including narrow
layouts and synthetic composition events, do not replace testing with a real Android keyboard or
the native Linux/Android runtime.

Frontmatter shows as editable properties (text, list, number, checkbox, date) unless the
setting is off or the YAML does not parse; the cursor inside the block shows the YAML again.
Edits go through the `yaml` document model, so comments, key order and flow lists stay. Pasted
or dropped files are stored like `FileManager.getAvailablePathForAttachment` names them,
following the attachment folder setting.

### Excalidraw 2.29.2: full browser life cycle verified

Checked on 2026-11-11/12 with the unmodified official
[release files](https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/2.29.2) in
isolated in-memory storage, not in a real vault. `main.js` (5,094,286 bytes) has SHA-256
`49dfc5667a7730dbc124cdfc2a4a8e89188100636493a39d6493bf5696a55541`.

- CommonJS evaluation succeeds. The explicit module table provides the same installed CodeMirror
  instances (`commands`, `language`, `state`, `view`) and Lezer instances (`common`,
  `highlight`, `lr`), with no free `require` or Node access.
- Added: `getLanguage` (current host UI language), `BaseComponent`, `ValueComponent`,
  `PopoverSuggest`, `AbstractInputSuggest`, the `EditorSuggest` base class, the documented global
  `sleep`, and the DOM methods Obsidian adds (`addClass`, `empty`, `createDiv`, `setCssStyles`
  and so on) on `Node`, `Element` and `HTMLElement`.
- The host now has real workspace leaves: `iterateAllLeaves`, `detachLeavesOfType`, `getLeaf`,
  multiple views, a life cycle in the order `onunload` → `onClose` (as documented by Excalidraw)
  and asynchronous cleanup.
- **Chromium E2E (desktop):** the plugin activates with `isReady: true` and 75 commands, views
  `excalidraw` and `excalidraw-sidepanel`; a new drawing is opened, a rectangle and text are
  created through the UI, autosave writes the Markdown file, another unsaved element is saved
  via "close tab" and reopened from the vault (all element IDs restored), then the plugin is
  deactivated with no remaining views, commands or leaves. No page errors.
- The same life cycle is also checked with the current Tauri production CSP sent as an HTTP
  header (Vite modules, no native build). Delegated DOM events `on(type, selector, listener)` /
  `off(...)` on elements and documents support the inline text editor. The test removes only the
  non-native HMR client. **Known limit:** optional Xiaolai CJK fonts from `esm.sh` stay blocked
  by `font-src`. The expected font violations are recorded as a test artifact; the CSP was not
  opened for the CDN. Latin text is verified; Chinese font rendering is therefore not proven.
- SVG export verified through the unmodified plugin methods `getSVG` and `saveSVG`: real shapes,
  text and an embedded WOFF2 font; the saved SVG was read back from the isolated vault. Both CSP
  variants pass. For this, the DOM helpers tolerate empty class entries and support
  `Setting.setVisibility`, a private host method used by this release. `connect-src data:` only
  allows reading already embedded font data; no new network or script sources.
- jsdom cannot fully start Excalidraw (no real iframe rendering, no `Worker`/`IndexedDB`, modern
  release CSS is not fully parsed). The optional jsdom activation test therefore skips exactly
  this bundle; `tests/e2e/excalidraw.spec.ts` is the authoritative coverage.
- Drawings embedded as `![[Drawing.excalidraw.md]]` in the reading view are rendered by the real
  plugin post-processor as a decoded image, not as compressed source. The host provides the
  resolved transclusion path in Obsidian's `src` attribute; surrounding note text is preserved.
  Both CSP variants and the actual app stylesheets are checked. The post-processor receives the
  actual Markdown container, so Excalidraw detects reading mode and registers its own embed
  controls. The preview button opens its dialog; the normal settings deactivation path unloads
  the render children and removes the toolbar, preview dialog, plugin styles, ribbon/status bar
  contributions and views. Resize and source controls are not checked.
- PNG saving through `savePNG` checked in both CSP variants: the file was read back from the
  vault, the PNG signature validated, decoded by the browser and non-empty dark pixels counted.
  No further host changes were needed.
- `exportPNG` additionally produces a real browser download with a `.png` file name and a valid
  PNG signature, without download errors. The export dialog click path and the native save
  dialog are not checked.

**Verified:** opening, drawing, autosave, saving, reloading, Markdown embedding, SVG/PNG saving
and deactivation in the browser. **Not verified:** native Tauri/Android builds, real vault writes
outside the in-memory copy, PDF export, export dialog/clipboard UI and embed resize/source
controls. The bundle files are not included in the repository.
**PDF export blocked:** the unmodified 2.29.2 export path requires
`window.electron.remote.dialog.showSaveDialog` and an Electron print export
([upstream source](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/2.29.2/src/utils/exportUtils.ts#L71-L108)).
These capabilities are not provided as a blanket Electron/file system shim. This does not affect
the host's own local PDF viewer.

### Iconize

The unmodified Iconize bundle **2.14.7** starts in the isolated Chromium harness with its
default icon path `.obsidian/icons` (also with a trailing `/`). This path physically lives under
`Basalt/Config/icons`, outside the vault content seen by sync plugins. Existing icon packs from
`.obsidian/icons` are not copied automatically and have to be moved into this folder if needed.

With `BASALT_PLUGIN_DIRS` set, `tests/e2e/iconize.spec.ts` checks activation, command
registration, creation of the icon folder, an active note with an internal link, opening the real
"Change icon" dialog from the file context menu, preview and selection of a local test SVG
including the visible file tree icon and the saved assignment, and deactivation including removal
of the commands, without console errors, in the desktop and mobile browser layouts. For this, the
host provides `tokenClassNodeProp` in the shared CodeMirror language module; so far only internal
link target text is mapped. File, folder, tab, bookmark and note options menus fire `file-menu`
and keep plugin menu items, including their `onHide` life cycle, in the shared host menu. The
real explorer view is reachable as a `file-explorer` leaf. Like in Obsidian, its `fileItems`
index contains all files and folders, including children of collapsed folders: their rows are
created detached when needed and reused on expansion. When the file tree rebuilds its rows, it
carries over anything a plugin inserted into a row (such as `.iconize-icon`) to the new row. The
test checks this for a rebuild and for collapsing/expanding a folder.

In the running Windows debug app, "More options → Change icon" and the SVG preview
`Rocket (Bt)` from the local test pack were also checked manually, without saving an assignment
in a real vault.

**Not verified:** native select/save cycles, running on Android, icon pack downloads, icons in
links and tabs, and file rows that have both a bookmark marker and a file type label (Iconize
skips rows with more than two children). This is not proof of full Iconize compatibility.
Neither personal plugin settings nor bundle files are committed.

### Execution model

The loader follows a deliberately narrow but real execution model:

- Bundles live visibly under `Basalt/Plugins/<id>/` with `manifest.json`, `main.js` and an
  optional `styles.css`. The visible folder is intentional, because Android's Storage Access
  Framework does not reliably expose hidden `.obsidian` folders.
- `manifest.json` is validated; the folder name ID must match `manifest.id`.
- `main.js` runs as CommonJS in a synthetic module wrapper. Only the host's own `obsidian` module
  and explicitly passed modules are allowed. Bundles receive the same CodeMirror 6 instances as
  the host.
- No bundle is loaded without explicit consent. Plugins are activated one by one in the settings,
  and the choice is saved and restored per vault.
- `app.plugins` offers `getPlugin`, `enablePlugin`/`disablePlugin` and the `...AndSave` variants
  for installed bundles, so plugins that update their own files can reload themselves.
  `enablePlugin` re-reads the bundle from disk and rejects on failure instead of resolving
  `false`.
- Plugin code deliberately gets access to the DOM, WebView storage and the app's Tauri commands.
  That is why `'unsafe-eval'` is needed in the CSP; it is a trust decision for locally installed
  bundles, not a sandbox.
- `app.vault.adapter` maps `.obsidian/plugins/<id>/…` to `Basalt/Plugins/<id>/…` and every other
  `.obsidian/…` path to `Basalt/Config/…` (neither is vault content); `adapter.list` returns the
  paths in Obsidian form again. Leading, duplicate and trailing slashes are tolerated as in
  Obsidian. Otherwise Iconize (2.14.7) failed at startup on `exists(".obsidian/icons/")`. Your
  own icon packs from Obsidian belong in `Basalt/Config/icons/`.
- `loadData`/`saveData` read and write `Basalt/Plugins/<id>/data.json` as in Obsidian
  (indented, at most 16 MiB). Settings therefore travel with the vault to other devices and into
  backups and survive reinstalling the app. A plugin's saves run in order, so the last call wins.
  An invalid `data.json` is not silently replaced with defaults but reported as an error; if a
  plugin restored at startup fails because of this, the app shows a notice and the error in the
  plugin settings instead of disabling it without comment. The file stays unchanged. Older
  Basalt versions kept this data in WebView `localStorage`; it is read until the plugin saves for
  the first time and removed afterwards. Like every plugin file, `data.json` is version-checked
  and backed up first; on Android (SAF) the write is not atomic (see `SECURITY.md`). Checked in
  the emulator (2026-11-12): migration, restart, broken and deleted `data.json` in the app's
  internal vault and in a SAF folder.
- The loader enforces 8 MiB for `main.js`, 64 KiB for the manifest and 1 MiB for styles.

Shared API fixes: plugin commands get global IDs such as `<plugin-id>:<command>` and the plugin
name as a display name prefix, so identical local IDs from different plugins no longer collide.
`requestUrl` supports URL strings, `contentType`, standard HTTP errors from status 400 and the
promise shortcuts `.json`, `.text` and `.arrayBuffer`. In the native app it runs through Rust
outside the WebView, so it is not subject to CORS (see `SECURITY.md`); the browser demo keeps
using `fetch`. API contract: https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts.

Settings → Community plugins can browse the Obsidian community catalog, install the latest
GitHub release of a catalog plugin or any repository, install from local files, check for updates
and uninstall (`src/compat/plugin-catalog.ts`, `src/app/plugin-install.ts`). Only the plugins
listed in `VERIFIED_PLUGINS` there are marked as checked, with the version above; keep that list
in sync with this document. The mark needs the catalog's own repository: a fork or another
repository with the same plugin id is untested, and the install dialog marks only the checked
version itself. Being installable says nothing about compatibility.

A catalog plugin's details offer a version picker: the latest release by default, or any of the
last 30 GitHub releases that ship `manifest.json` and `main.js` (pre-releases marked, picking an
older one installs it as a downgrade after a warning). The minimum Obsidian version per release
comes from the plugin's `versions.json`, and the install dialog checks the downloaded manifest's
`minAppVersion`; both are compared with the API version Basalt reports (`src/compat/api-version.ts`)
and only warn, they never block. The release list uses the anonymous GitHub API (60 requests per
hour), is loaded only when a plugin is opened and cached per app start.

`FileManager.renameFile` moves the file and, when "Automatically update internal links" is on,
rewrites links to it in notes and canvases exactly like a rename in the app: only links whose
target would change, each file through a version-checked `Vault.process`. Files that fail keep
their content; the call then rejects with an `AggregateError` after trying all of them.

`FileManager.processFrontMatter` parses the YAML frontmatter with the `yaml` package and calls the
callback with the mutable object. Only changed or deleted keys are written back; comments and
unchanged blocks are preserved. Invalid YAML or an error in the callback prevents the write. The
package adds about 100 kB (minified) to the frontend bundle. Reading, the callback and writing
run through `Vault.process`: concurrent changes are processed one after another; external
version conflicts are reported without repeating the callback.

`parseYaml`, `stringifyYaml` and `getFrontMatterInfo` use the same block definition as
`processFrontMatter`. `getFrontMatterInfo` returns `exists`, `frontmatter` (including the trailing
newline), `from`, `to` and `contentStart`; without a block all values are empty.
`sanitizeHTMLToDom` sanitizes plugin HTML with the already bundled DOMPurify and returns a
`DocumentFragment`. `requireApiVersion` compares against the reported `apiVersion` 1.15.0;
`getLinkpath`, `stripHeading` and `stripHeadingForLink` follow the documented examples, and
`getAllTags` normalizes the tags of a `CachedMetadata`. `addIcon`, `getIcon` and `removeIcon`
extend the built-in Lucide icons, and `setIcon` uses both sources. The full Lucide set lives in a
lazily loaded chunk that is loaded before any plugin is activated, so `setIcon` stays synchronous
and knows every icon for plugins. The buffer helpers (`arrayBufferToBase64`,
`base64ToArrayBuffer`, `arrayBufferToHex`, `hexToArrayBuffer`, `getBlobArrayBuffer`) work
unchecked as documented; malformed hex is rejected instead of returning half bytes.
`parseFrontMatterEntry`, `parseFrontMatterStringArray`, `parseFrontMatterTags` and
`parseFrontMatterAliases` read an already parsed frontmatter object, accept keys or patterns and
normalize tags with `#`.

This proves the module, registration, code block, view and limited storage layers, **not** the
behavior of sync, pen input or OCR, or the behavior on real Android devices.

Checked in the Chromium harness with unmodified community plugins: **Colored Tags 7.0.0**
activates without errors after adding `MetadataCache.getTags()` and deactivates cleanly; the
bundle registers only an editor extension, no views or commands. **Tag Wrangler 0.6.5** activates
without errors after adding `Workspace.registerHoverLinkSource`/`unregisterHoverLinkSource`; the
hover source is stored. The host now shows its own page preview for internal links but does not
yet query hover sources registered by plugins. **File Explorer Note Count 1.2.4** also goes
through the activation/deactivation cycle but does not show folder counts in the host yet: the
bundle looks for a `file-explorer` workspace leaf with `fileItems`, and the host's own file tree
does not provide this plugin view. The test only covers the life cycle, not the visible counter.
**Various Complements 11.4.2** activates with ten commands after aligning the `Scope` handlers
(`func`, `scope`, document order) and the default escape handler of editor completion. Registered
`EditorSuggest` suggestions now feed into the existing CodeMirror 6 completion: the unmodified
bundle suggests words from the active note, and Enter inserts the suggestion through the plugin
method. The Chromium test checked this insertion; the rendering is reduced to the plain
CodeMirror list entry, and custom multi-line plugin rendering and selection modifiers are not
reproduced. `metadataCache.resolvedLinks` and `unresolvedLinks` provide counts of resolved and
missing wiki links for this. **Cmdr 0.5.11** activates after adding the exported `moment`,
`app.statusBar.containerEl`, a real `MenuItem` class and the live command table
`app.commands.commands` with `removeCommand`; it registers the command
`cmdr:open-commander-settings` and deactivates cleanly. The macro and ribbon UI has not been
clicked through completely. **Calendar 1.5.10** still fails on `Workspace.getRightLeaf` and stays
deactivated; real sidebar leaf support is missing, and no placeholder was added. **Double Shift
Search 1.0.0** activates with `double-shift-search:open-vault-search`, and **Ninja Cursor
0.0.14** activates without commands or views; both deactivate cleanly. **File Explorer Plus
1.3.1** fails because there is no `file-explorer` view: the host has its own file tree but no
matching workspace leaf whose methods the plugin could patch; no substitute object was faked.
**Code Styler 1.1.7** passes the module check with the pure POSIX path helper and the default
theme value but fails on activation because the global CodeMirror 5 mode registry
(`window.CodeMirror.modeInfo`) is missing. The host uses CodeMirror 6; neither a CodeMirror 5
substitute nor an unrestricted Node shim was faked. **Obsidian File Color 1.1.0** also activates
and deactivates cleanly; it registers no commands or views. Whether colors become visible in the
host file tree is not proven. The global helpers documented by Obsidian for arrays (`first`,
`last`, `contains`, `remove`, `shuffle`, `unique`, `Array.combine`), `Math.clamp`/`square`,
`String.contains`/`format`/`isString` and `Number.isNumber` are now provided without overwriting
existing standard methods.

Plugin code blocks are passed to registered processors in reading mode and in live preview
editing mode. Registered, non-indented blocks at document level stay rendered in live preview,
also with focus, the cursor inside the block and a restored selection. The raw text remains
accessible in the explicitly chosen source mode. Without an active processor, a code block stays
normal Markdown source. After plugins load, an already rendered reading view is rebuilt. Active
plugin settings tabs appear in the settings dialog. Without an active Markdown note, editor
commands are unavailable; `workspace.activeEditor`, `getActiveFile` and
`getActiveViewOfType(MarkdownView)` then return `null`, as in Obsidian.

`app.embedRegistry.registerExtension` connects plugin file renderers to the note: standalone
`![[file.ext]]` lines appear as an embedded view in live preview, also with the cursor in the
link. The reading view supports the same registered file embeds. The embedded file stays the
storage location; source mode still shows the link. Without an active renderer, the previous link
rendering stays. Plugin UI is released when the editor is hidden and before deactivation.

## Open compatibility stages

1. Test the existing workspace integration of code blocks, plugin views, file extension
   navigation and settings tabs end to end with real plugins in native builds; the jsdom harness
   lacks canvas and `IntersectionObserver`, so drawing and measuring cannot be checked there.
2. Check sync, pen and spreadsheet plugins on real devices (two clients, offline/resume, pen
   pressure, OCR/worker resources, file fidelity).

Other shared gaps: visible plugin panes in the sidebars (Calendar) and the CodeMirror 5 mode for
older syntax plugins. `Editor.exec` maps the documented commands onto the shared CodeMirror 6
editor; `EditorSuggest` is connected to editor completion; `registerHoverLinkSource` stores
plugin sources but is not yet queried for the host's own page preview. Node/Electron plugins do
not automatically run on Android; an unrestricted file system shim is not an acceptable shortcut.

`MetadataCache.getFileCache` returns parsed note data (links, embeds, tags, headings,
frontmatter) with positions as of the latest state. For this, the session reads every Markdown
note once at startup (batched through `plugin_vault_read_many`, 64 files per call) and keeps the
cache current through vault events; `original` contains the link path without the alias, because
the shared parser drops aliases. If the saved tabs are only notes and canvases, the app shows
them before this read and connects the plugins afterwards; plugins then see the open file through
`file-open` or `getActiveFile()`. Tabs with plugin views or attachments wait for the session as
before.

`TextFileView` reads the note when it opens, passes the text to `setViewData` and then calls
`onLoadFile`; `save()` writes only changed data through the vault (including its version and
conflict check), and `requestSave()` batches changes with a 2 s delay. Pending changes are
completed on unload, and a rejected write is passed on instead of swallowed. The app's visible
editor view is independent of this.

The input components (`TextComponent`, `TextAreaComponent`, `ToggleComponent`,
`ButtonComponent`, `ExtraButtonComponent`, `DropdownComponent`, `SliderComponent`,
`ColorComponent`) are also exported directly from the `obsidian` module, not only through
`Setting.add…`. Plugins that construct them themselves therefore run unchanged.

Compared with `obsidian.d.ts`, the `Editor` bridge now only lacks `exec(command)`; `getDoc`,
`setLine`, `wordAt` and `blur` have been added. `wordAt` returns a word for a position exactly
when the position is inside or directly after a word; between two spaces the result is `null`.

**Current state:** loader, registration surfaces and workspace integration are on `main`. Full
plugin flows have not yet been proven on devices. There is still no blanket promise for arbitrary
community plugins.

Optional tests with unmodified local bundles (for example `tests/e2e/iconize.spec.ts`) are
enabled through `BASALT_PLUGIN_DIRS` (paths separated by `:` on Linux and `;` on Windows). Without
plugin bundles the standard CI skips them, so green CI alone does not prove full plugin
compatibility.

`Vault.append` writes through the same versioned write path as `Vault.process`; `Vault.trash`
uses the existing deletion path with backup. Both options (`DataWriteOptions`, `system`) are
accepted, but timestamps are still assigned by storage.
