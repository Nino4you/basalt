import { getLocale, plural, t, type Locale } from "../i18n";
import type { EditorState } from "@codemirror/state";
import {
  backend,
  native,
  validateCanvasPath,
  validateNotePath,
  type VaultInfo,
} from "../backend";
import { attachmentKind, attachmentLink, availablePath } from "../attachments";
import { importAttachments } from "./attachment-import";
import { createEmbedPreviewHost } from "./editor-embeds";
import { clearImageCache } from "./image-cache";
import { autoCleanBackups } from "./backup-cleanup";
import {
  readAppearance,
  VaultStyles,
  writeAppearance,
  type Appearance,
} from "./vault-styles";
import { addProperty } from "../editor/properties";
import { insertFootnote } from "../editor/footnotes";
import { exportHtml, printNote } from "./print-export";
import {
  findUpdate,
  AndroidUpdateError,
  installAndroidUpdate,
  installSignedUpdate,
  updateCheckDue,
  type AvailableUpdate,
  type UpdateProgress,
} from "./update-check";
import { hostRequest } from "./plugin-install";
import { APP_VERSION } from "../version";
import {
  ConflictWatcher,
  conflictSummary,
  findConflicts,
  openSyncConflicts,
  type Conflict,
} from "./sync-conflicts";
import { foldAll, toggleFold, unfoldAll } from "@codemirror/language";
import { emptyCanvas } from "../canvas/model";
import { CanvasView } from "../canvas/view";
import { TFile, TFolder } from "../compat/files";
import {
  Menu as PluginMenu,
  TextFileView,
  type FileView,
} from "../compat/obsidian-api";
import { nativeRequestUrl } from "../compat/request";
import { CompatibilitySession } from "../compat/session";
import type { ViewState, WorkspaceLeaf } from "../compat/workspace";
import { MarkdownEditor, type EditorOptions } from "../editor";
import type { EditorSuggestRegistration } from "../editor/editor-suggest";
import { documentOutline, renderMarkdown, wordCount } from "../markdown";
import { NoteStore, type Note } from "../store";
import {
  basename,
  debounce,
  dirname,
  errorMessage,
  extension,
  formatHotkey,
  h,
  icon,
} from "../ui/dom";
import { closeMenu, showMenu, type MenuEntry } from "../ui/menu";
import { Modal, SuggestModal, topModal } from "../ui/modal";
import { notify } from "../ui/notice";
import { installTooltips } from "../ui/tooltip";
import { CommandRegistry } from "./commands";
import { NARROW_TABLET_QUERY, PHONE_QUERY, TOUCH_QUERY } from "../ui/device";
import { buildMobileToolbar } from "./mobile-toolbar";
import { EditorView } from "@codemirror/view";
import { Explorer } from "./explorer";
import { openGraph } from "./graph";
import { BookmarksView, SidePanels } from "./panels";
import { ReadingView } from "./reading";
import { LinkPreview } from "./link-preview";
import { SearchView } from "./search";
import { expandTemplate, templatePaths } from "./templates";
import { formatDate, parseDate } from "../dates";
import { SettingsStore } from "./settings";
import { openSettings } from "./settings-modal";
import {
  activatePanel,
  areaOf,
  DOCK_AREAS,
  defaultDock,
  type DockArea,
  type DockLayout,
  effectiveDock,
  movePanel,
  normalizeDock,
  withoutPanels,
} from "./dock";
import { installPanelDrag } from "./dock-drag";
import { AttachmentView } from "./attachment-view";
import { GroupMirror } from "./group-mirror";
import {
  buildGroup,
  buildShell,
  PANELS,
  type PanelId,
  type Shell,
} from "./shell";
import {
  cornerGroup,
  groupIds,
  isLeaf,
  mapGroups,
  normalizeSplit,
  removeGroup,
  type SplitBranch,
  splitGroup,
  type SplitNode,
  type SplitSide,
} from "./split";
import { installTabDrag } from "./tab-drag";
import { openCommandPalette, openQuickSwitcher } from "./switcher";
import { openFileRecovery } from "./file-recovery";
import { LinkUpdate } from "./link-update";
import { VaultIndex } from "./vault-index";
import {
  listenForShares,
  shareMarkdown,
  type SharedContent,
} from "./android-share";
import { openShareDialog } from "./share-dialog";

export interface Tab {
  id: number;
  path: string | null;
  kind: "empty" | "markdown" | "canvas" | "plugin" | "attachment";
  viewType: string | null;
  reading: boolean;
  note: Note | null;
  /** False for restored background tabs whose note has not been read yet. */
  loaded: boolean;
  history: string[];
  historyIndex: number;
  /** Editor state while the tab is in the background. */
  state: EditorState | null;
  scroll: number;
  previewScroll: number;
  request: number;
}

/** One editor group: a tab strip with the view of its active tab. */
export interface Group {
  id: number;
  tabs: Tab[];
  active: Tab;
}

type GroupView = ReturnType<typeof buildGroup> & { mirror: GroupMirror };

export interface Reveal {
  offset?: number;
  length?: number;
  heading?: string;
}

export interface OpenOptions {
  newTab?: boolean;
  reveal?: Reveal;
  /** Keep keyboard focus where it is (e.g. while arrowing through the tree). */
  keepFocus?: boolean;
  /** Internal navigation from the shared plugin workspace. */
  pluginState?: { leaf: WorkspaceLeaf; type: string };
}

type AppEvent = "active" | "files" | "index" | "doc" | "tabs" | "bookmarks";

/** Longest time between full plugin-vault refreshes while notes are saved. */
const FULL_REFRESH_INTERVAL = 30_000;

interface SavedTab {
  path: string | null;
  reading: boolean;
}

interface SavedWorkspace {
  /** Tabs of the focused group; all there is when the editor is not split. */
  tabs: SavedTab[];
  active: number;
  /** Only written while the editor is split into several groups. */
  groups?: Array<{ tabs: SavedTab[]; active: number }>;
  /** Split tree over indices into `groups`. */
  split?: unknown;
  /** Index of the focused group. */
  group?: number;
  expanded: string[];
  bookmarks: string[];
  recent: string[];
  sort: "asc" | "desc";
}

interface Layout {
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
  leftBottomHeight: number;
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  /** Which panel lives in which dock area; moved by drag & drop. */
  dock: DockLayout;
  /** Panels the user closed; they keep their place in `dock` for reopening. */
  closedPanels: PanelId[];
}

const LAYOUT_KEY = "basalt-layout";

export class App {
  readonly settings = new SettingsStore();
  readonly index = new VaultIndex();
  /** Text selected in the editor, for the status bar counts. */
  private selected = "";
  readonly commands = new CommandRegistry();
  readonly shell: Shell;
  readonly editor: MarkdownEditor;
  readonly reading: ReadingView;
  readonly explorer: Explorer;
  readonly search: SearchView;
  readonly bookmarksView: BookmarksView;
  readonly panels: SidePanels;

  vault: VaultInfo | null = null;
  store: NoteStore | null = null;
  compatibility: CompatibilitySession | null = null;
  /** Theme and CSS snippets of the open vault (native only). */
  readonly vaultStyles = new VaultStyles();
  appearance: Appearance = { cssTheme: "", enabledCssSnippets: [] };
  /** A newer release found by the update check, if any. */
  availableUpdate: AvailableUpdate | null = null;
  /** Editor groups; the focused one hosts the live editor and views. */
  groups: Group[] = [];
  group!: Group;
  /** How the groups are laid out. */
  split: SplitNode = { group: 0 };
  ws: SavedWorkspace = emptyWorkspace();
  layout: Layout;
  indexing = false;

  private readonly listeners = new Map<AppEvent, Set<() => void>>();
  private readonly saveTimers = new Map<Note, ReturnType<typeof setTimeout>>();
  /** Notes whose last save was rejected, with the reason shown in the banner. */
  private readonly failed = new Map<string, string>();
  /** Activation failures per plugin id, shown in the settings until retried. */
  readonly pluginErrors = new Map<string, string>();
  private readonly mobile = matchMedia(PHONE_QUERY);
  private readonly touch = matchMedia(TOUCH_QUERY);
  private readonly narrowTouch = matchMedia(NARROW_TABLET_QUERY);
  private readonly linkPreview: LinkPreview;
  private readonly groupViews = new Map<number, GroupView>();
  /** Structure of the split as last built into the DOM. */
  private splitShape = "";
  private nextGroupId = 1;
  private nextTabId = 1;
  private epoch = 0;
  private choosingVault = false;
  private pluginView: { tab: Tab; view: FileView; leaf: WorkspaceLeaf } | null = null;
  private pluginViewReady: Promise<void> = Promise.resolve();
  private requestedPluginLeaf: WorkspaceLeaf | null = null;
  private canvasView: CanvasView | null = null;
  private readonly attachmentView: AttachmentView;
  private drawer: "left" | "right" | null = null;
  /** Panel picked on a phone, where bottom panels share the right drawer. */
  private mobilePanel: PanelId | null = null;

  private readonly saveWorkspace = debounce(() => this.writeWorkspace(), 250);
  private readonly emitIndex = debounce(() => {
    this.emit("index");
    this.checkSyncConflicts();
  }, 120);
  private readonly conflictWatcher = new ConflictWatcher();
  private readonly docEdited = debounce(() => this.flushDoc(), 200);
  /** Notes saved since the plugin vault last looked at them. */
  private readonly savedPaths = new Set<string>();
  /** When the plugin vault last walked the whole vault (ms since epoch). */
  private lastFullRefresh = 0;
  private readonly refreshCompatLater = debounce(() => {
    void this.refreshSaved().catch((error) => this.report(error));
  }, 1500);

  constructor(root: HTMLElement) {
    // Until start() has restored the layout, sidebars appear without sliding.
    document.documentElement.classList.add("is-starting");
    this.shell = buildShell(root);
    this.attachmentView = new AttachmentView(this.shell.attachmentHost);
    this.layout = loadLayout();
    this.linkPreview = new LinkPreview((target, source) => {
      const path = this.index.resolve(target, source);
      if (!path || extension(path) !== "md") return null;
      return {
        title: basename(path).replace(/\.md$/i, ""),
        text: this.index.content(path) ?? "",
      };
    });
    this.editor = new MarkdownEditor(this.shell.editorEl, {
      onChange: (text) => this.onEditorChange(text),
      onSelection: (selected) => {
        if (selected === this.selected) return;
        this.selected = selected;
        this.updateStatus();
      },
      save: () => void this.save().catch((error) => this.report(error)),
      resolves: (target) =>
        !!this.activePath &&
        this.index.resolve(target, this.activePath) !== null,
      openLink: (target, newTab) => {
        if (this.activePath) this.openLink(target, this.activePath, newTab);
      },
      openExternal: (url) => this.openExternal(url),
      previewLink: (target, rect) => {
        if (target && this.activePath && rect)
          this.previewLink(target, this.activePath, rect);
        else this.hideLinkPreview();
      },
      openTag: (tag) => this.searchFor(`tag:#${tag}`),
      notes: () => this.linkCandidates(),
      tags: () => [...this.index.tags().keys()].sort(),
      subpaths: (target, blocks) => this.subpathCandidates(target, blocks),
      editorSuggests: () =>
        (this.compatibility?.services.getEditorSuggests() ??
          []) as EditorSuggestRegistration[],
      editorFile: () => {
        if (!this.compatibility || !this.activePath) return null;
        const file =
          this.compatibility.vault.getAbstractFileByPath(this.activePath);
        return file instanceof TFile ? file : null;
      },
      pluginCodeBlock: (language) =>
        this.compatibility?.services.getCodeBlockProcessor(language),
      pluginEmbed: (target) =>
        this.activePath
          ? (this.compatibility?.embedRegistry.resolve(
              target,
              this.activePath,
            ) ?? null)
          : null,
      embedPreview: createEmbedPreviewHost(this),
      pluginContext: () =>
        this.compatibility
          ? { sourcePath: this.activePath ?? "", app: this.compatibility }
          : null,
      attachFiles: (files, pasted) =>
        importAttachments(this.compatibility?.vault ?? null, files, {
          sourcePath: this.activePath ?? "",
          folderSetting: this.settings.get("attachmentFolder"),
          pasted,
        }),
      linkTo: (path) =>
        this.vault?.files.includes(path)
          ? attachmentLink(path, this.vault.files)
          : null,
    });
    this.applyEditorSettings();
    this.wireTouchEditing();
    this.reading = new ReadingView(this, this.shell.previewEl);
    this.explorer = new Explorer(this, this.shell.panes.files);
    this.search = new SearchView(this, this.shell.panes.search);
    this.bookmarksView = new BookmarksView(this, this.shell.panes.bookmarks);
    this.panels = new SidePanels(this, this.shell.panes);
    this.setGroups([this.makeGroup([this.makeTab()])]);

    this.registerCommands();
    // Puts the live views into the document, where the wiring finds them.
    this.renderGroups();
    this.wireShell();
    installTooltips();
    this.index.onChange(() => this.emitIndex());
    this.settings.onChange((key) => {
      this.applyEditorSettings();
      this.renderGroups();
      if (key === "fontSize") this.editor.measure();
      if (key === "inlineTitle") this.showActive();
    });
    this.mobile.addEventListener("change", () => this.applyLayout());
    this.touch.addEventListener("change", () => this.applyLayout());
    this.narrowTouch.addEventListener("change", () => this.applyLayout());
    this.on("tabs", () => this.renderGroups());
    this.on("active", () => {
      this.updateHeader();
      this.updateStatus();
    });
    this.on("index", () => {
      this.updateBacklinkCount();
      // Embedded notes in live preview follow changes to their content.
      this.editor.refreshLinks();
    });
    this.applyLayout();
    this.renderGroups();
    this.showActive();
  }

  // ── events ────────────────────────────────────────────────────────────────

  /** Returns a function that removes the listener again. */
  on(event: AppEvent, listener: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  private emit(event: AppEvent): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  report(error: unknown): void {
    console.error(error);
    notify(errorMessage(error), true);
  }

  get isMobile(): boolean {
    return this.mobile.matches;
  }

  /**
   * Touch devices get a formatting bar while the editor has focus; on phones
   * it takes the navigation bar's place above the on-screen keyboard.
   */
  private wireTouchEditing(): void {
    const view = this.editor.view;
    const toolbar = buildMobileToolbar(() => this.editor.view);
    this.shell.mobileNavbar.before(toolbar);
    // Focus inside the editor counts too (a table cell input), so the bar does
    // not vanish and shift the layout under the finger.
    const update = () =>
      document.body.classList.toggle(
        "is-editing",
        view.dom.contains(document.activeElement) &&
          view.state.facet(EditorView.editable),
      );
    view.dom.addEventListener("focusin", update);
    view.dom.addEventListener("focusout", () => queueMicrotask(update));
  }

  /** Tabs of the focused group. */
  get tabs(): Tab[] {
    return this.group.tabs;
  }

  set tabs(tabs: Tab[]) {
    this.group.tabs = tabs;
  }

  /** The tab shown in the focused group: the one the live views belong to. */
  get active(): Tab {
    return this.group.active;
  }

  set active(tab: Tab) {
    this.group.active = tab;
  }

  get allTabs(): Tab[] {
    return this.groups.flatMap((group) => group.tabs);
  }

  groupOf(tab: Tab): Group | undefined {
    return this.groups.find((group) => group.tabs.includes(tab));
  }

  get activePath(): string | null {
    return this.active.path;
  }

  get activeNote(): Note | null {
    return this.active.kind === "markdown" ? this.active.note : null;
  }

  /** The note or canvas file the active tab edits through the note store. */
  get activeDocument(): Note | null {
    return this.active.kind === "markdown" || this.active.kind === "canvas"
      ? this.active.note
      : null;
  }

  // ── vault lifecycle ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    const root = document.documentElement;
    root.classList.add("is-starting");
    try {
      await this.loadVault(await backend.info());
    } catch (error) {
      this.setSaveStatus("error", t("Vault konnte nicht geöffnet werden"));
      this.report(error);
    } finally {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => root.classList.remove("is-starting")),
      );
    }
    // Content shared from other Android apps ("Share" → Basalt); a no-op
    // without the activity's bridge.
    listenForShares(
      (share) => this.receiveShare(share),
      (error) => this.report(error),
    );
    // Opt-in; a failed check (offline, rate limit) is not worth a notice.
    void this.checkForUpdates().catch((error) => console.warn(error));
  }

  private async loadVault(next: VaultInfo): Promise<void> {
    const epoch = ++this.epoch;
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    this.savedPaths.clear();
    this.docEdited.cancel();
    this.saveWorkspace.flush();
    this.unmountPluginView();
    this.failed.clear();
    this.vault = next;
    this.store = new NoteStore(backend, next.id);
    this.index.reset();
    this.reading.clear();
    this.clearAttachment();
    clearImageCache();
    for (const view of this.groupViews.values()) view.mirror.release();
    this.pluginErrors.clear();
    const previous = this.compatibility;
    this.editor.releasePluginBlocks();
    this.compatibility = null;
    this.vaultStyles.clear();
    this.appearance = { cssTheme: "", enabledCssSnippets: [] };
    this.conflictWatcher.reset();
    // The old session must have released the shared editor before a new one binds it.
    if (previous) await previous.dispose().catch((error) => this.report(error));
    if (epoch !== this.epoch) return;

    this.ws = loadWorkspace(next.id);
    this.shell.vaultName.textContent = next.name;
    this.shell.environment.textContent = native
      ? t("{platform} · lokal", { platform: next.platform === "android" ? "Android" : "Linux" })
      : t("Browser-Demo");
    document.body.classList.toggle("is-android", next.platform === "android");
    this.setFiles(next.files);

    // Plugins read and parse every note before they load. When the saved
    // tabs are plain notes and canvases, show them first and connect the
    // plugins afterwards; tabs of plugin or attachment files need the session.
    const pluginsLater = native && this.documentsOnly();
    if (native && !pluginsLater) await this.connectPlugins(next);
    if (epoch !== this.epoch) return;
    await this.restoreTabs(epoch);
    if (epoch !== this.epoch) return;
    if (pluginsLater) {
      await this.connectPlugins(next);
      if (epoch !== this.epoch) return;
    }
    void this.indexFiles();
    // Old backups go once a day; a failure only costs disk space.
    void autoCleanBackups(backend, next.id, {
      maxAgeDays: this.settings.get("backupMaxAgeDays"),
      maxVersions: this.settings.get("backupMaxVersions"),
    }).catch((error) => console.error(error));
  }

  /** Whether every saved tab is empty or a Markdown note or canvas that exists. */
  private documentsOnly(): boolean {
    const groups = this.ws.groups?.length
      ? this.ws.groups
      : [{ tabs: this.ws.tabs }];
    return groups.every((group) =>
      group.tabs.every(
        (tab) =>
          tab.path === null ||
          (/\.(md|canvas)$/i.test(tab.path) && this.index.has(tab.path)),
      ),
    );
  }

  private async restoreTabs(epoch: number): Promise<void> {
    // Restore the previous session's tabs; notes are read lazily on activation.
    const restore = (saved: SavedTab): Tab => {
      const tab = this.makeTab();
      tab.path = saved.path;
      tab.reading = saved.reading;
      tab.kind = saved.path ? "markdown" : "empty";
      tab.loaded = !saved.path;
      if (saved.path) {
        tab.history = [saved.path];
        tab.historyIndex = 0;
      }
      return tab;
    };
    const savedGroups = this.ws.groups?.length
      ? this.ws.groups
      : [{ tabs: this.ws.tabs, active: this.ws.active }];
    let split = normalizeSplit(this.ws.split, savedGroups.length);
    const groups: Group[] = [];
    /** Runtime id of each saved group that still has tabs. */
    const ids = new Map<number, number>();
    let focused: Group | undefined;
    savedGroups.forEach((saved, index) => {
      const tabs = saved.tabs
        .filter((tab) => tab.path === null || this.index.has(tab.path))
        .map(restore);
      if (!tabs.length) {
        split = removeGroup(split, index) ?? split;
        return;
      }
      const group = this.makeGroup(
        tabs,
        tabs[Math.min(Math.max(saved.active, 0), tabs.length - 1)],
      );
      ids.set(index, group.id);
      groups.push(group);
      if (index === (this.ws.group ?? 0)) focused = group;
    });
    if (groups.some((group) => group.tabs.some((tab) => tab.path)))
      this.setGroups(
        groups,
        focused,
        mapGroups(split, (index) => ids.get(index)!),
      );
    else {
      const tab = this.makeTab();
      const first = this.index.has("Willkommen.md")
        ? "Willkommen.md"
        : this.index.files.find((path) => /\.md$/i.test(path));
      if (first) {
        tab.path = first;
        tab.kind = "markdown";
        tab.loaded = false;
        tab.history = [first];
        tab.historyIndex = 0;
      }
      this.setGroups([this.makeGroup([tab])]);
    }
    this.emit("tabs");
    await this.ensureLoaded(this.active);
    if (epoch !== this.epoch) return;
    this.showActive();
    for (const group of this.groups)
      if (group !== this.group) this.showBackground(group);
  }

  private async connectPlugins(next: VaultInfo): Promise<void> {
    try {
      const session = await CompatibilitySession.create({
        vaultId: next.id,
        name: next.name,
        mobile: next.platform === "android",
        editor: this.editor.compat,
        extensions: this.editor.extensions,
        container: this.shell.viewContent,
        navigate: (path) => this.openPath(path),
        basePath: next.platform === "android" ? null : next.id,
        renderMarkdown,
        ribbonEl: this.shell.pluginRibbon,
        statusBarEl: this.shell.pluginStatus,
        requestUrl: nativeRequestUrl(),
        updateLinks: () => this.settings.get("updateLinks"),
        attachmentFolder: () => this.settings.get("attachmentFolder"),
        pluginUi: {
          release: () => this.releasePluginUi(),
          refresh: (id, error) => {
            if (error === undefined) this.pluginErrors.delete(id);
            else this.pluginErrors.set(id, errorMessage(error));
            this.refreshPluginUi();
          },
        },
      });
      if (this.vault !== next) {
        await session.dispose().catch((error) => this.report(error));
        return;
      }
      this.compatibility = session;
      // Creating the session read a full snapshot.
      this.lastFullRefresh = Date.now();
      for (const [id, error] of session.restoreFailures) {
        this.pluginErrors.set(id, errorMessage(error));
        console.error(error);
        notify(
          t("Plugin {id} konnte nicht geladen werden und wurde deaktiviert: {error}", { id, error: errorMessage(error) }),
          true,
        );
      }
      this.bindPluginWorkspace(session);
      void this.applyVaultStyles().catch((error) => this.report(error));
      this.syncVisibleFiles();
      this.editor.refreshPluginBlocks();
      // The note was rendered before the plugins existed; refresh that view
      // and tell the plugins which file is open.
      if (this.active.reading) this.showActive();
      else if (this.active.kind !== "plugin")
        session.setActivePath(
          this.activeNote || this.active.kind === "attachment"
            ? this.activePath
            : null,
        );
      session.vault.on("modify", (file: TFile) => {
        void this.adoptExternalChange(session, file).catch((error) =>
          this.report(error),
        );
      });
      for (const event of ["create", "delete", "rename"])
        session.vault.on(event, () => {
          if (session === this.compatibility) this.syncVisibleFiles();
        });
    } catch (error) {
      this.report(error);
    }
  }

  /**
   * Asks GitHub for a newer release. `manual` checks right away and reports
   * the result; otherwise only when enabled and due, quietly unless found.
   */
  async checkForUpdates(manual = false): Promise<AvailableUpdate | null> {
    if (!manual && (!this.settings.get("updateCheck") || !updateCheckDue()))
      return null;
    const update = await findUpdate(hostRequest, APP_VERSION);
    this.availableUpdate = update;
    if (update)
      notify(
        update.installable
          ? t("Basalt {version} ist verfügbar. Unter Einstellungen → Allgemein kannst du es installieren.", {
              version: update.version,
            })
          : t("Basalt {version} ist verfügbar. Einstellungen → Allgemein führt zum Download.", {
              version: update.version,
            }),
      );
    else if (manual)
      notify(t("Basalt ist aktuell ({version}).", { version: APP_VERSION }));
    return update;
  }

  /**
   * Saves every open buffer and the workspace, then lets the native updater
   * install the announced release; Basalt restarts when it succeeds.
   */
  async installUpdate(onProgress: (progress: UpdateProgress) => void): Promise<void> {
    if (!this.availableUpdate?.installable)
      throw new Error(t("Für dieses Update gibt es keine automatische Installation."));
    await saveBeforeLeaving(this);
    this.writeWorkspace();
    if (this.availableUpdate.apk && this.vault?.platform === "android") {
      try {
        await installAndroidUpdate(this.availableUpdate, onProgress);
      } catch (error) {
        throw androidUpdateMessage(error);
      }
    } else await installSignedUpdate(onProgress);
  }

  /** Asks where shared content goes, then stores it like a pasted note. */
  receiveShare(share: SharedContent): void {
    if (!this.vault) return;
    closeMenu();
    openShareDialog(
      {
        createNote: (content, name) => this.createSharedNote(content, name),
        appendTarget: () => this.activeNote?.path ?? null,
        appendToCurrent: (content) => this.appendShared(content),
      },
      share,
    );
  }

  private async sharedEmbeds(
    share: SharedContent,
    sourcePath: string,
  ): Promise<string[]> {
    if (!share.files.length) return [];
    const files = share.files.map(
      (file) => new File([file.bytes], file.name, { type: file.type }),
    );
    const links = await importAttachments(
      this.compatibility?.vault ?? null,
      files,
      {
        sourcePath,
        folderSetting: this.settings.get("attachmentFolder"),
        pasted: false,
      },
    );
    if (links) {
      this.setFiles((await backend.info()).files);
      this.syncVisibleFiles();
    }
    return links ? links.split("\n") : [];
  }

  private async createSharedNote(
    share: SharedContent,
    name: string,
  ): Promise<string | null> {
    const folder =
      this.settings.get("newNoteLocation") === "current" && this.activePath
        ? dirname(this.activePath)
        : "";
    const path = validateNotePath(
      folder ? `${folder}/${name.trim()}` : name.trim(),
    );
    const folderOf = dirname(path);
    const free = availablePath(
      folderOf,
      folderOf ? path.slice(folderOf.length + 1) : path,
      (candidate) => this.index.has(candidate),
    );
    const embeds = await this.sharedEmbeds(share, free);
    return this.createNote(free, {
      text: `${shareMarkdown(share, embeds)}\n`,
      throwOnError: true,
    });
  }

  private async appendShared(share: SharedContent): Promise<void> {
    const note = this.activeNote;
    if (!note) throw new Error(t("Keine Notiz geöffnet."));
    const embeds = await this.sharedEmbeds(share, note.path);
    if (this.activeNote !== note) throw new Error(t("Die Notiz wurde gewechselt."));
    const addition = shareMarkdown(share, embeds);
    if (!addition) return;
    this.setReading(false);
    const doc = this.editor.view.state.doc;
    const separator = !doc.length ? "" : doc.toString().endsWith("\n\n") ? "" : doc.toString().endsWith("\n") ? "\n" : "\n\n";
    this.editor.view.dispatch({
      changes: { from: doc.length, insert: `${separator}${addition}\n` },
      selection: { anchor: doc.length + separator.length + addition.length + 1 },
      scrollIntoView: true,
    });
  }

  /** Sync conflict copies and notes with merge markers in this vault. */
  syncConflicts(): Conflict[] {
    this.checkSyncConflicts();
    return this.conflictWatcher.conflicts;
  }

  private checkSyncConflicts(): void {
    const conflicts = findConflicts(
      this.index.files,
      (path) => this.index.content(path),
      this.conflictWatcher.markers,
    );
    const fresh = this.conflictWatcher.update(conflicts);
    const button = document.getElementById("sync-conflicts");
    if (button) {
      button.textContent = conflictSummary(conflicts);
      button.hidden = !conflicts.length;
    }
    if (fresh.length)
      notify(
        t("Sync-Konflikt gefunden: {files}. Befehl „Sync-Konflikte anzeigen“ hilft beim Lösen.", {
          files: fresh.map((conflict) => `„${basename(conflict.path)}“`).join(", "),
        }),
        true,
      );
  }

  /** The current text of a note or canvas, unsaved edits included. */
  async readNote(path: string): Promise<string> {
    const store = this.store;
    if (!store) throw new Error(t("Kein Vault geöffnet."));
    return (await store.load(path)).text;
  }

  /**
   * Replaces `original` with the text of its conflict copy (backed up and
   * version-checked like any restore), then moves the copy to the trash.
   */
  async adoptConflictCopy(copy: string, original: string): Promise<void> {
    const text = await this.readNote(copy);
    const { failed } = await this.rewriteNotes([original], () => text);
    if (failed.length)
      throw new Error(
        t("„{name}“ konnte nicht geändert werden und ist unverändert.", {
          name: basename(original),
        }),
      );
    await this.trashFile(copy);
  }

  /** Moves a note or canvas to the vault trash without asking. */
  async trashFile(path: string): Promise<void> {
    const store = this.store;
    if (!store) throw new Error(t("Kein Vault geöffnet."));
    await this.deleteFile(path, store);
  }

  /** Reads appearance.json and applies the vault's theme and snippets. */
  async applyVaultStyles(): Promise<void> {
    const session = this.compatibility;
    if (!session) return;
    const appearance = await readAppearance(session.configVault);
    if (session !== this.compatibility) return;
    this.appearance = appearance;
    const failed = await this.vaultStyles.apply(session.configVault, appearance);
    if (failed.length)
      notify(
        t("CSS konnte nicht geladen werden: {names}", { names: failed.join(", ") }),
        true,
      );
  }

  /** Saves a new theme/snippet choice to appearance.json and applies it. */
  async setAppearance(next: Appearance): Promise<void> {
    const session = this.compatibility;
    if (!session) return;
    await writeAppearance(session.configVault, next);
    if (session !== this.compatibility) return;
    this.appearance = next;
    await this.vaultStyles.apply(session.configVault, next);
  }

  /** Plugin navigation and explorer navigation share the same real views/leaves. */
  private bindPluginWorkspace(session: CompatibilitySession): void {
    session.workspace.registerHostView(this.explorer);
    session.workspace.host = {
      open: async (leaf: WorkspaceLeaf, state: ViewState) => {
        const path = state.state?.file;
        if (typeof path !== "string") throw new Error("A file path is required for a main-area plugin view");
        const current = this.pluginView;
        const newTab = leaf !== session.workspace.activeLeaf;
        if (current?.leaf === leaf && state.type !== current.view.getViewType()) this.unmountPluginView();
        await session.workspace.flushPending();
        this.requestedPluginLeaf = leaf;
        try {
          await this.openPath(path, { newTab, pluginState: { leaf, type: state.type } });
          await this.pluginViewReady;
          if (this.pluginView?.leaf === leaf)
            await session.workspace.loadView(leaf, state, leaf.containerEl);
        } finally { this.requestedPluginLeaf = null; }
      },
      activate: leaf => {
        if (this.pluginView?.leaf === leaf && this.active !== this.pluginView.tab)
          void this.activate(this.pluginView.tab);
      },
    };
  }

  /** Plugin-compat status line shown in the settings. */
  get compatStatus(): string {
    if (!native)
      return t("Kompatibilitätsgrundlagen: nur in der nativen App. Kein Plugin-Loader.");
    return this.compatibility
      ? t("Vault-, Datei- und Editor-Grundlagen verbunden. Plugin-Loader bereit; kein Bundle wird automatisch aktiviert.")
      : t("Kompatibilitätsbrücke konnte nicht initialisiert werden. Notizeditor bleibt verfügbar.");
  }

  private setFiles(files: string[]): void {
    if (this.vault) this.vault.files = files;
    this.index.setFiles(files);
    this.editor.refreshLinks();
    this.emit("files");
  }

  /** Folders known to the native vault, including empty ones. */
  folders(): string[] {
    const session = this.compatibility;
    if (!session) return [];
    return session.vault
      .getAllLoadedFiles()
      .filter(
        (entry) => entry instanceof TFolder && entry.path && entry.path !== "/",
      )
      .map((entry) => entry.path);
  }

  /** Markdown notes, canvases and files a plugin has registered a view for. */
  syncVisibleFiles(): void {
    const session = this.compatibility;
    if (!this.vault || !session) return;
    const supported = session.vault
      .getAllLoadedFiles()
      .filter((entry): entry is TFile => entry instanceof TFile)
      .map((file) => file.path)
      .filter(
        (path) =>
          /\.(md|canvas)$/i.test(path) ||
          !!attachmentKind(path) ||
          !!session.services.getViewTypeForExtension(extension(path)),
      );
    const files = [...new Set(supported)].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    this.setFiles(files);
  }

  async refreshFiles(): Promise<void> {
    if (!this.vault) return;
    const vault = this.vault;
    const info = await backend.info();
    if (vault !== this.vault) return;
    this.setFiles(info.files);
    await this.refreshCompatibility();
    if (this.compatibility) this.syncVisibleFiles();
    void this.indexFiles();
  }

  /**
   * After the app's own saves, re-read just those files. A full walk of the
   * vault (slow on Android SAF) still runs now and then, and whenever the app
   * comes back to the foreground, to pick up changes made by other programs.
   */
  private async refreshSaved(): Promise<void> {
    const session = this.compatibility;
    const paths = [...this.savedPaths];
    this.savedPaths.clear();
    if (!session) return;
    if (Date.now() - this.lastFullRefresh > FULL_REFRESH_INTERVAL)
      return this.refreshCompatibility();
    for (const path of paths) {
      if (session !== this.compatibility) return;
      await session.vault.refreshFile(path);
    }
  }

  private async refreshCompatibility(): Promise<void> {
    const session = this.compatibility;
    if (!session) return;
    this.lastFullRefresh = Date.now();
    await session.refresh();
    if (session === this.compatibility)
      session.setActivePath(
        this.activeNote || this.active.kind === "attachment" ? this.activePath : null,
      );
  }

  /** Reads every note once so search, backlinks and tags work vault-wide. */
  private async indexFiles(): Promise<void> {
    const vault = this.vault;
    const store = this.store;
    const session = this.compatibility;
    if (!vault || !store) return;
    const epoch = this.epoch;
    const queue = this.index.files.filter(
      (path) =>
        /\.(md|canvas)$/i.test(path) && this.index.content(path) === undefined,
    );
    if (!queue.length) return;
    this.indexing = true;
    let failures = 0;
    let done = 0;
    const worker = async () => {
      for (;;) {
        const path = queue.pop();
        if (!path || epoch !== this.epoch) return;
        try {
          const file = session?.vault.getFileByPath(path);
          // Metadata warmup already populated the vault's invalidation-aware text cache.
          const text =
            store.notes.get(path)?.text ?? (session && file
              ? await session.vault.cachedRead(file)
              : await backend.read(path, vault.id));
          if (epoch !== this.epoch) return;
          this.index.setContent(path, text, true);
        } catch (error) {
          if (++failures === 1) this.report(error);
        }
        // Let panels fill in progressively without re-rendering per file.
        if (++done % 200 === 0) this.index.flush();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (epoch !== this.epoch) return;
    this.indexing = false;
    this.index.flush();
  }

  private async adoptExternalChange(
    session: CompatibilitySession,
    file: TFile,
  ): Promise<void> {
    const type = file.extension.toLowerCase();
    if (session !== this.compatibility || (type !== "md" && type !== "canvas"))
      return;
    const text = await session.vault.read(file);
    if (session !== this.compatibility || !this.store) return;
    const note = this.store.notes.get(file.path);
    if (note && note.saved !== text) {
      if (note.text !== note.saved) {
        this.failed.set(
          note.path,
          t("Die Datei wurde außerhalb des Editors geändert."),
        );
        this.updateStatus();
        if (note !== this.activeNote)
          notify(
            t("„{name}“ wurde geändert. Dein lokaler Entwurf bleibt erhalten.", { name: basename(note.path) }),
            true,
          );
        return;
      }
      note.text = note.saved = text;
      for (const tab of this.allTabs) if (tab.note === note) tab.state = null;
      if (this.activeNote === note) {
        this.editor.setText(text);
        if (this.active.reading) this.reading.render(note.path, text);
      } else if (this.activeDocument === note) this.canvasView?.setText(text);
      this.renderGroups();
    }
    this.index.setContent(file.path, text);
  }

  async chooseVault(): Promise<void> {
    if (this.choosingVault || !this.store) return;
    this.choosingVault = true;
    try {
      // Do not leave the vault (and cancel its save timers) when a draft could
      // not be saved. Keep the current note and conflict controls available.
      await saveBeforeLeaving(this);
      const next = await backend.choose();
      if (next) await this.loadVault(next);
    } catch (error) {
      this.report(error);
    } finally {
      this.choosingVault = false;
    }
  }

  /** Reload host and plugin labels together, only after every open buffer saved. */
  async changeLanguage(language: Locale): Promise<void> {
    const previous = this.settings.get("language");
    if (language === previous) return;
    try {
      await saveBeforeLeaving(this);
      this.writeWorkspace();
      if (!this.settings.set("language", language)) {
        this.settings.set("language", previous);
        throw new Error(t("Die Sprache konnte nicht gespeichert werden. Die Oberfläche wurde nicht neu geladen."));
      }
      window.location.reload();
    } catch (error) {
      this.report(error);
      notify(t("Die Sprache konnte nicht gewechselt werden. Offene Änderungen bleiben erhalten."), true);
    }
  }

  // ── tabs ──────────────────────────────────────────────────────────────────

  private makeGroup(tabs: Tab[], active: Tab = tabs[0]): Group {
    return { id: this.nextGroupId++, tabs, active };
  }

  /** Replaces all groups; without a layout they sit side by side. */
  private setGroups(
    groups: Group[],
    focused: Group = groups[0],
    split?: SplitNode,
  ): void {
    this.groups = groups;
    this.group = focused;
    this.split =
      split ??
      (groups.length === 1
        ? { group: groups[0].id }
        : {
            direction: "row",
            children: groups.map((group) => ({ group: group.id })),
            sizes: groups.map(() => 1),
          });
    // Sizes are only applied when the split is rebuilt.
    this.splitShape = "";
  }

  private makeTab(): Tab {
    return {
      id: this.nextTabId++,
      path: null,
      kind: "empty",
      viewType: null,
      reading: this.settings.get("defaultReading"),
      note: null,
      loaded: true,
      history: [],
      historyIndex: -1,
      state: null,
      scroll: 0,
      previewScroll: 0,
      request: 0,
    };
  }

  newTab(): Tab {
    const tab = this.makeTab();
    this.tabs.splice(this.tabs.indexOf(this.active) + 1, 0, tab);
    void this.activate(tab);
    return tab;
  }

  /** Stores the live editor state on the tab that is about to go to the background. */
  private park(): void {
    const tab = this.active;
    if (tab.kind !== "markdown" || !tab.note) return;
    tab.state = this.editor.state;
    tab.scroll = this.editor.view.scrollDOM.scrollTop;
    tab.previewScroll = this.shell.previewEl.scrollTop;
  }

  /** Shows `tab` in its group and gives that group the focus. */
  async activate(tab: Tab, reveal?: Reveal): Promise<void> {
    const group = this.groupOf(tab) ?? this.group;
    // A mirror may have been scrolled since its tab was parked.
    if (group !== this.group && tab === group.active)
      this.groupViews.get(group.id)?.mirror.handOver(tab);
    if (group !== this.group || tab !== this.active) {
      this.park();
      this.group = group;
      group.active = tab;
    }
    this.emit("tabs");
    await this.ensureLoaded(tab);
    if (tab !== this.active) return;
    this.showActive(reveal);
    this.saveWorkspace();
  }

  /** Loads the tab a background group shows, then refreshes its mirror. */
  private showBackground(group: Group): void {
    const epoch = this.epoch;
    void this.ensureLoaded(group.active).then(
      () => {
        if (epoch === this.epoch) this.renderGroups();
      },
      (error) => this.report(error),
    );
  }

  private async ensureLoaded(tab: Tab): Promise<void> {
    if (tab.loaded || !tab.path) return;
    await this.loadInto(tab, tab.path, false);
    if (!tab.loaded) {
      // The file vanished since the last session.
      tab.path = null;
      tab.kind = "empty";
      tab.loaded = true;
      tab.history = [];
      tab.historyIndex = -1;
    }
  }

  closeTab(tab: Tab = this.active): void {
    const group = this.groupOf(tab);
    if (!group) return;
    const index = group.tabs.indexOf(tab);
    const focused = group === this.group;
    const note = tab.note;
    if (note && note.text !== note.saved)
      void this.save(note).catch((error) => this.report(error));
    if (group.tabs.length === 1) {
      // A group goes away with its last tab, as in VS Code.
      if (this.groups.length > 1) return this.closeGroup(group);
      // The last tab of all turns into an empty one, as in Obsidian.
      if (tab.kind === "empty") return;
      this.unmountPluginView();
      const fresh = this.makeTab();
      group.tabs = [fresh];
      group.active = fresh;
    } else {
      group.tabs.splice(index, 1);
      if (tab === group.active) {
        group.active = group.tabs[Math.min(index, group.tabs.length - 1)];
        if (focused) {
          this.unmountPluginView();
          void this.activate(group.active);
          return;
        }
        this.showBackground(group);
      }
    }
    this.emit("tabs");
    if (focused && group.tabs.length === 1) this.showActive();
    this.saveWorkspace();
  }

  /** Removes a group with all its tabs; a neighbour takes over the focus. */
  private closeGroup(group: Group): void {
    const order = groupIds(this.split);
    const at = order.indexOf(group.id);
    const focused = group === this.group;
    for (const tab of group.tabs)
      if (tab.note && tab.note.text !== tab.note.saved)
        void this.save(tab.note).catch((error) => this.report(error));
    this.groups = this.groups.filter((other) => other !== group);
    this.split = removeGroup(this.split, group.id) ?? this.split;
    if (focused) {
      // The live views showed a tab that is gone; nothing is parked.
      this.unmountPluginView();
      const next = order[at - 1] ?? order[at + 1];
      this.group =
        this.groups.find((other) => other.id === next) ?? this.groups[0];
      void this.activate(this.active).then(() => this.focusView());
    } else {
      this.emit("tabs");
      this.saveWorkspace();
    }
  }

  closeOtherTabs(keep: Tab): void {
    const group = this.groupOf(keep);
    if (!group) return;
    for (const tab of group.tabs)
      if (tab !== keep && tab.note && tab.note.text !== tab.note.saved)
        void this.save(tab.note).catch((error) => this.report(error));
    if (group !== this.group) {
      group.tabs = [keep];
      group.active = keep;
      this.showBackground(group);
      this.emit("tabs");
      this.saveWorkspace();
      return;
    }
    if (this.active !== keep) {
      this.unmountPluginView();
      this.park();
    }
    this.tabs = [keep];
    void this.activate(keep);
  }

  /**
   * Moves a tab into `target` at `index` (the end when omitted), counted in
   * the strip as it is before the move, and shows it there.
   */
  moveTabTo(tab: Tab, target: Group, index?: number): void {
    const source = this.groupOf(tab);
    if (!source) return;
    // Whatever is live now gets parked, so focus can simply be reassigned.
    this.park();
    const from = source.tabs.indexOf(tab);
    let at = index ?? target.tabs.length;
    if (source === target && at > from) at -= 1;
    source.tabs.splice(from, 1);
    if (source !== target) {
      if (!source.tabs.length) {
        this.groups = this.groups.filter((group) => group !== source);
        this.split = removeGroup(this.split, source.id) ?? this.split;
      } else if (source.active === tab) {
        source.active = source.tabs[Math.min(from, source.tabs.length - 1)];
        this.showBackground(source);
      }
    }
    target.tabs.splice(Math.max(0, Math.min(at, target.tabs.length)), 0, tab);
    target.active = tab;
    this.group = target;
    void this.activate(tab).then(() => this.focusView());
  }

  /** Moves a tab into a new group on `side` of `beside`. */
  splitOff(tab: Tab, beside: Group, side: SplitSide): void {
    const source = this.groupOf(tab);
    if (!source || this.isMobile) return;
    // Splitting a group's only tab off next to itself changes nothing.
    if (source === beside && source.tabs.length === 1) return;
    const group = this.makeGroup([], tab);
    this.groups.push(group);
    this.split = splitGroup(this.split, beside.id, side, group.id);
    this.moveTabTo(tab, group);
  }

  /** Opens the active tab a second time in a new group, as in VS Code. */
  splitActive(side: SplitSide): void {
    if (this.isMobile) return;
    const tab = this.active;
    const selection = this.activeNote ? this.editor.state.selection : null;
    this.park();
    const copy: Tab = {
      ...tab,
      id: this.makeTab().id,
      history: [...tab.history],
      state: null,
      request: 0,
    };
    const group = this.makeGroup([copy]);
    this.groups.push(group);
    this.split = splitGroup(this.split, this.group.id, side, group.id);
    this.group = group;
    void this.activate(copy).then(() => {
      // The copy continues at the same place in the document.
      if (selection && this.active === copy && this.activeNote === tab.note)
        this.editor.view.dispatch({ selection });
      this.focusView();
    });
  }

  /** Gives the next or previous group, in reading order, the focus. */
  cycleGroup(direction: 1 | -1): void {
    const order = groupIds(this.split);
    if (order.length < 2) return;
    const next =
      order[
        (order.indexOf(this.group.id) + direction + order.length) % order.length
      ];
    const group = this.groups.find((other) => other.id === next);
    if (group) void this.activate(group.active).then(() => this.focusView());
  }

  cycleTab(direction: 1 | -1): void {
    if (this.tabs.length < 2) return;
    const index = this.tabs.indexOf(this.active);
    void this.activate(
      this.tabs[(index + direction + this.tabs.length) % this.tabs.length],
    );
  }

  tabTitle(tab: Tab): string {
    return tab.path ? basename(tab.path) : t("Neuer Tab");
  }

  // ── navigation ────────────────────────────────────────────────────────────

  async openPath(path: string, options: OpenOptions = {}): Promise<void> {
    if (!this.store || this.store.isDeleting(path)) return;
    const session = this.compatibility;
    const file = session?.vault.getFileByPath(path);
    if (session && file && !options.pluginState && !attachmentKind(path)) {
      const leaf = session.workspace.getLeaf(options.newTab ? "tab" : false);
      await leaf.openFile(file);
      return;
    }
    if (this.isMobile) this.closeDrawers();
    if (!options.newTab) {
      if (this.active.path === path && this.active.loaded &&
        (!options.pluginState || (this.active.viewType ?? "markdown") === options.pluginState.type)) {
        this.applyReveal(options.reveal);
        if (!options.keepFocus) this.focusView();
        return;
      }
      const existing = this.tabs.find((tab) => tab.path === path &&
        (!options.pluginState || (tab.viewType ?? "markdown") === options.pluginState.type));
      if (existing) {
        await this.activate(existing, options.reveal);
        if (!options.keepFocus) this.focusView();
        return;
      }
    }
    let tab = this.active;
    if (options.newTab) {
      this.park();
      tab = this.makeTab();
      this.tabs.splice(this.tabs.indexOf(this.active) + 1, 0, tab);
      this.active = tab;
    }
    const request = tab.request + 1;
    await this.loadInto(tab, path, true, options.pluginState?.type);
    if (tab.request !== request) return;
    if (tab === this.active) {
      this.showActive(options.reveal);
      if (!options.keepFocus) this.focusView();
    }
    this.emit("tabs");
    this.saveWorkspace();
  }

  /** Reads `path` into `tab`; on failure the tab keeps what it showed before. */
  private async loadInto(tab: Tab, path: string, push: boolean, requestedViewType?: string): Promise<void> {
    const store = this.store;
    if (!store) return;
    const request = ++tab.request;
    const leaving = tab.note;
    if (leaving && leaving.text !== leaving.saved)
      void this.save(leaving).catch((error) => this.report(error));
    const viewType = requestedViewType === "markdown" ? null : requestedViewType ??
      this.compatibility?.services.getViewTypeForExtension(extension(path)) ?? null;
    const attachment = viewType ? null : attachmentKind(path);
    let note: Note | null = null;
    if (!viewType && !attachment) {
      try {
        note = await store.load(path);
      } catch (error) {
        this.report(error);
        return;
      }
      if (request !== tab.request || store !== this.store) return;
    }
    if (tab === this.active && this.pluginView?.leaf !== this.requestedPluginLeaf) this.unmountPluginView();
    tab.path = path;
    tab.note = note;
    tab.kind = viewType ? "plugin" : isCanvas(path) ? "canvas" : attachment ? "attachment" : "markdown";
    tab.viewType = viewType;
    tab.loaded = true;
    tab.state = null;
    tab.scroll = 0;
    tab.previewScroll = 0;
    if (push && tab.history[tab.historyIndex] !== path) {
      tab.history.splice(tab.historyIndex + 1);
      tab.history.push(path);
      tab.historyIndex = tab.history.length - 1;
    }
    if (note) {
      this.index.setContent(path, note.text);
      if (note.recovered)
        notify(
          t("Ein ungespeicherter Entwurf wurde wiederhergestellt. Prüfe ihn vor dem Speichern."),
        );
    }
    this.ws.recent = [path, ...this.ws.recent.filter((p) => p !== path)].slice(
      0,
      30,
    );
  }

  async navigateHistory(delta: 1 | -1): Promise<void> {
    const tab = this.active;
    const index = tab.historyIndex + delta;
    const path = tab.history[index];
    if (!path) return;
    if (!this.index.has(path)) {
      notify(t("Diese Notiz ist nicht mehr vorhanden."));
      return;
    }
    const request = tab.request + 1;
    await this.loadInto(tab, path, false);
    if (tab.request !== request || !tab.loaded) return;
    tab.historyIndex = index;
    if (tab === this.active) this.showActive();
    this.emit("tabs");
    this.saveWorkspace();
  }

  previewLink(target: string, source: string, anchor: DOMRect): void {
    this.linkPreview.show(target, source, anchor);
  }

  hideLinkPreview(): void {
    this.linkPreview.hide();
  }

  /** Follows a `[[link]]`; unresolved links create the note, as in Obsidian. */
  openLink(target: string, source: string, newTab = false): void {
    const hash = target.indexOf("#");
    const heading = hash >= 0 ? target.slice(hash + 1).replace(/^\^/, "") : "";
    const resolved = this.index.resolve(target, source);
    if (resolved) {
      void this.openPath(resolved, {
        newTab,
        reveal: heading ? { heading } : undefined,
      });
      return;
    }
    const name = (hash >= 0 ? target.slice(0, hash) : target).trim();
    if (!name || (extension(name) && extension(name) !== "md")) {
      notify(t("Diese Datei oder Einbettung ist noch nicht vorhanden."));
      return;
    }
    void this.createNote(name, { newTab });
  }

  /** Browser demo: SVG images live as text in the demo vault. */
  async demoImage(path: string): Promise<string | null> {
    if (native || !/\.svg$/i.test(path) || !this.index.has(path)) return null;
    return backend.read(path);
  }

  openExternal(url: string): void {
    // SECURITY.md: external links are never opened automatically.
    const copied = navigator.clipboard?.writeText(url);
    if (copied)
      void copied.then(
        () =>
          notify(
            t("Externe Links werden nicht automatisch geöffnet. Adresse kopiert."),
          ),
        () =>
          notify(
            t("Externe Links werden aus Sicherheitsgründen nicht automatisch geöffnet."),
          ),
      );
    else
      notify(
        t("Externe Links werden aus Sicherheitsgründen nicht automatisch geöffnet."),
      );
  }

  searchFor(query: string): void {
    this.showPanel("search");
    this.search.setQuery(query);
  }

  /** Headings, or block ids when asked for those, that `[[target#` can name. */
  private subpathCandidates(
    target: string,
    blocks: boolean,
  ): Array<{ label: string; detail?: string }> {
    const source = this.activePath;
    if (!source) return [];
    const path = target.trim() ? this.index.resolve(target, source) : source;
    if (!path || !/\.md$/i.test(path)) return [];
    const text =
      this.store?.notes.get(path)?.text ?? this.index.content(path) ?? "";
    if (!blocks) {
      const seen = new Set<string>();
      return documentOutline(text)
        .filter((entry) => !seen.has(entry.text) && seen.add(entry.text))
        .map((entry) => ({ label: entry.text, detail: `H${entry.depth}` }));
    }
    const ids: Array<{ label: string; detail?: string }> = [];
    for (const line of text.split("\n")) {
      const id = /\s\^([A-Za-z0-9-]+)\s*$/.exec(line);
      if (id)
        ids.push({
          label: id[1],
          detail: line.slice(0, id.index).trim().slice(0, 60),
        });
    }
    return ids;
  }

  private linkCandidates(): Array<{
    link: string;
    detail: string;
    alias?: string;
  }> {
    const counts = new Map<string, number>();
    const notes = this.index.files.filter((path) => /\.md$/i.test(path));
    for (const path of notes) {
      const name = basename(path).toLowerCase();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return notes.flatMap((path) => {
      const name = basename(path);
      // Ambiguous names need the full path to resolve.
      const unique = counts.get(name.toLowerCase()) === 1;
      const link = unique ? name : path.replace(/\.md$/i, "");
      return [
        { link, detail: dirname(path) },
        // An alias links to the note and shows the alias: [[Note|Alias]].
        ...this.index
          .aliasesOf(path)
          .map((alias) => ({ link, alias, detail: `→ ${name}` })),
      ];
    });
  }

  // ── view ──────────────────────────────────────────────────────────────────

  /** Brings the main view in line with the active tab. */
  private showActive(reveal?: Reveal): void {
    const tab = this.active;
    const shell = this.shell;
    if (this.pluginView && this.pluginView.tab !== tab)
      this.unmountPluginView();
    const note = tab.kind === "markdown" ? tab.note : null;
    shell.empty.hidden = tab.kind !== "empty";
    shell.pluginView.hidden = tab.kind !== "plugin";
    shell.canvasHost.hidden = tab.kind !== "canvas";
    shell.attachmentHost.hidden = tab.kind !== "attachment";
    if (tab.kind === "attachment") void this.showAttachment(tab);
    else this.clearAttachment();
    if (tab.kind === "canvas" && tab.note && tab.path) this.showCanvas(tab);
    else this.canvasView?.suspend();
    shell.editorEl.hidden = !note || tab.reading;
    shell.previewEl.hidden = !note || !tab.reading;
    if (note && tab.path) {
      let state = tab.state;
      if (
        !state ||
        state.doc.length !== note.text.length ||
        state.doc.toString() !== note.text
      )
        state = this.editor.createState(note.text);
      tab.state = null;
      const fresh = state !== this.editor.state;
      this.editor.setEditable(!this.store?.isDeleting(tab.path));
      if (fresh)
        this.editor.setState(
          state,
          this.settings.get("inlineTitle") ? basename(tab.path) : null,
        );
      else
        this.editor.setTitle(
          this.settings.get("inlineTitle") ? basename(tab.path) : null,
        );
      if (tab.reading) {
        this.editor.releasePluginBlocks();
        this.reading.render(tab.path, note.text);
        shell.previewEl.scrollTop = tab.previewScroll;
      } else {
        this.editor.refreshPluginBlocks();
        // Hidden plugin render children must not keep listeners/canvases alive
        // after switching back to the editor or to another editing tab.
        this.reading.clear();
        if (fresh) {
          const scroll = tab.scroll;
          this.editor.view.requestMeasure({
            read: () => null,
            write: () => {
              this.editor.view.scrollDOM.scrollTop = scroll;
            },
          });
        }
      }
    } else {
      this.editor.releasePluginBlocks();
      this.editor.setEditable(false);
      this.reading.clear();
    }
    if (tab.kind === "empty") this.renderEmpty();
    if (tab.kind !== "plugin") this.compatibility?.setActivePath(
      tab.kind === "attachment" ? tab.path : note ? tab.path : null,
    );
    if (tab.kind === "plugin" && this.pluginView?.tab !== tab) {
      this.pluginViewReady = this.mountPluginView(tab);
      void this.pluginViewReady.catch(error => this.report(error));
    }
    document.title = tab.path ? `${basename(tab.path)} — Basalt` : "Basalt";
    this.emit("active");
    this.applyReveal(reveal);
  }

  private showCanvas(tab: Tab): void {
    const note = tab.note!;
    if (!this.canvasView) {
      this.canvasView = new CanvasView({
        files: () => this.index.files,
        resolve: (target, source) => this.index.resolve(target, source),
        noteText: (path) => this.index.content(path),
        openFile: (path, newTab) => void this.openPath(path, { newTab }),
        openLink: (target, source, newTab) =>
          this.openLink(target, source, newTab),
        openExternal: (url) => this.openExternal(url),
        onChange: (path, text) => this.onCanvasChange(path, text),
      });
      this.shell.canvasHost.append(this.canvasView.el);
      this.on("index", () => {
        if (this.active.kind === "canvas") this.canvasView?.refreshPreviews();
      });
    }
    this.canvasView.load(tab.path!, note.text);
  }

  /** Renders a directly opened attachment using vault-scoped binary reads. */
  private showAttachment(tab: Tab): Promise<void> {
    return this.attachmentView.show(tab.path, this.compatibility);
  }

  private clearAttachment(): void {
    this.attachmentView.clear();
  }

  /** Canvas edits go through the note store like typing, with drafts and autosave. */
  private onCanvasChange(path: string, text: string): void {
    const store = this.store;
    const note = store?.notes.get(path);
    if (!note || !store) return;
    const wasDirty = note.text !== note.saved;
    try {
      store.edit(note, text);
    } catch (error) {
      this.report(error);
    }
    if (wasDirty !== (note.text !== note.saved)) this.emit("tabs");
    this.index.setContent(note.path, text);
    if (note === this.activeDocument)
      this.setSaveStatus("dirty", t("Ungespeicherte Änderungen"));
    this.scheduleSave(note);
    // Other groups may mirror the same canvas.
    if (this.groups.length > 1) this.renderGroups();
  }

  private applyReveal(reveal?: Reveal): void {
    const tab = this.active;
    const note = this.activeNote;
    if (!reveal || !note) return;
    let offset = reveal.offset;
    if (reveal.heading) {
      const wanted = reveal.heading.trim().toLowerCase();
      const entry = documentOutline(note.text).find(
        (heading) => heading.text.trim().toLowerCase() === wanted,
      );
      if (tab.reading && this.reading.scrollToHeading(reveal.heading)) return;
      if (!entry) return;
      offset = entry.offset;
    }
    if (offset === undefined) return;
    if (tab.reading) {
      const el = this.shell.previewEl;
      el.scrollTop =
        (offset / Math.max(1, note.text.length)) *
        (el.scrollHeight - el.clientHeight);
    } else this.editor.reveal(offset, reveal.length ?? 0);
  }

  focusView(): void {
    if (this.isMobile) return;
    if (this.active.kind === "canvas") this.canvasView?.focus();
    else if (this.activeNote && !this.active.reading) this.editor.focus();
    else if (this.activeNote)
      this.shell.previewEl.focus({ preventScroll: true });
  }

  setReading(reading: boolean, tab: Tab = this.active): void {
    if (tab.reading === reading) return;
    if (tab === this.active) {
      // Keep roughly the same place in the document across the switch.
      const note = this.activeNote;
      const el = this.shell.previewEl;
      const scroller = this.editor.view.scrollDOM;
      let ratio = 0;
      if (note) {
        const from = reading ? scroller : el;
        ratio =
          from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
      }
      tab.reading = reading;
      this.showActive();
      if (note) {
        const to = reading ? el : scroller;
        to.scrollTop = ratio * Math.max(0, to.scrollHeight - to.clientHeight);
      }
      this.focusView();
    } else tab.reading = reading;
    this.saveWorkspace();
  }

  private renderEmpty(): void {
    const action = (text: string, command: string) => {
      const hotkey = this.commands.hotkeyOf(command);
      return h("button", {
        class: "empty-state-action",
        text: hotkey ? `${text} (${formatHotkey(hotkey)})` : text,
        attrs: { type: "button" },
        data: { command },
      });
    };
    const hasNotes = this.index.files.length > 0;
    this.shell.empty.replaceChildren(
      h(
        "div",
        "empty-state-container",
        h("h1", {
          class: "empty-state-title",
          text: !this.vault
            ? t("Vault wird geöffnet …")
            : hasNotes
              ? t("Keine Datei geöffnet")
              : t("Dein nächster Gedanke."),
        }),
        hasNotes || !this.vault
          ? null
          : h("p", {
              class: "empty-state-description",
              text: t("Dieser Vault ist noch leer. Eine Notiz ist alles, was du zum Loslegen brauchst."),
            }),
        this.vault
          ? h(
              "div",
              "empty-state-action-list",
              hasNotes
                ? action(t("Neue Notiz erstellen"), "new-note")
                : h("button", {
                    class: "empty-state-action mod-cta",
                    text: t("Erste Notiz anlegen"),
                    attrs: { type: "button" },
                    data: { command: "new-note" },
                  }),
              hasNotes ? action(t("Datei öffnen"), "quick-switcher") : null,
              hasNotes ? action(t("Heutige Tagesnotiz"), "daily-note") : null,
              hasNotes ? action(t("Neue Canvas erstellen"), "new-canvas") : null,
              this.allTabs.length > 1 ? action(t("Schließen"), "close-tab") : null,
            )
          : null,
      ),
    );
  }

  private updateHeader(): void {
    const tab = this.active;
    const shell = this.shell;
    const folder = tab.path ? dirname(tab.path) : "";
    shell.breadcrumb.replaceChildren(
      ...folder
        .split("/")
        .filter(Boolean)
        .flatMap((part) => [
          h("span", { class: "view-header-breadcrumb-part", text: part }),
          h("span", { class: "view-header-breadcrumb-separator", text: "/" }),
        ]),
    );
    shell.title.textContent = this.tabTitle(tab);
    const note = this.activeNote;
    shell.modeButton.hidden = !note;
    shell.moreButton.hidden = !tab.path;
    shell.modeButton.replaceChildren(
      icon(tab.reading ? "pencil" : "book-open"),
    );
    shell.modeButton.setAttribute(
      "aria-label",
      tab.reading ? t("Bearbeiten") : t("Leseansicht"),
    );
    shell.backButton.disabled = tab.historyIndex <= 0;
    shell.forwardButton.disabled = tab.historyIndex >= tab.history.length - 1;
    shell.workspace.classList.toggle("is-reading", !!note && tab.reading);
  }

  // ── status bar ────────────────────────────────────────────────────────────

  private setSaveStatus(
    state: "saved" | "dirty" | "saving" | "error" | "idle",
    message: string,
  ): void {
    const el = this.shell.saveStatus;
    if (el.dataset.state === state && el.getAttribute("aria-label") === message)
      return;
    el.dataset.state = state;
    el.setAttribute("aria-label", message);
    el.replaceChildren(
      icon(
        state === "error"
          ? "triangle-alert"
          : state === "saved"
            ? "check"
            : state === "idle"
              ? "circle"
              : "circle-dot",
        14,
      ),
      h("span", { class: "sr-only", text: message }),
    );
  }

  updateStatus(): void {
    const tab = this.active;
    const note = this.activeDocument;
    const shell = this.shell;
    const failure = note ? this.failed.get(note.path) : undefined;
    shell.saveWarning.hidden = failure === undefined;
    if (failure !== undefined)
      shell.saveWarningText.textContent = t("Speichern fehlgeschlagen. {error} Dein Entwurf bleibt erhalten.", { error: failure });
    const markdown = tab.kind === "markdown" && !!note;
    shell.wordCount.hidden = shell.charCount.hidden = !markdown;
    shell.backlinkCount.hidden = !markdown;
    if (!note) {
      this.setSaveStatus(
        "idle",
        tab.kind === "plugin"
          ? t("Plugin-Ansicht geöffnet")
          : this.vault && !this.index.files.length
            ? t("Leerer Vault · neue Notiz anlegen")
            : t("Bereit"),
      );
      return;
    }
    if (this.failed.has(note.path))
      this.setSaveStatus(
        "error",
        t("Nicht gespeichert · Entwurf bleibt erhalten"),
      );
    else if (note.text !== note.saved)
      this.setSaveStatus(
        "dirty",
        note.recovered
          ? t("Entwurf wiederhergestellt · noch nicht gespeichert")
          : t("Ungespeicherte Änderungen"),
      );
    else this.setSaveStatus("saved", t("Alle Änderungen gespeichert"));
    if (!markdown) return;
    // With a selection, the counts are about the selected text, as in Obsidian.
    const counted = this.selected && !tab.reading ? this.selected : note.text;
    const words = wordCount(counted);
    const wordText = plural(words, {
      one: "{count} Wort",
      other: "{count} Wörter",
    });
    const charText = plural(counted.length, {
      one: "{count} Schriftzeichen",
      other: "{count} Zeichen",
    });
    shell.wordCount.textContent =
      counted === note.text ? wordText : t("{count} ausgewählt", { count: wordText });
    shell.charCount.textContent = charText;
    this.updateBacklinkCount();
  }

  private updateBacklinkCount(): void {
    const path = this.activeNote?.path;
    if (!path) return;
    const count = new Set(
      this.index.backlinks(path).map((mention) => mention.source),
    ).size;
    this.shell.backlinkCount.textContent = plural(count, {
      one: "{count} Rückverweis",
      other: "{count} Rückverweise",
    });
  }

  // ── editing and saving ────────────────────────────────────────────────────

  private onEditorChange(text: string): void {
    const note = this.activeNote;
    const store = this.store;
    if (!note || !store) return;
    const wasDirty = note.text !== note.saved;
    try {
      store.edit(note, text);
    } catch (error) {
      this.report(error);
    }
    if (wasDirty !== (note.text !== note.saved)) this.emit("tabs");
    this.setSaveStatus("dirty", t("Ungespeicherte Änderungen"));
    this.scheduleSave(note);
    this.docEdited();
  }

  /** Runs shortly after typing stops: re-index, counts, panels. */
  private flushDoc(): void {
    const note = this.activeNote;
    if (!note) return;
    this.index.setContent(note.path, note.text);
    this.updateStatus();
    if (this.active.reading) this.reading.render(note.path, note.text);
    // Other groups may mirror the same note.
    if (this.groups.length > 1) this.renderGroups();
    this.emit("doc");
  }

  private scheduleSave(note: Note): void {
    clearTimeout(this.saveTimers.get(note));
    this.saveTimers.set(
      note,
      setTimeout(() => {
        void this.save(note).catch((error) => {
          // The banner above the active note already explains the failure.
          if (note === this.activeDocument) console.warn(error);
          else this.report(error);
        });
      }, 800),
    );
  }

  /** `backup: true` always backs up the replaced content (see `NoteStore.save`). */
  async save(
    note: Note | null = this.activeNote,
    options: { backup?: boolean } = {},
  ): Promise<void> {
    const store = this.store;
    if (!note || !store) return;
    clearTimeout(this.saveTimers.get(note));
    this.saveTimers.delete(note);
    if (note === this.activeDocument && note.text !== note.saved)
      this.setSaveStatus("saving", t("Wird gespeichert …"));
    try {
      await store.save(note, options);
      this.failed.delete(note.path);
      this.savedPaths.add(note.path);
      this.refreshCompatLater();
    } catch (error) {
      this.failed.set(note.path, errorMessage(error));
      throw error;
    } finally {
      if (store === this.store && store.notes.get(note.path) === note) {
        this.index.setContent(note.path, note.text);
        if (note === this.activeDocument) this.updateStatus();
        this.emit("tabs");
      }
    }
  }

  /** Discards nothing: the local version is archived before the file is reloaded. */
  async reloadFromDisk(): Promise<void> {
    const note = this.activeDocument;
    const store = this.store;
    const tab = this.active;
    if (!note || !store) return;
    clearTimeout(this.saveTimers.get(note));
    this.saveTimers.delete(note);
    try {
      const fresh = await store.reload(note.path);
      if (store !== this.store) return;
      this.failed.delete(note.path);
      for (const other of this.allTabs)
        if (other.note === note) {
          other.note = fresh;
          other.state = null;
        }
      this.index.setContent(fresh.path, fresh.text);
      if (tab === this.active) {
        if (tab.kind === "canvas") this.canvasView?.setText(fresh.text);
        else {
          this.editor.setText(fresh.text);
          if (tab.reading) this.reading.render(fresh.path, fresh.text);
        }
        this.updateStatus();
      }
      this.emit("tabs");
      notify(
        t("Dateistand geladen. Die lokale Fassung findest du als archivierten Entwurf in den Einstellungen."),
      );
    } catch (error) {
      this.report(error);
    }
  }

  /**
   * Replaces a document's content with a backup through the normal,
   * version-checked save, so the replaced content becomes a backup itself.
   * Unsaved edits are saved first; if that fails, nothing is replaced.
   */
  async restoreVersion(path: string, text: string): Promise<void> {
    const store = this.store;
    if (!store) throw new Error(t("Kein Vault geöffnet."));
    const note = await store.load(path);
    if (store !== this.store) throw new Error(t("Der Vault wurde inzwischen gewechselt."));
    if (note.text !== note.saved) await this.save(note);
    if (note.text === text) return;
    await this.replaceText(note, text);
  }

  /**
   * Turns a plain-text mention of `target` in `source` into a link. Refuses
   * when the text at that place no longer names the target.
   */
  async linkMention(
    source: string,
    place: { line: number; col: number; length: number },
    target: string,
  ): Promise<void> {
    const store = this.store;
    if (!store) throw new Error(t("Kein Vault geöffnet."));
    const note = await store.load(source);
    const lines = note.text.split("\n");
    const line = lines[place.line] ?? "";
    const written = line.slice(place.col, place.col + place.length);
    const name = basename(target);
    if (
      !this.index
        .namesOf(target)
        .some((candidate) => candidate.toLowerCase() === written.toLowerCase())
    )
      throw new Error(t("Die Stelle hat sich inzwischen geändert. Bitte erneut versuchen."));
    const link =
      this.index.resolve(name, source) === target
        ? name
        : target.replace(/\.md$/i, "");
    lines[place.line] =
      line.slice(0, place.col) +
      (link === written ? `[[${link}]]` : `[[${link}|${written}]]`) +
      line.slice(place.col + place.length);
    await this.replaceText(note, lines.join("\n"));
  }

  /** Saves new content for a loaded document and shows it wherever it is open. */
  private async replaceText(note: Note, text: string): Promise<void> {
    const store = this.store;
    if (!store) throw new Error(t("Kein Vault geöffnet."));
    store.edit(note, text);
    // Restores and link updates are not typing: always keep what they replace.
    await this.save(note, { backup: true });
    for (const tab of this.allTabs) if (tab.note === note) tab.state = null;
    if (this.activeDocument === note) {
      if (this.active.kind === "canvas") this.canvasView?.setText(text);
      else {
        this.editor.setText(text);
        if (this.active.reading) this.reading.render(note.path, text);
      }
      this.updateStatus();
    }
    this.renderGroups();
    this.emit("tabs");
  }

  /**
   * The notes and canvases whose links a move would break, read from the
   * index (files it has not read yet are read now). Paths before the move.
   */
  private async linkSources(update: LinkUpdate): Promise<string[]> {
    const vault = this.vault;
    const sources: string[] = [];
    for (const path of this.index.files) {
      if (!/\.(md|canvas)$/i.test(path)) continue;
      if (!this.index.metaOf(path) && vault) {
        const text =
          this.store?.notes.get(path)?.text ?? (await backend.read(path, vault.id));
        this.index.setContent(path, text, true);
      }
      const meta = this.index.metaOf(path);
      if (meta && update.affects(path, meta.links)) sources.push(path);
    }
    return sources;
  }

  /**
   * Rewrites links after a move, one file at a time through the normal,
   * version-checked save (each file gets a backup). Files that fail keep
   * their content; the user is told which.
   */
  private async updateLinks(update: LinkUpdate, sources: string[]): Promise<void> {
    const store = this.store;
    if (!store) return;
    let updated = 0;
    const failed: string[] = [];
    for (const source of sources) {
      const path = update.moved(source);
      try {
        const note = await store.load(path);
        if (store !== this.store) return;
        const next = update.rewrite(note.text, source);
        if (next === null) continue;
        await this.replaceText(note, next);
        updated++;
      } catch (error) {
        failed.push(path);
        console.warn(error);
      }
    }
    if (updated)
      notify(
        plural(updated, {
          one: "Links in {count} Datei aktualisiert.",
          other: "Links in {count} Dateien aktualisiert.",
        }),
      );
    if (failed.length)
      notify(
        t("Links in {files} konnten nicht aktualisiert werden. Die Dateien sind unverändert.", {
          files: failed.map((path) => `„${basename(path)}“`).join(", "),
        }),
        true,
      );
  }

  /**
   * Rewrites notes one by one through the store, like a link update: each
   * replaced text is backed up and saved version-checked, and a failed note
   * stays unchanged. `rewrite` returns null to leave a note alone.
   */
  async rewriteNotes(
    paths: string[],
    rewrite: (text: string, path: string) => string | null,
  ): Promise<{ updated: string[]; failed: string[] }> {
    const store = this.store;
    const updated: string[] = [];
    const failed: string[] = [];
    if (!store) return { updated, failed };
    for (const path of paths) {
      try {
        const note = await store.load(path);
        if (store !== this.store) break;
        const next = rewrite(note.text, path);
        if (next === null || next === note.text) continue;
        await this.replaceText(note, next);
        this.index.setContent(path, next);
        updated.push(path);
      } catch (error) {
        failed.push(path);
        console.warn(error);
      }
    }
    return { updated, failed };
  }

  /**
   * Creates a deleted document again. It is never written over an existing
   * file: a taken name gets a "(restored)" copy instead. Returns the path.
   */
  async restoreDeleted(path: string, text: string): Promise<string> {
    const vault = this.vault;
    if (!vault) throw new Error(t("Kein Vault geöffnet."));
    const dot = path.lastIndexOf(".");
    const stem = path.slice(0, dot);
    const extension = path.slice(dot);
    let target = path;
    for (let n = 1; this.index.has(target); n++)
      target = `${stem} (${t("wiederhergestellt")}${n > 1 ? ` ${n}` : ""})${extension}`;
    await backend.create(target, text, vault.id);
    if (vault !== this.vault) return target;
    this.setFiles((await backend.info()).files);
    await this.refreshCompatibility().catch((error) => this.report(error));
    if (this.compatibility) this.syncVisibleFiles();
    return target;
  }

  exportNote(path = this.activePath): void {
    if (!path) return;
    const text = this.store?.notes.get(path)?.text ?? this.index.content(path);
    if (text === undefined) return;
    void backend
      .export(path, text)
      .then((done) => {
        if (done) notify(t("Markdown-Datei exportiert."));
      })
      .catch((error) => this.report(error));
  }

  /** Flips the n-th task checkbox of the active note (used by the reading view). */
  toggleTask(n: number): void {
    const note = this.activeNote;
    if (!note || n < 0) return;
    let fence: string | null = null;
    let offset = 0;
    let seen = 0;
    for (const line of note.text.split("\n")) {
      const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (delimiter) {
        if (!fence) fence = delimiter[1];
        else if (
          delimiter[1][0] === fence[0] &&
          delimiter[1].length >= fence.length
        )
          fence = null;
      } else if (!fence) {
        const task = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)(.)\]\s/.exec(line);
        if (task && seen++ === n) {
          const at = offset + task[1].length;
          this.editor.view.dispatch({
            changes: {
              from: at,
              to: at + 1,
              insert: task[2] === " " ? "x" : " ",
            },
          });
          this.docEdited.flush();
          return;
        }
      }
      offset += line.length + 1;
    }
  }

  // ── creating notes ────────────────────────────────────────────────────────

  promptDeleteFile(path: string): void {
    const store = this.store;
    if (!store || !this.index.has(path) || store.isDeleting(path)) return;
    const modal = new Modal();
    modal.setTitle(t("Datei löschen"));
    const error = h("p", {
      class: "field-error",
      attrs: { role: "alert", hidden: true },
    });
    const cancel = h("button", {
      text: t("Abbrechen"),
      on: { click: () => modal.close() },
    });
    const submit = h("button", {
      text: t("In Papierkorb verschieben"),
      class: "mod-warning",
    });
    submit.addEventListener("click", () => {
      cancel.disabled = submit.disabled = true;
      void this.deleteFile(path, store)
        .then(() => modal.close())
        .catch((reason) => {
          error.textContent = errorMessage(reason);
          error.hidden = false;
          cancel.disabled = submit.disabled = false;
        });
    });
    modal.contentEl.append(
      h("p", {
        text: t("„{path}“ in den Vault-Papierkorb verschieben? Eine Sicherung bleibt in .basalt/trash/.", { path }),
      }),
      h("p", {
        class: "modal-description",
        text: t("Plugin-Dateien vorher speichern. Die Sicherung enthält den zuletzt gespeicherten Dateistand und lässt sich über die Dateiwiederherstellung zurückholen."),
      }),
      error,
      h("div", "modal-button-container", cancel, submit),
    );
    modal.open();
    cancel.focus();
  }

  private async deleteFile(path: string, store: NoteStore): Promise<void> {
    if (store !== this.store)
      throw new Error(t("Der Vault wurde inzwischen gewechselt."));
    const note = store.notes.get(path);
    if (note) {
      clearTimeout(this.saveTimers.get(note));
      this.saveTimers.delete(note);
    }
    this.releasePluginUi();
    const removing = store.remove(path);
    if (this.active.path === path) this.editor.setEditable(false);
    try {
      await removing;
      if (store !== this.store) return;
      for (const tab of this.allTabs) {
        const before = tab.history
          .slice(0, tab.historyIndex + 1)
          .filter((entry) => entry !== path).length;
        tab.history = tab.history.filter((entry) => entry !== path);
        tab.historyIndex = before - 1;
        if (tab.path !== path) continue;
        tab.request++;
        tab.path = null;
        tab.kind = "empty";
        tab.viewType = null;
        tab.note = null;
        tab.state = null;
        tab.loaded = true;
      }
      this.failed.delete(path);
      this.ws.bookmarks = this.ws.bookmarks.filter((entry) => entry !== path);
      this.ws.recent = this.ws.recent.filter((entry) => entry !== path);
      this.setFiles(this.index.files.filter((entry) => entry !== path));
      this.emit("bookmarks");
      this.emit("tabs");
      this.saveWorkspace();
      await this.refreshCompatibility().catch((error) => this.report(error));
    } finally {
      if (store === this.store) this.showActive();
    }
  }

  /** Asks for a folder and moves the file there, links and all. */
  promptMoveFile(path: string): void {
    if (!this.index.has(path)) return;
    const current = dirname(path);
    const folders = ["", ...this.explorer.folderPaths()].filter(
      (folder) => folder !== current,
    );
    const modal = new SuggestModal(
      t("Ordner suchen …"),
      t("Datei verschieben nach"),
      (raw) => {
        const query = raw.trim().toLowerCase();
        return folders
          .filter((folder) => (folder || "/").toLowerCase().includes(query))
          .map((folder) => ({
            render(parent: HTMLElement) {
              parent.append(
                h(
                  "div",
                  "suggestion-content",
                  h("div", {
                    class: "suggestion-title",
                    text: folder || t("Oberste Ebene"),
                  }),
                ),
              );
            },
            run: () =>
              void this.moveFile(path, folder).catch((error) =>
                this.report(error),
              ),
          }));
      },
      [
        ["↑↓", t("navigieren")],
        ["↵", t("verschieben")],
        ["esc", t("schließen")],
      ],
      t("Kein passender Ordner."),
    );
    modal.open();
  }

  /** Moves a file into `folder` ("" is the vault root), keeping its name. */
  async moveFile(path: string, folder: string): Promise<void> {
    if (!this.store || !this.vault || !this.index.has(path)) return;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const target = folder ? `${folder}/${name}` : name;
    if (target === path) return;
    try {
      if (this.index.has(target))
        throw new Error(
          t("„{name}“ gibt es in {folder} bereits.", { name, folder: folder ? `„${folder}“` : t("der obersten Ebene") }),
        );
      await this.relocateFile(path, target, folder);
    } catch (error) {
      this.report(error);
    }
  }

  private promptRenameFile(path: string): void {
    if (!this.index.has(path)) return;
    const current = path.slice(path.lastIndexOf("/") + 1);
    const modal = new Modal("mod-rename");
    modal.setTitle(t("Datei umbenennen"));
    const input = h("input", {
      id: "rename-name",
      attrs: {
        type: "text",
        maxlength: "180",
        autocomplete: "off",
        spellcheck: "false",
        enterkeyhint: "done",
      },
      label: t("Neuer Dateiname"),
    });
    input.value = current;
    const error = h("p", {
      class: "field-error",
      attrs: { role: "alert", hidden: true },
    });
    const submit = h("button", {
      class: "mod-cta",
      text: t("Umbenennen"),
      attrs: { type: "submit" },
    });
    const form = h(
      "form",
      { attrs: { novalidate: true } },
      input,
      error,
      h(
        "div",
        "modal-button-container",
        h("button", {
          text: t("Abbrechen"),
          attrs: { type: "button" },
          on: { click: () => modal.close() },
        }),
        submit,
      ),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit.disabled = true;
      void this.renameFile(path, input.value)
        .then(() => modal.close())
        .catch((reason) => {
          error.textContent = errorMessage(reason);
          error.hidden = false;
          submit.disabled = false;
          input.focus();
          input.select();
        });
    });
    modal.contentEl.append(form);
    modal.open();
    const dot = current.lastIndexOf(".");
    input.focus();
    input.setSelectionRange(0, dot > 0 ? dot : current.length);
  }

  private async renameFile(path: string, rawName: string): Promise<void> {
    const name = rawName.trim();
    if (!name) throw new Error(t("Der Dateiname darf nicht leer sein."));
    if (/[\\/]/.test(name))
      throw new Error(t("Der Dateiname darf keine Ordnerpfade enthalten."));
    if (name === "." || name === "..")
      throw new Error(t("Der Dateiname ist ungültig."));
    const current = path.slice(path.lastIndexOf("/") + 1);
    const dot = current.lastIndexOf(".");
    const suffix = dot > 0 ? current.slice(dot) : "";
    const targetName =
      suffix && !name.toLowerCase().endsWith(suffix.toLowerCase())
        ? `${name}${suffix}`
        : name;
    const folder = dirname(path);
    const target = folder ? `${folder}/${targetName}` : targetName;
    if (target === path) return;
    if (this.index.has(target))
      throw new Error(t("„{name}“ gibt es in diesem Ordner bereits.", { name: targetName }));
    await this.relocateFile(path, target, folder);
  }

  /** Shared move/rename path; the caller checks the target does not exist. */
  private async relocateFile(
    path: string,
    target: string,
    folder: string,
  ): Promise<void> {
    const store = this.store;
    const vault = this.vault;
    if (!store || !vault || !this.index.has(path)) return;
    const update = this.settings.get("updateLinks")
      ? new LinkUpdate(this.index.files, new Map([[path, target]]))
      : null;
    // Find the affected files while the index still describes the old paths.
    const sources = update ? await this.linkSources(update) : [];
    if (store !== this.store) return;
    const note = store.notes.get(path);
    if (note) {
      // The move saves pending edits itself.
      clearTimeout(this.saveTimers.get(note));
      this.saveTimers.delete(note);
    }
    this.releasePluginUi();
    const moving = store.move(path, target);
    if (this.active.path === path) this.editor.setEditable(false);
    try {
      await moving;
      if (store !== this.store) return;
      const moved = (entry: string) => (entry === path ? target : entry);
      for (const tab of this.allTabs) {
        tab.history = tab.history.map(moved);
        if (tab.path === path) tab.path = target;
      }
      const failure = this.failed.get(path);
      this.failed.delete(path);
      if (failure !== undefined) this.failed.set(target, failure);
      this.ws.bookmarks = this.ws.bookmarks.map(moved);
      this.ws.recent = this.ws.recent.map(moved);
      if (folder) this.explorer.expand(folder);
      const files = (await backend.info()).files;
      if (store !== this.store) return;
      this.setFiles(files);
      if (note) this.index.setContent(target, note.text);
      await this.refreshCompatibility().catch((error) => this.report(error));
      if (this.compatibility) this.syncVisibleFiles();
      void this.indexFiles();
      this.emit("bookmarks");
      this.emit("tabs");
      this.saveWorkspace();
    } finally {
      if (store === this.store) this.showActive();
    }
    if (update && sources.length && store === this.store)
      await this.updateLinks(update, sources);
  }

  promptNewNote(folder?: string): void {
    if (!this.vault) return;
    const base =
      folder ??
      (this.settings.get("newNoteLocation") === "current" && this.activePath
        ? dirname(this.activePath)
        : "");
    const modal = new Modal("mod-new-note");
    modal.setTitle(t("Neue Notiz"));
    const input = h("input", {
      id: "new-name",
      attrs: {
        type: "text",
        placeholder: t("Name der Notiz"),
        maxlength: "180",
        autocomplete: "off",
        spellcheck: "false",
        enterkeyhint: "done",
      },
      label: t("Name der Notiz"),
    });
    input.value = base ? `${base}/` : "";
    const error = h("p", {
      class: "field-error",
      id: "new-error",
      attrs: { role: "alert", hidden: true },
    });
    const submit = h("button", {
      class: "mod-cta",
      text: t("Notiz anlegen"),
      attrs: { type: "submit" },
    });
    const form = h(
      "form",
      { attrs: { novalidate: true } },
      h("p", {
        class: "modal-description",
        text: t("Mit „Ordner/Name“ legst du die Notiz in einem Ordner an."),
      }),
      input,
      error,
      h(
        "div",
        "modal-button-container",
        h("button", {
          text: t("Abbrechen"),
          attrs: { type: "button" },
          on: { click: () => modal.close() },
        }),
        submit,
      ),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit.disabled = true;
      void this.createNote(input.value, { throwOnError: true })
        .then(() => modal.close())
        .catch((reason) => {
          error.textContent = errorMessage(reason);
          error.hidden = false;
          submit.disabled = false;
          input.focus();
        });
    });
    modal.contentEl.append(form);
    modal.open();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  async createNote(
    name: string,
    options: { newTab?: boolean; text?: string; throwOnError?: boolean } = {},
  ): Promise<string | null> {
    const vault = this.vault;
    if (!vault) return null;
    try {
      const path = validateNotePath(name);
      // With the inline title visible the file name already is the heading.
      const text =
        options.text ??
        (this.settings.get("inlineTitle") ? "" : `# ${basename(path)}\n\n`);
      await backend.create(path, text, vault.id);
      if (vault !== this.vault) return null;
      this.setFiles((await backend.info()).files);
      await this.refreshCompatibility().catch((error) => this.report(error));
      if (this.compatibility) this.syncVisibleFiles();
      await this.openPath(path, { newTab: options.newTab });
      if (this.active.path === path) {
        this.setReading(false);
        this.editor.view.dispatch({
          selection: { anchor: this.editor.view.state.doc.length },
        });
        if (!this.isMobile) this.editor.focus();
      }
      return path;
    } catch (error) {
      if (options.throwOnError) throw error;
      this.report(error);
      return null;
    }
  }

  /** Creates an empty canvas; names without extension get `.canvas`. */
  async createCanvas(folder?: string): Promise<string | null> {
    const vault = this.vault;
    if (!vault) return null;
    const base =
      folder ??
      (this.settings.get("newNoteLocation") === "current" && this.activePath
        ? dirname(this.activePath)
        : "");
    try {
      let path = "";
      for (let n = 0; ; n++) {
        const name = `${base ? `${base}/` : ""}${t("Unbenannt")}${n ? ` ${n}` : ""}`;
        path = validateCanvasPath(name);
        if (!this.index.has(path)) break;
      }
      await backend.create(path, emptyCanvas(), vault.id);
      if (vault !== this.vault) return null;
      this.setFiles((await backend.info()).files);
      await this.refreshCompatibility().catch((error) => this.report(error));
      if (this.compatibility) this.syncVisibleFiles();
      await this.openPath(path);
      return path;
    } catch (error) {
      this.report(error);
      return null;
    }
  }

  async createFolder(parent: string): Promise<void> {
    const session = this.compatibility;
    if (!session) return;
    const modal = new Modal("mod-new-note");
    modal.setTitle(t("Neuer Ordner"));
    const input = h("input", {
      label: t("Name des Ordners"),
      attrs: {
        type: "text",
        placeholder: t("Name des Ordners"),
        autocomplete: "off",
      },
    });
    input.value = parent ? `${parent}/` : "";
    const error = h("p", { class: "field-error", attrs: { hidden: true } });
    const form = h(
      "form",
      null,
      input,
      error,
      h(
        "div",
        "modal-button-container",
        h("button", {
          class: "mod-cta",
          text: t("Ordner anlegen"),
          attrs: { type: "submit" },
        }),
      ),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const path = input.value.trim().replace(/\/+$/, "");
      void session.vault
        .createFolder(path)
        .then(() => {
          modal.close();
          this.explorer.expand(path);
          this.emit("files");
        })
        .catch((reason) => {
          error.textContent = errorMessage(reason);
          error.hidden = false;
        });
    });
    modal.contentEl.append(form);
    modal.open();
  }

  insertTemplate(): void {
    if (this.active.kind !== "markdown") {
      notify(t("Vorlagen lassen sich nur in Markdown-Notizen einfügen."));
      return;
    }
    const paths = templatePaths(
      this.index.files,
      this.settings.get("templateFolder"),
    );
    if (!paths.length) {
      notify(t("Keine Markdown-Vorlagen unter _templates gefunden."));
      return;
    }
    const modal = new Modal("mod-template");
    modal.setTitle(t("Vorlage einfügen"));
    const list = h("div", "template-list");
    for (const path of paths)
      list.append(h("button", {
        class: "template-choice",
        text: path.replace(/^.*?_templates\//, ""),
        attrs: { type: "button" },
        on: { click: () => { modal.close(); void this.applyTemplate(path); } },
      }));
    modal.contentEl.append(list);
    modal.open();
  }

  private async applyTemplate(path: string): Promise<void> {
    if (!this.vault || this.active.kind !== "markdown") return;
    try {
      const file = this.compatibility?.vault.getFileByPath(path);
      const text = file
        ? await this.compatibility!.vault.cachedRead(file)
        : await backend.read(path, this.vault.id);
      if (this.active.kind !== "markdown") return;
      const insert = expandTemplate(
        text,
        basename(this.active.path ?? "").replace(/\.md$/i, ""),
      );
      const view = this.editor.view;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
      });
      this.focusView();
    } catch (error) {
      this.report(error);
    }
  }

  /** Path of the daily note for `date`, after the daily note settings. */
  dailyNotePath(date: Date): string {
    const folder = this.settings.get("dailyFolder").replace(/^\/+|\/+$/g, "");
    const name = formatDate(
      date,
      this.settings.get("dailyFormat").trim() || "YYYY-MM-DD",
      getLocale(),
    );
    return `${folder ? `${folder}/` : ""}${name}.md`;
  }

  /** The day a note stands for, if it is a daily note. */
  private dailyNoteDate(path: string): Date | null {
    const folder = this.settings.get("dailyFolder").replace(/^\/+|\/+$/g, "");
    const prefix = folder ? `${folder}/` : "";
    if (!path.startsWith(prefix) || !/\.md$/i.test(path)) return null;
    return parseDate(
      path.slice(prefix.length, -3),
      this.settings.get("dailyFormat").trim() || "YYYY-MM-DD",
      getLocale(),
    );
  }

  /** Opens the daily note for `date`, creating it (and its folders) from the template. */
  async dailyNote(date = new Date()): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    const path = this.dailyNotePath(date);
    if (this.index.has(path)) return this.openPath(path);
    try {
      const template = this.settings.get("dailyTemplate");
      const text =
        template && this.index.has(template)
          ? expandTemplate(
              await backend.read(template, vault.id),
              basename(path),
              date,
            )
          : undefined;
      await this.ensureFolder(dirname(path));
      await this.createNote(path, { text, throwOnError: true });
    } catch (error) {
      this.report(error);
    }
  }

  /** Steps to the closest earlier or later daily note that exists. */
  async adjacentDailyNote(direction: 1 | -1): Promise<void> {
    const from =
      (this.activePath ? this.dailyNoteDate(this.activePath) : null) ?? new Date();
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
    let best: { path: string; time: number } | null = null;
    for (const path of this.index.files) {
      const date = this.dailyNoteDate(path);
      if (!date) continue;
      const time = date.getTime();
      if (direction > 0 ? time <= day : time >= day) continue;
      if (!best || (direction > 0 ? time < best.time : time > best.time))
        best = { path, time };
    }
    if (best) await this.openPath(best.path);
    else
      notify(
        direction > 0
          ? t("Keine spätere Tagesnotiz gefunden.")
          : t("Keine frühere Tagesnotiz gefunden."),
      );
  }

  /** Creates the missing folders of `folder`, one level at a time. */
  private async ensureFolder(folder: string): Promise<void> {
    if (!folder) return;
    const existing = new Set(this.folders());
    const parts = folder.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      if (existing.has(path)) continue;
      // The browser demo has no folders of its own; files carry their path.
      if (!this.compatibility) return;
      await this.compatibility.vault.createFolder(path);
    }
  }

  // ── bookmarks ─────────────────────────────────────────────────────────────

  isBookmarked(path: string): boolean {
    return this.ws.bookmarks.includes(path);
  }

  toggleBookmark(path: string): void {
    this.ws.bookmarks = this.isBookmarked(path)
      ? this.ws.bookmarks.filter((entry) => entry !== path)
      : [...this.ws.bookmarks, path];
    this.saveWorkspace();
    this.emit("bookmarks");
  }

  persist(): void {
    this.saveWorkspace();
  }

  // ── plugin views ──────────────────────────────────────────────────────────

  /** Before a plugin unloads: release its view and rendered blocks. */
  releasePluginUi(): void {
    this.editor.releasePluginBlocks();
    this.unmountPluginView();
    this.reading.clear();
    for (const view of this.groupViews.values()) view.mirror.release();
  }

  /**
   * After plugins were enabled or disabled: tabs whose view type is gone become
   * empty, and the active view is rebuilt so code blocks reflect the change.
   */
  refreshPluginUi(): void {
    const session = this.compatibility;
    for (const tab of this.allTabs) {
      if (tab.kind !== "plugin" || !tab.path) continue;
      const viewType =
        session?.services.getViewTypeForExtension(extension(tab.path)) ?? null;
      if (viewType) {
        tab.viewType = viewType;
        continue;
      }
      if (tab === this.active) this.unmountPluginView();
      tab.path = null;
      tab.kind = "empty";
      tab.viewType = null;
      tab.history = [];
      tab.historyIndex = -1;
    }
    this.syncVisibleFiles();
    this.reading.clear();
    this.editor.refreshPluginBlocks();
    this.emit("tabs");
    this.showActive();
    this.saveWorkspace();
  }

  private unmountPluginView(): void {
    const current = this.pluginView;
    this.pluginView = null;
    this.shell.pluginView.replaceChildren();
    if (!current) return;
    current.leaf.detach();
    void this.compatibility?.workspace.flushPending().catch(error => this.report(error));
  }

  private async mountPluginView(tab: Tab): Promise<void> {
    const session = this.compatibility;
    const host = this.shell.pluginView;
    const fail = (message: string) => {
      host.textContent = message;
    };
    if (!session || !tab.path || !tab.viewType)
      return fail(t("Plugin-Ansichten benötigen die native App."));
    let file = session.vault.getFileByPath(tab.path);
    if (!file) {
      await session.vault.refresh();
      file = session.vault.getFileByPath(tab.path);
    }
    if (tab !== this.active || session !== this.compatibility) return;
    if (!file) return fail(t("Datei nicht im Vault gefunden: {path}", { path: tab.path }));
    const factory = session.services.getView(tab.viewType);
    if (!factory)
      return fail(t("Plugin-Ansicht nicht registriert: {type}", { type: tab.viewType ?? "" }));
    const leaf = this.requestedPluginLeaf ?? session.workspace.getLeaf("tab");
    let mounted: { tab: Tab; view: FileView; leaf: WorkspaceLeaf } | null = null;
    // A newer navigation or vault switch owns the host element by then.
    const stale = () => mounted !== null && this.pluginView !== mounted;
    try {
      host.replaceChildren(leaf.containerEl);
      await session.workspace.loadView(leaf, { type: tab.viewType, state: { file: file.path } }, leaf.containerEl);
      const view = leaf.view as FileView;
      mounted = { tab, view, leaf };
      this.pluginView = mounted;
      if (stale()) return;
    } catch (error) {
      if (stale()) return;
      this.report(error);
      fail(
        t("Plugin-Ansicht konnte nicht geöffnet werden: {error}", { error: errorMessage(error) }),
      );
    }
  }

  // ── layout ────────────────────────────────────────────────────────────────

  private get editorOptions(): EditorOptions {
    return {
      livePreview: this.settings.get("editingMode") === "live",
      lineNumbers: this.settings.get("lineNumbers"),
      spellcheck: this.settings.get("spellcheck"),
      autoPair: this.settings.get("autoPair"),
      properties: this.settings.get("propertiesInDocument"),
      folding: this.settings.get("folding"),
      vim: this.settings.get("vimMode"),
    };
  }

  private applyEditorSettings(): void {
    this.editor.configure(this.editorOptions);
  }

  applyLayout(): void {
    const { workspace, scrim } = this.shell;
    const mobile = this.isMobile;
    document.body.classList.toggle("is-mobile", mobile);
    document.body.classList.toggle("is-touch", this.touch.matches);
    document.body.classList.toggle("is-tablet", this.touch.matches && !mobile);
    if (!mobile) {
      this.drawer = null;
      this.mobilePanel = null;
    }
    const leftOpen = this.leftVisible;
    const rightOpen = this.rightVisible;
    const bottomOpen = this.bottomVisible;
    workspace.classList.toggle("is-left-open", leftOpen);
    workspace.classList.toggle("is-right-open", rightOpen);
    workspace.classList.toggle("is-bottom-open", bottomOpen);
    workspace.style.setProperty("--left-width", `${this.layout.leftWidth}px`);
    workspace.style.setProperty("--right-width", `${this.layout.rightWidth}px`);
    workspace.style.setProperty(
      "--bottom-height",
      `${this.layout.bottomHeight}px`,
    );
    workspace.style.setProperty("--left-bottom-height", `${this.layout.leftBottomHeight}px`);
    scrim.classList.toggle("is-visible", mobile && this.drawer !== null);
    this.shell.leftSplit.inert = !leftOpen;
    this.shell.rightSplit.inert = !rightOpen;
    this.shell.bottomSplit.inert = !bottomOpen;
    this.shell.leftBottomSplit.inert = !leftOpen || mobile;
    this.renderDock();
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(this.layout));
    } catch {
      // Layout is a convenience; ignore storage failures.
    }
    this.panels.refresh();
  }

  /** The dock layout as currently shown (phones fold the bottom area away). */
  private get shownDock(): DockLayout {
    const shown = effectiveDock(
      withoutPanels(this.layout.dock, this.layout.closedPanels),
      this.isMobile,
    );
    if (this.mobilePanel) {
      const area = areaOf(shown, this.mobilePanel);
      if (area) shown[area].active = this.mobilePanel;
    }
    return shown;
  }

  /** Moves the panel elements into the tab strips and boxes of their areas. */
  private renderDock(): void {
    const shown = this.shownDock;
    const { docks, panelTabs, panes } = this.shell;
    const draggable = String(!this.isMobile);
    this.shell.leftBottomSplit.classList.toggle("is-empty", shown["left-bottom"].panels.length === 0);
    this.shell.leftBottomHandle.hidden = shown["left-bottom"].panels.length === 0;
    for (const area of DOCK_AREAS) {
      const slot = shown[area];
      const ids = slot.panels as PanelId[];
      const { tabs, content, empty, add } = docks[area];
      add.hidden = this.layout.closedPanels.length === 0;
      syncChildren(tabs, [...ids.map((id) => panelTabs[id]), add]);
      syncChildren(content, [...ids.map((id) => panes[id]), empty]);
      empty.hidden = ids.length > 0;
      for (const id of ids) {
        const selected = slot.active === id;
        const tab = panelTabs[id];
        tab.classList.toggle("is-active", selected);
        tab.setAttribute("aria-selected", String(selected));
        tab.setAttribute("draggable", draggable);
        panes[id].hidden = !selected;
      }
    }
  }

  get leftVisible(): boolean {
    return this.isMobile ? this.drawer === "left" : this.layout.leftOpen;
  }

  get rightVisible(): boolean {
    if (this.isMobile) return this.drawer === "right";
    // A portrait tablet cannot fit both sidebars beside readable text.
    return this.layout.rightOpen && !(this.narrowTablet && this.layout.leftOpen);
  }

  private get narrowTablet(): boolean {
    return !this.isMobile && this.narrowTouch.matches;
  }

  get bottomVisible(): boolean {
    return !this.isMobile && this.layout.bottomOpen;
  }

  /** Whether a panel is currently on screen (its area is open and it is the active tab there). */
  isPanelVisible(id: PanelId): boolean {
    const shown = this.shownDock;
    const area = areaOf(shown, id);
    if (!area || shown[area].active !== id) return false;
    return area === "left" || area === "left-bottom"
      ? this.leftVisible
      : area === "right"
        ? this.rightVisible
        : this.bottomVisible;
  }

  toggleLeft(force?: boolean): void {
    const next = force ?? !this.leftVisible;
    if (this.isMobile) this.drawer = next ? "left" : null;
    else {
      this.layout.leftOpen = next;
      if (next && this.narrowTablet) this.layout.rightOpen = false;
    }
    this.applyLayout();
  }

  toggleRight(force?: boolean): void {
    const next = force ?? !this.rightVisible;
    if (this.isMobile) this.drawer = next ? "right" : null;
    else {
      this.layout.rightOpen = next;
      if (next && this.narrowTablet) this.layout.leftOpen = false;
    }
    this.applyLayout();
  }

  /** Phones show bottom panels in the right drawer, so the toggle opens that. */
  toggleBottom(force?: boolean): void {
    if (this.isMobile) {
      const first = this.layout.dock.bottom.active;
      if (first && (force ?? !this.rightVisible))
        this.mobilePanel = first as PanelId;
      this.toggleRight(force);
      return;
    }
    this.layout.bottomOpen = force ?? !this.layout.bottomOpen;
    this.applyLayout();
  }

  private openArea(area: DockArea): void {
    if (area === "left" || area === "left-bottom") this.toggleLeft(true);
    else if (area === "right") this.toggleRight(true);
    else this.toggleBottom(true);
  }

  closeDrawers(): void {
    if (this.drawer === null) return;
    this.drawer = null;
    this.applyLayout();
  }

  /** Activates a panel wherever it is docked and opens that area. */
  showPanel(id: PanelId): void {
    this.reopen(id);
    this.layout.dock = activatePanel(this.layout.dock, id);
    if (this.isMobile) this.mobilePanel = id;
    const area = areaOf(this.shownDock, id);
    if (area) this.openArea(area);
    if (id === "search") this.search.focus();
  }

  /**
   * Docks a panel into `area`, at `index` in its tab strip when given. Without
   * an index a panel that already lives there just becomes active.
   */
  movePanelTo(id: PanelId, area: DockArea, index?: number): void {
    this.reopen(id);
    if (index !== undefined) {
      // `index` counts the tabs on screen; closed panels still hold a place in
      // the stored list, so insert before the panel that is shown there.
      const shown = withoutPanels(this.layout.dock, this.layout.closedPanels);
      const anchor = shown[area].panels[index];
      index = anchor
        ? this.layout.dock[area].panels.indexOf(anchor)
        : this.layout.dock[area].panels.length;
    }
    if (index !== undefined || areaOf(this.layout.dock, id) !== area)
      this.layout.dock = movePanel(this.layout.dock, id, area, index);
    this.showPanel(id);
  }

  resetPanelLayout(): void {
    this.layout.dock = defaultDock(PANELS);
    this.layout.closedPanels = [];
    this.mobilePanel = null;
    this.applyLayout();
  }

  isPanelClosed(id: PanelId): boolean {
    return this.layout.closedPanels.includes(id);
  }

  private reopen(id: PanelId): void {
    if (this.isPanelClosed(id))
      this.layout.closedPanels = this.layout.closedPanels.filter(
        (closed) => closed !== id,
      );
  }

  /**
   * Removes a panel from its dock area. It remembers its place there and comes
   * back through its command, the "+" button of any area or a layout reset.
   */
  closePanel(id: PanelId): void {
    if (this.isPanelClosed(id)) return;
    const before = this.shownDock;
    const area = areaOf(before, id);
    if (area) {
      // The stored layout falls back to the same neighbour the user sees.
      const next = withoutPanels(before, [id])[area].active;
      if (next) this.layout.dock = activatePanel(this.layout.dock, next);
    }
    this.layout.closedPanels = [...this.layout.closedPanels, id];
    if (this.mobilePanel === id) this.mobilePanel = null;
    // An empty bottom area only takes space away from the editor.
    if (area === "bottom" && this.shownDock.bottom.panels.length === 0)
      this.layout.bottomOpen = false;
    this.applyLayout();
  }

  /** Reopens closed panels into `area` (or their old place). */
  private closedPanelMenu(area?: DockArea): MenuEntry[] {
    return PANELS.filter((spec) => this.isPanelClosed(spec.id)).map(
      (spec) => ({
        title: t("{name} öffnen", { name: spec.label }),
        icon: spec.icon,
        onClick: () => {
          this.reopen(spec.id);
          if (area) this.movePanelTo(spec.id, area);
          else this.showPanel(spec.id);
        },
      }),
    );
  }

  private panelMenu(id: PanelId): MenuEntry[] {
    const current = areaOf(this.layout.dock, id);
    const targets: Array<[DockArea, string, string]> = [
      ["left", t("In linke Seitenleiste verschieben"), "panel-left"],
      ["left-bottom", t("Nach links unten verschieben"), "panel-bottom"],
      ["right", t("In rechte Seitenleiste verschieben"), "panel-right"],
      ["bottom", t("In unteren Bereich verschieben"), "panel-bottom"],
    ];
    const shown = withoutPanels(this.layout.dock, this.layout.closedPanels);
    const slot = current ? shown[current] : null;
    const index = slot ? slot.panels.indexOf(id) : -1;
    return [
      ...targets
        // Phones have no bottom area; its panels live in the right drawer.
        .filter(
          ([area]) => area !== current && !(this.isMobile && (area === "bottom" || area === "left-bottom")),
        )
        .map(([area, title, iconId]) => ({
          title,
          icon: iconId,
          onClick: () => this.movePanelTo(id, area),
        })),
      "separator",
      current &&
        index > 0 && {
          title: t("Nach vorne rücken"),
          icon: "arrow-left",
          onClick: () => this.movePanelTo(id, current, index - 1),
        },
      current &&
        slot &&
        index < slot.panels.length - 1 && {
          title: t("Nach hinten rücken"),
          icon: "arrow-right",
          onClick: () => this.movePanelTo(id, current, index + 2),
        },
      "separator",
      {
        title: t("Ansicht schließen"),
        icon: "x",
        onClick: () => this.closePanel(id),
      },
      "separator",
      ...this.closedPanelMenu(current ?? undefined),
      "separator",
      {
        title: t("Ansichten-Layout zurücksetzen"),
        icon: "rotate-ccw",
        onClick: () => this.resetPanelLayout(),
      },
    ];
  }

  /** Docking of panel tabs by drag & drop, and their context menu. */
  private setupPanelDrag(): void {
    const { docks, leftSplit, leftBottomSplit, rightSplit, bottomSplit, rootSplit } = this.shell;
    installPanelDrag({
      areas: {
        left: { box: leftSplit, strip: docks.left.tabs, tabs: docks.left.tabs },
        "left-bottom": { box: leftBottomSplit, strip: docks["left-bottom"].tabs, tabs: docks["left-bottom"].tabs },
        right: {
          box: rightSplit,
          strip: docks.right.tabs,
          tabs: docks.right.tabs,
        },
        bottom: {
          box: bottomSplit,
          strip: docks.bottom.tabs.parentElement!,
          tabs: docks.bottom.tabs,
        },
      },
      editor: rootSplit,
      isOpen: (area) =>
        area === "left" || area === "left-bottom"
          ? this.leftVisible
          : area === "right"
            ? this.rightVisible
            : this.bottomVisible,
      size: (area) =>
        area === "left"
          ? this.layout.leftWidth
          : area === "right"
            ? this.layout.rightWidth
            : area === "left-bottom" ? this.layout.leftBottomHeight : this.layout.bottomHeight,
      drop: (id, area, index) => this.movePanelTo(id as PanelId, area, index),
    });
    document.addEventListener("contextmenu", (event) => {
      const tab = (event.target as Element).closest?.<HTMLElement>(
        ".workspace-tab-header[data-panel]",
      );
      if (!tab) return;
      event.preventDefault();
      showMenu(this.panelMenu(tab.dataset.panel as PanelId), {
        x: event.clientX,
        y: event.clientY,
      });
    });
    // Middle click closes a panel, like an editor tab.
    document.addEventListener("auxclick", (event) => {
      if (event.button !== 1) return;
      const tab = (event.target as Element).closest?.<HTMLElement>(
        ".workspace-tab-header[data-panel]",
      );
      if (!tab) return;
      event.preventDefault();
      this.closePanel(tab.dataset.panel as PanelId);
    });
    for (const area of DOCK_AREAS) {
      const { add } = docks[area];
      add.addEventListener("click", () => {
        // Phones show bottom panels in the right drawer.
        const target = this.isMobile && area === "bottom" ? "right" : area;
        showMenu(this.closedPanelMenu(target), add);
      });
    }
  }

  private setupResize(
    handle: HTMLElement,
    side: DockArea,
  ): void {
    const key =
      side === "left"
        ? "leftWidth"
        : side === "right"
          ? "rightWidth"
          : side === "left-bottom" ? "leftBottomHeight" : "bottomHeight";
    const vertical = side === "bottom" || side === "left-bottom";
    const property = vertical ? `--${side}-height` : `--${side}-width`;
    const clamp = (size: number) => side === "left-bottom"
      ? Math.max(80, Math.min(size, this.shell.leftSplit.clientHeight - 180))
      : vertical ? Math.max(120, Math.min(size, innerHeight * 0.7))
      : Math.max(200, Math.min(size, Math.min(640, innerWidth * 0.5)));
    const visibleSize = () => side === "left-bottom"
      ? this.shell.leftBottomSplit.getBoundingClientRect().height
      : this.layout[key];
    if (side === "left-bottom") {
      const observer = new ResizeObserver(() => {
        handle.setAttribute("aria-valuemin", "80");
        handle.setAttribute("aria-valuemax", String(Math.max(80, this.shell.leftSplit.clientHeight - 180)));
        handle.setAttribute("aria-valuenow", String(Math.round(clamp(visibleSize()))));
      });
      observer.observe(this.shell.leftSplit);
      observer.observe(this.shell.leftBottomSplit);
    }
    if (side === "left-bottom") handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      this.layout[key] = clamp(visibleSize() + (event.key === "ArrowUp" ? 10 : -10));
      this.applyLayout();
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const { workspace } = this.shell;
      const start = visibleSize();
      const origin = vertical ? event.clientY : event.clientX;
      workspace.classList.add("is-resizing");
      if (vertical) workspace.classList.add("is-resizing-rows");
      let frame = 0;
      let size = start;
      const move = (ev: PointerEvent) => {
        const delta =
          side === "left"
            ? ev.clientX - origin
            : side === "right"
              ? origin - ev.clientX
              : origin - ev.clientY;
        size = Math.round(clamp(start + delta));
        if (!frame)
          frame = requestAnimationFrame(() => {
            frame = 0;
            workspace.style.setProperty(
              property,
              `${size}px`,
            );
          });
      };
      const up = () => {
        cancelAnimationFrame(frame);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        workspace.classList.remove("is-resizing", "is-resizing-rows");
        this.layout[key] = size;
        this.applyLayout();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("dblclick", () => {
      this.layout[key] = side === "left" ? 280 : side === "right" ? 300 : side === "left-bottom" ? 180 : 240;
      this.applyLayout();
    });
  }

  // ── editor groups and tab bars ────────────────────────────────────────────

  /**
   * Brings the DOM in line with the groups: the split, the tab strips, the
   * live views in the focused group and a mirror in every other one.
   */
  private renderGroups(): void {
    const { groupsEl, leaf, inlineToggle, stripActions, previewEl } =
      this.shell;
    for (const group of this.groups)
      if (!this.groupViews.has(group.id))
        this.groupViews.set(group.id, this.createGroupView(group));
    for (const [id, view] of this.groupViews)
      if (!this.groups.some((group) => group.id === id)) {
        view.mirror.release();
        this.groupViews.delete(id);
      }
    const viewOf = (id: number) => this.groupViews.get(id)!;
    const shape = `${JSON.stringify(this.split, (key, value: unknown) =>
      key === "sizes" ? undefined : value,
    )}|${this.group.id}`;
    if (shape !== this.splitShape) {
      this.splitShape = shape;
      // Scrollers lose their position when they are moved in the document.
      const scroller = this.editor.view.scrollDOM;
      const live = { source: scroller.scrollTop, preview: previewEl.scrollTop };
      const mirrored = this.groups.map(
        (group) =>
          [viewOf(group.id).mirror, viewOf(group.id).mirror.scroll] as const,
      );
      for (const group of this.groups) {
        const view = viewOf(group.id);
        view.el.replaceChildren(
          view.strip,
          group === this.group ? leaf : view.mirror.el,
        );
      }
      const root = this.buildSplit(this.split);
      root.style.flex = "1 1 0px";
      groupsEl.replaceChildren(root);
      // The window buttons sit in the strips of the two upper corners.
      viewOf(cornerGroup(this.split, "left")).strip.prepend(inlineToggle);
      viewOf(cornerGroup(this.split, "right")).strip.append(stripActions);
      scroller.scrollTop = live.source;
      previewEl.scrollTop = live.preview;
      for (const [mirror, scroll] of mirrored) mirror.scroll = scroll;
      this.editor.view.requestMeasure();
    }
    groupsEl.classList.toggle("is-split", this.groups.length > 1);
    for (const group of this.groups) {
      const view = viewOf(group.id);
      const focused = group === this.group;
      view.el.classList.toggle("is-active", focused);
      this.renderStrip(group, view.tabList);
      if (focused) view.mirror.release();
      else view.mirror.show(group.active, this.editorOptions);
    }
    this.shell.tabCount.textContent = String(this.allTabs.length);
  }

  private buildSplit(node: SplitNode): HTMLElement {
    if (isLeaf(node)) return this.groupViews.get(node.group)!.el;
    const el = h("div", `workspace-group-split mod-${node.direction}`);
    node.children.forEach((child, index) => {
      const childEl = this.buildSplit(child);
      childEl.style.flex = `${node.sizes[index]} 1 0px`;
      if (index > 0) el.append(this.buildSash(node, index));
      el.append(childEl);
    });
    return el;
  }

  /** Divider between two neighbours of a split; dragging it resizes both. */
  private buildSash(node: SplitBranch, index: number): HTMLElement {
    const row = node.direction === "row";
    const sash = h("div", {
      class: `workspace-group-sash mod-${node.direction}`,
      attrs: {
        role: "separator",
        "aria-orientation": row ? "vertical" : "horizontal",
      },
    });
    sash.addEventListener("pointerdown", (event) => {
      const before = sash.previousElementSibling as HTMLElement | null;
      const after = sash.nextElementSibling as HTMLElement | null;
      if (event.button !== 0 || !before || !after) return;
      event.preventDefault();
      sash.setPointerCapture(event.pointerId);
      const extent = (el: HTMLElement) =>
        row
          ? el.getBoundingClientRect().width
          : el.getBoundingClientRect().height;
      const first = extent(before);
      const total = first + extent(after);
      const weight = node.sizes[index - 1] + node.sizes[index];
      const origin = row ? event.clientX : event.clientY;
      const least = Math.min(120, total / 2);
      const { workspace } = this.shell;
      workspace.classList.add("is-resizing");
      if (!row) workspace.classList.add("is-resizing-rows");
      const move = (moved: PointerEvent) => {
        const size = Math.max(
          least,
          Math.min(
            total - least,
            first + (row ? moved.clientX : moved.clientY) - origin,
          ),
        );
        node.sizes[index - 1] = (weight * size) / total;
        node.sizes[index] = weight - node.sizes[index - 1];
        before.style.flex = `${node.sizes[index - 1]} 1 0px`;
        after.style.flex = `${node.sizes[index]} 1 0px`;
      };
      const stop = () => {
        sash.removeEventListener("pointermove", move);
        sash.removeEventListener("pointerup", stop);
        sash.removeEventListener("pointercancel", stop);
        workspace.classList.remove("is-resizing", "is-resizing-rows");
        this.editor.view.requestMeasure();
        this.saveWorkspace();
      };
      sash.addEventListener("pointermove", move);
      sash.addEventListener("pointerup", stop);
      sash.addEventListener("pointercancel", stop);
    });
    return sash;
  }

  private createGroupView(group: Group): GroupView {
    const view: GroupView = {
      ...buildGroup(group.id),
      mirror: new GroupMirror(this),
    };
    const { el, tabList, mirror } = view;
    for (const button of el.querySelectorAll<HTMLElement>("[data-command]")) {
      const hotkey = this.commands.hotkeyOf(button.dataset.command!);
      if (hotkey) button.dataset.hotkey = formatHotkey(hotkey);
    }
    const alive = () => this.groups.includes(group);
    /** Synchronously hands the focus over, so commands act on this group. */
    const focus = () => {
      if (alive() && group !== this.group) void this.activate(group.active);
    };
    // Buttons in a background group's strip act on that group. Tabs take
    // care of the focus themselves, and closing one must not steal it.
    el.addEventListener(
      "click",
      (event) => {
        if (!tabList.contains(event.target as Node)) focus();
      },
      true,
    );
    // Clicking a mirror continues editing right where the pointer is.
    mirror.el.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || !alive() || group === this.group) return;
      event.preventDefault();
      const tab = group.active;
      const offset = mirror.handOver(tab, {
        x: event.clientX,
        y: event.clientY,
      });
      void this.activate(tab).then(() => {
        if (this.active !== tab) return;
        if (offset !== null && this.activeNote && !tab.reading)
          this.editor.view.dispatch({
            selection: {
              anchor: Math.min(offset, this.editor.state.doc.length),
            },
          });
        this.focusView();
      });
    });

    tabList.addEventListener("click", (event) => {
      const tab = this.tabFromEvent(event);
      if (!tab) return;
      if (
        (event.target as Element).closest(
          ".workspace-tab-header-inner-close-button",
        )
      )
        this.closeTab(tab);
      else void this.activate(tab).then(() => this.focusView());
    });
    tabList.addEventListener("auxclick", (event) => {
      const tab = this.tabFromEvent(event);
      if (tab && event.button === 1) {
        event.preventDefault();
        this.closeTab(tab);
      }
    });
    tabList.addEventListener("contextmenu", (event) => {
      const tab = this.tabFromEvent(event);
      if (!tab) return;
      event.preventDefault();
      this.showFileMenu(
        tab.path,
        { x: event.clientX, y: event.clientY },
        this.tabMenu(tab),
        "tab-header",
      );
    });
    tabList.addEventListener("dblclick", (event) => {
      if (this.tabFromEvent(event)) return;
      focus();
      this.newTab();
    });
    // Horizontal wheel scrolling over the tab strip.
    tabList.addEventListener(
      "wheel",
      (event) => {
        if (event.deltaY && !event.deltaX) tabList.scrollLeft += event.deltaY;
      },
      { passive: true },
    );
    return view;
  }

  private renderStrip(group: Group, list: HTMLElement): void {
    list.replaceChildren(
      ...group.tabs.map((tab) => {
        const dirty = !!tab.note && tab.note.text !== tab.note.saved;
        const selected = tab === group.active;
        return h(
          "div",
          {
            class: `workspace-tab-header${selected ? " is-active" : ""}${dirty ? " is-dirty" : ""}`,
            attrs: {
              role: "tab",
              "aria-selected": String(selected),
              draggable: "true",
              tabindex: selected ? "0" : "-1",
            },
            data: { tabId: String(tab.id) },
          },
          h(
            "div",
            "workspace-tab-header-inner",
            h("div", {
              class: "workspace-tab-header-inner-title",
              text: this.tabTitle(tab),
            }),
            h(
              "button",
              {
                class: "workspace-tab-header-inner-close-button",
                label: t("Tab schließen"),
                attrs: { type: "button", tabindex: "-1" },
              },
              icon("x", 14),
            ),
          ),
        );
      }),
    );
    list
      .querySelector(".workspace-tab-header.is-active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private tabById(id: string | undefined): Tab | null {
    return this.allTabs.find((tab) => String(tab.id) === id) ?? null;
  }

  private tabFromEvent(event: Event): Tab | null {
    const el = (event.target as Element).closest<HTMLElement>(
      ".workspace-tab-header[data-tab-id]",
    );
    return el ? this.tabById(el.dataset.tabId) : null;
  }

  /** Drag & drop of editor tabs: reorder, move between groups, split. */
  private setupTabDrag(): void {
    installTabDrag({
      groups: () =>
        this.isMobile
          ? []
          : this.groups.flatMap((group) => {
              const view = this.groupViews.get(group.id);
              return view
                ? [
                    {
                      id: group.id,
                      el: view.el,
                      strip: view.strip,
                      tabs: view.tabList,
                      count: group.tabs.length,
                    },
                  ]
                : [];
            }),
      tab: (id) => {
        const tab = this.tabById(id);
        const group = tab && this.groupOf(tab);
        return tab && group
          ? { label: this.tabTitle(tab), group: group.id, path: tab.path }
          : null;
      },
      drop: (id, target) => {
        const tab = this.tabById(id);
        const group = this.groups.find((other) => other.id === target.group);
        if (!tab || !group) return;
        if (target.kind === "split") this.splitOff(tab, group, target.side);
        else
          this.moveTabTo(
            tab,
            group,
            target.kind === "strip" ? target.index : undefined,
          );
      },
    });
  }

  private tabMenu(tab: Tab): MenuEntry[] {
    return [
      { title: t("Schließen"), icon: "x", onClick: () => this.closeTab(tab) },
      {
        title: t("Andere schließen"),
        icon: "copy-x",
        disabled: (this.groupOf(tab)?.tabs.length ?? 0) < 2,
        onClick: () => this.closeOtherTabs(tab),
      },
      "separator",
      ...(this.isMobile
        ? []
        : ([
            {
              title: t("Nach rechts teilen"),
              icon: "columns-2",
              onClick: () => this.splitTab(tab, "right"),
            },
            {
              title: t("Nach unten teilen"),
              icon: "rows-2",
              onClick: () => this.splitTab(tab, "bottom"),
            },
            "separator",
          ] satisfies MenuEntry[])),
      ...(tab.path ? this.fileMenuItems(tab.path) : []),
    ];
  }

  /** Shows `tab` and opens it a second time in a new group on `side`. */
  private splitTab(tab: Tab, side: SplitSide): void {
    void this.activate(tab).then(() => {
      if (this.active === tab) this.splitActive(side);
    });
  }

  /** Host menu plus the plugin `file-menu` event, for explorer, tabs, bookmarks and "more options". */
  showFileMenu(
    path: string | null,
    at: { x: number; y: number } | HTMLElement,
    entries = path ? this.fileMenuItems(path) : [],
    source = "file-explorer",
  ): void {
    const session = this.compatibility;
    const file = path ? session?.vault.getAbstractFileByPath(path) : null;
    if (!session || !file) {
      showMenu(entries, at);
      return;
    }
    const menu = new PluginMenu();
    session.workspace.trigger(
      "file-menu",
      menu,
      file,
      source,
      session.workspace.activeLeaf,
    );
    menu.showWithHostEntries(entries, at);
  }

  /** Shared between explorer, tabs, bookmarks and the "more options" menu. */
  fileMenuItems(path: string): MenuEntry[] {
    return [
      {
        title: t("In neuem Tab öffnen"),
        icon: "file-plus",
        onClick: () => void this.openPath(path, { newTab: true }),
      },
      {
        title: t("Umbenennen"),
        icon: "pencil",
        onClick: () => this.promptRenameFile(path),
      },
      "separator",
      {
        title: this.isBookmarked(path)
          ? t("Lesezeichen entfernen")
          : t("Lesezeichen setzen"),
        icon: "bookmark",
        onClick: () => this.toggleBookmark(path),
      },
      {
        title: t("Im Dateiexplorer anzeigen"),
        icon: "folder-closed",
        onClick: () => this.explorer.reveal(path),
      },
      {
        title: t("Pfad kopieren"),
        icon: "copy",
        onClick: () =>
          void navigator.clipboard
            ?.writeText(path)
            .then(() => notify(t("Pfad kopiert.")))
            .catch(() => notify(t("Kopieren nicht möglich."), true)),
      },
      /\.(md|canvas)$/i.test(path)
        ? {
            title: t("Versionsverlauf"),
            icon: "history",
            onClick: () => openFileRecovery(this, path),
          }
        : null,
      /\.md$/i.test(path)
        ? {
            title: t("Als Markdown exportieren"),
            icon: "download",
            onClick: () => this.exportNote(path),
          }
        : null,
      "separator",
      {
        title: t("In Papierkorb verschieben"),
        icon: "trash-2",
        danger: true,
        disabled: this.store?.isDeleting(path),
        onClick: () => this.promptDeleteFile(path),
      },
    ];
  }

  private showTabList(anchor: HTMLElement): void {
    const order = groupIds(this.split);
    const groups = [...this.groups].sort(
      (a, b) => order.indexOf(a.id) - order.indexOf(b.id),
    );
    showMenu(
      [
        // One block per group, in reading order.
        ...groups.flatMap((group, index): MenuEntry[] => [
          index > 0 ? "separator" : null,
          ...group.tabs.map((tab) => ({
            title: this.tabTitle(tab),
            icon: tab.path ? "file-text" : "file",
            checked: tab === this.active,
            onClick: () => void this.activate(tab),
          })),
        ]),
        "separator",
        {
          title: t("Neuer Tab"),
          icon: "plus",
          onClick: () => this.commands.run("new-tab"),
        },
        {
          title: t("Aktuellen Tab schließen"),
          icon: "x",
          onClick: () => this.closeTab(),
        },
      ],
      anchor,
    );
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  private wireShell(): void {
    const shell = this.shell;

    document.addEventListener("click", (event) => {
      const target = event.target as Element;
      const command = target.closest<HTMLElement>("[data-command]");
      if (command) {
        this.commands.run(command.dataset.command!);
        return;
      }
      const panel = target.closest<HTMLElement>(
        ".workspace-tab-header[data-panel]",
      );
      if (panel) this.showPanel(panel.dataset.panel as PanelId);
    });

    shell.stripActions
      .querySelector("#tab-list-button")!
      .addEventListener("click", (event) =>
        this.showTabList(event.currentTarget as HTMLElement),
      );
    document
      .getElementById("mobile-tabs")!
      .addEventListener("click", (event) =>
        this.showTabList(event.currentTarget as HTMLElement),
      );
    document.getElementById("mobile-menu")!.addEventListener("click", (event) =>
      showMenu(
        [
          {
            title: t("Befehlspalette öffnen"),
            icon: "terminal",
            onClick: () => this.commands.run("command-palette"),
          },
          {
            title: t("Heutige Tagesnotiz öffnen"),
            icon: "calendar",
            onClick: () => this.commands.run("daily-note"),
          },
          {
            title: t("Neue Canvas erstellen"),
            icon: "layout-dashboard",
            onClick: () => this.commands.run("new-canvas"),
          },
          {
            title: t("Im Vault suchen"),
            icon: "search",
            onClick: () => this.commands.run("search"),
          },
          "separator",
          {
            title: t("Graphansicht öffnen"),
            icon: "git-fork",
            onClick: () => this.commands.run("open-graph"),
          },
          {
            title: t("Rückverweise"),
            icon: "link",
            onClick: () => this.showPanel("backlinks"),
          },
          {
            title: t("Lokaler Graph"),
            icon: "waypoints",
            onClick: () => this.showPanel("graph"),
          },
          {
            title: t("Gliederung"),
            icon: "list",
            onClick: () => this.showPanel("outline"),
          },
          "separator",
          // Plugin ribbon icons have no ribbon on phones; list them here.
          ...[...this.shell.pluginRibbon.children].map((button) => ({
            title:
              button.getAttribute("aria-label") ??
              (button as HTMLElement).title ??
              t("Plugin"),
            icon: "puzzle",
            onClick: () => (button as HTMLElement).click(),
          })),
          "separator",
          {
            title: t("Einstellungen"),
            icon: "settings",
            onClick: () => this.commands.run("settings"),
          },
        ],
        event.currentTarget as HTMLElement,
      ),
    );

    shell.moreButton.addEventListener("click", () => {
      const path = this.activePath;
      if (!path) return;
      const note = this.activeNote;
      this.showFileMenu(
        path,
        shell.moreButton,
        [
          note
            ? {
                title: this.active.reading ? t("Bearbeiten") : t("Leseansicht"),
                icon: this.active.reading ? "pencil" : "book-open",
                hotkey: formatHotkey("Mod+E"),
                onClick: () => this.commands.run("toggle-reading"),
              }
            : null,
          note
            ? {
                title: t("Quellcode-Modus"),
                icon: "code-xml",
                checked: this.settings.get("editingMode") === "source",
                onClick: () => this.commands.run("toggle-source-mode"),
              }
            : null,
          note
            ? {
                title: t("Jetzt speichern"),
                icon: "save",
                hotkey: formatHotkey("Mod+S"),
                onClick: () => this.commands.run("save"),
              }
            : null,
          note && this.vault?.platform !== "android"
            ? {
                title: t("Drucken oder als PDF speichern"),
                icon: "printer",
                hotkey: this.commands.hotkeyOf("print-note")
                  ? formatHotkey(this.commands.hotkeyOf("print-note")!)
                  : undefined,
                onClick: () => this.commands.run("print-note"),
              }
            : null,
          note
            ? {
                title: t("Als HTML exportieren"),
                icon: "file-code",
                onClick: () => this.commands.run("export-html"),
              }
            : null,
          "separator",
          {
            title: t("Rückverweise anzeigen"),
            icon: "link",
            onClick: () => this.showPanel("backlinks"),
          },
          {
            title: t("Gliederung anzeigen"),
            icon: "list",
            onClick: () => this.showPanel("outline"),
          },
          "separator",
          ...this.fileMenuItems(path),
          "separator",
          { title: t("Tab schließen"), icon: "x", onClick: () => this.closeTab() },
        ],
        "more-options",
      );
    });

    shell.backlinkCount.addEventListener("click", () =>
      this.showPanel("backlinks"),
    );
    document
      .getElementById("sync-conflicts")!
      .addEventListener("click", () => openSyncConflicts(this));
    document
      .getElementById("export-draft")!
      .addEventListener("click", () => this.exportNote());
    document
      .getElementById("reload-note")!
      .addEventListener("click", () => void this.reloadFromDisk());
    shell.scrim.addEventListener("click", () => this.closeDrawers());
    this.setupResize(shell.leftHandle, "left");
    this.setupResize(shell.rightHandle, "right");
    this.setupResize(shell.bottomHandle, "bottom");
    this.setupResize(shell.leftBottomHandle, "left-bottom");
    this.setupPanelDrag();
    this.setupTabDrag();

    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && this.drawer && !topModal()) {
          this.closeDrawers();
          return;
        }
        this.commands.handleKey(event, !!topModal());
      },
      true,
    );
    window.addEventListener("beforeunload", (event) => {
      this.writeWorkspace();
      const pluginData = this.compatibility?.hasPendingPluginData() ?? false;
      void this.compatibility
        ?.flushPluginData()
        .catch((error) => this.report(error));
      if (
        pluginData ||
        (this.store &&
          [...this.store.notes.values()].some(
            (note) => note.text !== note.saved,
          ))
      )
        event.preventDefault();
    });
    // Switching back to the window does not change visibility on desktops.
    window.addEventListener("focus", () => {
      if (
        this.compatibility &&
        this.vault?.platform !== "android" &&
        Date.now() - this.lastFullRefresh > 5000
      )
        void this.refreshCompatibility().catch((error) => this.report(error));
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        // Other apps (sync tools, file managers) may have changed files.
        if (this.compatibility)
          void this.refreshCompatibility().catch((error) => this.report(error));
        return;
      }
      this.writeWorkspace();
      void this.store?.saveAll().catch((error) => this.report(error));
      void this.compatibility
        ?.flushPluginData()
        .catch((error) => this.report(error));
    });

    // Edge swipes open the drawers on touch devices.
    let touch: { x: number; y: number } | null = null;
    document.addEventListener(
      "touchstart",
      (event) => {
        const point = event.touches[0];
        touch =
          event.touches.length === 1
            ? { x: point.clientX, y: point.clientY }
            : null;
      },
      { passive: true },
    );
    document.addEventListener(
      "touchend",
      (event) => {
        if (!touch || !this.isMobile || topModal()) return;
        const point = event.changedTouches[0];
        const dx = point.clientX - touch.x;
        const dy = point.clientY - touch.y;
        const start = touch.x;
        touch = null;
        if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
        if (this.drawer === "left" && dx < 0) this.closeDrawers();
        else if (this.drawer === "right" && dx > 0) this.closeDrawers();
        else if (!this.drawer && dx > 0 && start < 32) this.toggleLeft(true);
        else if (!this.drawer && dx < 0 && start > innerWidth - 32)
          this.toggleRight(true);
      },
      { passive: true },
    );

    this.showHotkeyHints();
    this.commands.onChange(() => {
      this.showHotkeyHints();
      if (!this.tabs.some((tab) => tab.path)) this.renderEmpty();
    });
  }

  /** Tooltips show the hotkey of the command behind each button. */
  private showHotkeyHints(): void {
    const shell = this.shell;
    // The strip buttons are not in the document while they change groups.
    for (const button of [
      ...document.querySelectorAll<HTMLElement>("[data-command]"),
      ...shell.stripActions.querySelectorAll<HTMLElement>("[data-command]"),
      shell.inlineToggle,
    ]) {
      const hotkey = this.commands.hotkeyOf(button.dataset.command!);
      if (hotkey) button.dataset.hotkey = formatHotkey(hotkey);
      else delete button.dataset.hotkey;
    }
  }

  private registerCommands(): void {
    const add = this.commands.add.bind(this.commands);
    const hasNote = () => !!this.activeNote;
    add({
      id: "quick-switcher",
      name: t("Schnellauswahl öffnen"),
      hotkey: "Mod+O",
      icon: "file-search",
      global: true,
      run: () => {
        closeMenu();
        openQuickSwitcher(this);
      },
    });
    add({
      id: "command-palette",
      name: t("Befehlspalette öffnen"),
      hotkey: "Mod+P",
      icon: "terminal",
      global: true,
      run: () => {
        closeMenu();
        openCommandPalette(this);
      },
    });
    add({
      id: "new-note",
      name: t("Neue Notiz erstellen"),
      hotkey: "Mod+N",
      icon: "square-pen",
      run: () => this.promptNewNote(),
    });
    add({
      id: "new-canvas",
      name: t("Neue Canvas erstellen"),
      icon: "layout-dashboard",
      run: () => void this.createCanvas(),
    });
    add({
      id: "new-tab",
      name: t("Neuer Tab"),
      hotkey: "Mod+T",
      icon: "plus",
      run: () => void this.newTab(),
    });
    add({
      id: "close-tab",
      name: t("Aktuellen Tab schließen"),
      hotkey: "Mod+W",
      icon: "x",
      run: () => this.closeTab(),
    });
    add({
      id: "move-file",
      name: t("Aktuelle Datei verschieben nach …"),
      icon: "folder-closed",
      when: () => !!this.activePath,
      run: () => this.promptMoveFile(this.activePath!),
    });
    add({
      id: "delete-file",
      name: t("Aktuelle Datei löschen"),
      icon: "trash-2",
      when: () => !!this.activePath,
      run: () => this.promptDeleteFile(this.activePath!),
    });
    add({
      id: "rename-file",
      name: t("Aktuelle Datei umbenennen"),
      hotkey: "F2",
      icon: "pencil",
      when: () => !!this.activePath,
      run: () => this.promptRenameFile(this.activePath!),
    });
    add({
      id: "next-tab",
      name: t("Zum nächsten Tab wechseln"),
      hotkey: "Mod+Tab",
      run: () => this.cycleTab(1),
    });
    add({
      id: "previous-tab",
      name: t("Zum vorherigen Tab wechseln"),
      hotkey: "Mod+Shift+Tab",
      run: () => this.cycleTab(-1),
    });
    const canSplit = () => !this.isMobile;
    const isSplit = () => !this.isMobile && this.groups.length > 1;
    add({
      id: "split-right",
      name: t("Editor nach rechts teilen"),
      hotkey: "Mod+\\",
      icon: "columns-2",
      when: canSplit,
      run: () => this.splitActive("right"),
    });
    add({
      id: "split-down",
      name: t("Editor nach unten teilen"),
      icon: "rows-2",
      when: canSplit,
      run: () => this.splitActive("bottom"),
    });
    add({
      id: "focus-next-group",
      name: t("Zur nächsten Editorgruppe wechseln"),
      when: isSplit,
      run: () => this.cycleGroup(1),
    });
    add({
      id: "focus-previous-group",
      name: t("Zur vorherigen Editorgruppe wechseln"),
      when: isSplit,
      run: () => this.cycleGroup(-1),
    });
    add({
      id: "close-group",
      name: t("Editorgruppe schließen"),
      when: isSplit,
      run: () => this.closeGroup(this.group),
    });
    add({
      id: "toggle-reading",
      name: t("Lese-/Bearbeitungsansicht umschalten"),
      hotkey: "Mod+E",
      icon: "book-open",
      when: hasNote,
      run: () => this.setReading(!this.active.reading),
    });
    add({
      id: "toggle-source-mode",
      name: t("Live-Vorschau/Quellcode-Modus umschalten"),
      icon: "code-xml",
      run: () =>
        this.settings.set(
          "editingMode",
          this.settings.get("editingMode") === "live" ? "source" : "live",
        ),
    });
    add({
      id: "save",
      name: t("Aktuelle Datei speichern"),
      hotkey: "Mod+S",
      icon: "save",
      global: true,
      when: () => !!this.activeDocument,
      run: () =>
        void this.save(this.activeDocument).catch((error) =>
          this.report(error),
        ),
    });
    add({
      id: "search",
      name: t("In allen Dateien suchen"),
      hotkey: "Mod+Shift+F",
      icon: "search",
      run: () => {
        const selection =
          this.activeNote && !this.active.reading
            ? this.editor.view.state.sliceDoc(
                this.editor.view.state.selection.main.from,
                this.editor.view.state.selection.main.to,
              )
            : "";
        this.showPanel("search");
        if (selection && !selection.includes("\n"))
          this.search.setQuery(selection);
      },
    });
    add({
      id: "navigate-back",
      name: t("Zurück navigieren"),
      hotkey: "Mod+Alt+ArrowLeft",
      icon: "arrow-left",
      run: () => void this.navigateHistory(-1),
    });
    add({
      id: "navigate-forward",
      name: t("Vorwärts navigieren"),
      hotkey: "Mod+Alt+ArrowRight",
      icon: "arrow-right",
      run: () => void this.navigateHistory(1),
    });
    add({
      id: "toggle-left-sidebar",
      name: t("Linke Seitenleiste umschalten"),
      icon: "panel-left",
      run: () => this.toggleLeft(),
    });
    add({
      id: "toggle-right-sidebar",
      name: t("Rechte Seitenleiste umschalten"),
      icon: "panel-right",
      run: () => this.toggleRight(),
    });
    add({
      id: "toggle-bottom-panel",
      name: t("Unteren Bereich umschalten"),
      icon: "panel-bottom",
      run: () => this.toggleBottom(),
    });
    add({
      id: "reset-panel-layout",
      name: t("Ansichten-Layout zurücksetzen"),
      icon: "rotate-ccw",
      run: () => this.resetPanelLayout(),
    });
    add({
      id: "show-explorer",
      name: t("Dateiexplorer anzeigen"),
      icon: "folder-closed",
      run: () => this.showPanel("files"),
    });
    add({
      id: "reveal-active",
      name: t("Aktuelle Datei im Dateiexplorer anzeigen"),
      icon: "folder-closed",
      when: () => !!this.activePath,
      run: () => this.explorer.reveal(this.activePath!),
    });
    add({
      id: "show-backlinks",
      name: t("Rückverweise anzeigen"),
      icon: "link",
      run: () => this.showPanel("backlinks"),
    });
    add({
      id: "show-outline",
      name: t("Gliederung anzeigen"),
      icon: "list",
      run: () => this.showPanel("outline"),
    });
    add({
      id: "open-graph",
      name: t("Graphansicht öffnen"),
      icon: "git-fork",
      run: () => {
        closeMenu();
        this.closeDrawers();
        openGraph(this);
      },
    });
    add({
      id: "show-local-graph",
      name: t("Lokalen Graph anzeigen"),
      icon: "waypoints",
      run: () => this.showPanel("graph"),
    });
    add({
      id: "show-tags",
      name: t("Tags anzeigen"),
      icon: "tags",
      run: () => this.showPanel("tags"),
    });
    add({
      id: "show-bookmarks",
      name: t("Lesezeichen anzeigen"),
      icon: "bookmark",
      run: () => this.showPanel("bookmarks"),
    });
    add({
      id: "show-outgoing-links",
      name: t("Ausgehende Links anzeigen"),
      icon: "arrow-up-right",
      run: () => this.showPanel("outgoing"),
    });
    add({
      id: "toggle-bookmark",
      name: t("Lesezeichen für aktuelle Datei umschalten"),
      icon: "bookmark",
      when: () => !!this.activePath,
      run: () => this.toggleBookmark(this.activePath!),
    });
    add({
      id: "daily-note",
      name: t("Heutige Tagesnotiz öffnen"),
      icon: "calendar",
      run: () => void this.dailyNote(),
    });
    add({
      id: "daily-note-previous",
      name: t("Vorherige Tagesnotiz öffnen"),
      icon: "chevron-left",
      run: () => void this.adjacentDailyNote(-1),
    });
    add({
      id: "daily-note-next",
      name: t("Nächste Tagesnotiz öffnen"),
      icon: "chevron-right",
      run: () => void this.adjacentDailyNote(1),
    });
    add({
      id: "add-property",
      name: t("Eigenschaft hinzufügen"),
      hotkey: "Mod+;",
      icon: "list-plus",
      when: () => hasNote() && !this.active.reading,
      run: () => {
        this.editor.focus();
        addProperty(this.editor.view);
      },
    });
    const fold = (command: (view: EditorView) => boolean) => () => {
      this.editor.focus();
      command(this.editor.view);
    };
    add({
      id: "toggle-fold",
      name: t("Einklappen umschalten"),
      icon: "chevrons-down-up",
      when: () => hasNote() && !this.active.reading,
      run: fold(toggleFold),
    });
    add({
      id: "fold-all",
      name: t("Alle Überschriften und Listen einklappen"),
      icon: "chevrons-down-up",
      when: () => hasNote() && !this.active.reading,
      run: fold(foldAll),
    });
    add({
      id: "unfold-all",
      name: t("Alle Überschriften und Listen ausklappen"),
      icon: "chevrons-up-down",
      when: () => hasNote() && !this.active.reading,
      run: fold(unfoldAll),
    });
    add({
      id: "insert-footnote",
      name: t("Fußnote einfügen"),
      icon: "footprints",
      when: () => hasNote() && !this.active.reading,
      run: () => {
        this.editor.focus();
        insertFootnote(this.editor.view);
      },
    });
    add({
      id: "insert-template",
      name: t("Vorlage einfügen"),
      icon: "file-plus",
      when: hasNote,
      run: () => this.insertTemplate(),
    });
    add({
      id: "sync-conflicts",
      name: t("Sync-Konflikte anzeigen"),
      icon: "triangle-alert",
      run: () => openSyncConflicts(this),
    });
    add({
      id: "print-note",
      name: t("Drucken oder als PDF speichern"),
      hotkey: "Mod+Shift+P",
      icon: "printer",
      // Android's WebView has no print dialog; HTML export works there.
      when: () => hasNote() && this.vault?.platform !== "android",
      run: () => {
        const note = this.activeNote;
        if (note)
          void printNote(this, note.path, note.text).catch((error) =>
            this.report(error),
          );
      },
    });
    add({
      id: "export-html",
      name: t("Aktuelle Notiz als HTML exportieren"),
      icon: "file-code",
      when: hasNote,
      run: () => {
        const note = this.activeNote;
        if (note)
          void exportHtml(this, note.path, note.text).catch((error) =>
            this.report(error),
          );
      },
    });
    add({
      id: "export-note",
      name: t("Aktuelle Notiz als Markdown exportieren"),
      icon: "download",
      when: hasNote,
      run: () => this.exportNote(),
    });
    add({
      id: "file-recovery",
      name: t("Dateiwiederherstellung öffnen"),
      icon: "history",
      global: true,
      run: () => {
        closeMenu();
        openFileRecovery(this);
      },
    });
    add({
      id: "version-history",
      name: t("Versionsverlauf der aktuellen Datei anzeigen"),
      icon: "history",
      when: () => !!this.activeDocument,
      run: () => {
        if (this.activePath) openFileRecovery(this, this.activePath);
      },
    });
    add({
      id: "open-vault",
      name: t("Anderen Vault öffnen"),
      icon: "folder-open",
      run: () => void this.chooseVault(),
    });
    add({
      id: "reload-files",
      name: t("Dateiliste neu laden"),
      icon: "refresh-cw",
      run: () => void this.refreshFiles().catch((error) => this.report(error)),
    });
    add({
      id: "toggle-theme",
      name: t("Helles/dunkles Farbschema umschalten"),
      icon: "sun-moon",
      run: () =>
        this.settings.set(
          "theme",
          this.settings.resolvedTheme === "dark" ? "light" : "dark",
        ),
    });
    add({
      id: "settings",
      name: t("Einstellungen öffnen"),
      hotkey: "Mod+,",
      icon: "settings",
      run: () => {
        closeMenu();
        openSettings(this);
      },
    });
  }

  // ── persistence ───────────────────────────────────────────────────────────

  private writeWorkspace(): void {
    if (!this.vault) return;
    const groups = this.groups.map((group) => ({
      tabs: group.tabs.map((tab) => ({ path: tab.path, reading: tab.reading })),
      active: group.tabs.indexOf(group.active),
    }));
    const focused = this.groups.indexOf(this.group);
    this.ws.tabs = groups[focused].tabs;
    this.ws.active = groups[focused].active;
    if (groups.length > 1) {
      this.ws.groups = groups;
      this.ws.split = mapGroups(this.split, (id) =>
        this.groups.findIndex((group) => group.id === id),
      );
      this.ws.group = focused;
    } else {
      delete this.ws.groups;
      delete this.ws.split;
      delete this.ws.group;
    }
    try {
      localStorage.setItem(
        workspaceKey(this.vault.id),
        JSON.stringify(this.ws),
      );
    } catch {
      // Restoring tabs is optional.
    }
  }
}

/** User-facing text for a failed Android update. */
function androidUpdateMessage(error: unknown): Error {
  if (error instanceof AndroidUpdateError && error.state === "cancelled")
    return new Error(t("Das Update wurde abgebrochen."));
  const message = error instanceof Error ? error.message : String(error);
  if (message === "SIGNATURE_MISMATCH")
    return new Error(
      t("Das Update ist nicht mit dem Schlüssel dieser App signiert. Installiere es über die Quelle, aus der du Basalt hast."),
    );
  return new Error(t("Das Update konnte nicht installiert werden: {error}", { error: message }));
}

function emptyWorkspace(): SavedWorkspace {
  return {
    tabs: [],
    active: 0,
    expanded: [],
    bookmarks: [],
    recent: [],
    sort: "asc",
  };
}

const workspaceKey = (vaultId: string) =>
  `basalt-workspace:${JSON.stringify(vaultId)}`;

const savedTabs = (value: unknown): SavedTab[] =>
  Array.isArray(value)
    ? value
        .filter(
          (tab): tab is SavedTab =>
            !!tab &&
            typeof tab === "object" &&
            (typeof (tab as { path: unknown }).path === "string" ||
              (tab as { path: unknown }).path === null),
        )
        .map((tab) => ({ path: tab.path, reading: tab.reading === true }))
    : [];

const index = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

function loadWorkspace(vaultId: string): SavedWorkspace {
  const result = emptyWorkspace();
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(workspaceKey(vaultId)) ?? "null",
    );
    if (!raw || typeof raw !== "object") return result;
    const value = raw as Record<string, unknown>;
    result.tabs = savedTabs(value.tabs);
    result.active = index(value.active);
    if (Array.isArray(value.groups) && value.groups.length > 1) {
      result.groups = value.groups.slice(0, 16).map((group: unknown) => {
        const saved = (group ?? {}) as Record<string, unknown>;
        return { tabs: savedTabs(saved.tabs), active: index(saved.active) };
      });
      result.split = value.split;
      result.group = index(value.group);
    }
    result.expanded = strings(value.expanded);
    result.bookmarks = strings(value.bookmarks);
    result.recent = strings(value.recent);
    if (value.sort === "desc") result.sort = "desc";
  } catch {
    // A corrupt workspace file only loses the tab layout.
  }
  return result;
}

function loadLayout(): Layout {
  const layout: Layout = {
    leftWidth: 280,
    rightWidth: 300,
    bottomHeight: 240,
    leftBottomHeight: 180,
    leftOpen: true,
    rightOpen: false,
    bottomOpen: false,
    dock: defaultDock(PANELS),
    closedPanels: [],
  };
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const value = raw as Partial<Layout> & {
        leftTab?: unknown;
        rightTab?: unknown;
      };
      if (typeof value.leftWidth === "number")
        layout.leftWidth = Math.max(200, Math.min(640, value.leftWidth));
      if (typeof value.rightWidth === "number")
        layout.rightWidth = Math.max(200, Math.min(640, value.rightWidth));
      if (typeof value.bottomHeight === "number")
        layout.bottomHeight = Math.max(120, Math.min(1200, value.bottomHeight));
      if (typeof value.leftBottomHeight === "number" && Number.isFinite(value.leftBottomHeight))
        layout.leftBottomHeight = Math.max(80, Math.min(1200, value.leftBottomHeight));
      if (typeof value.leftOpen === "boolean") layout.leftOpen = value.leftOpen;
      if (typeof value.rightOpen === "boolean")
        layout.rightOpen = value.rightOpen;
      if (typeof value.bottomOpen === "boolean")
        layout.bottomOpen = value.bottomOpen;
      if (value.dock) layout.dock = normalizeDock(value.dock, PANELS);
      if (Array.isArray(value.closedPanels))
        layout.closedPanels = PANELS.map((spec) => spec.id).filter((id) =>
          (value.closedPanels as unknown[]).includes(id),
        );
      else {
        // Layouts from before docking stored the active tab per sidebar.
        for (const tab of [value.leftTab, value.rightTab])
          if (typeof tab === "string" && PANELS.some((p) => p.id === tab))
            layout.dock = activatePanel(layout.dock, tab);
      }
    }
  } catch {
    // Defaults apply.
  }
  return layout;
}

/** Replaces `parent`'s children only if they differ, so unchanged panes keep their scroll position. */
function syncChildren(parent: HTMLElement, children: HTMLElement[]): void {
  const current = parent.children;
  if (
    current.length === children.length &&
    children.every((child, i) => current[i] === child)
  )
    return;
  parent.replaceChildren(...children);
}

export function isCanvas(path: string): boolean {
  return /\.canvas$/i.test(path);
}

/** Keep note and plugin buffers intact when a save conflict blocks navigation. */
async function saveBeforeLeaving(app: Pick<App, "store" | "compatibility">): Promise<void> {
  await app.store?.saveAll();
  if (app.compatibility) {
    await app.compatibility.workspace.flushPending();
    const views = new Set<TextFileView>();
    app.compatibility.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof TextFileView) views.add(leaf.view);
    });
    for (const view of views) await view.save();
  }
}
