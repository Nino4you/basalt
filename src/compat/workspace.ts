import { Component } from "./component";
import { Events } from "./events";
import { Editor } from "./editor-adapter";
import { EditorExtensionRegistry } from "./editor-extensions";
import { TFile } from "./files";
import type { PluginServices } from "./plugin-services";

export interface WorkspaceView extends Component {
  containerEl: HTMLElement;
  file?: TFile | null;
  getViewType(): string;
  getDisplayText(): string;
  getState?(): Record<string, unknown>;
  setState?(state: unknown, result?: unknown): Promise<void>;
  loadFile?(file: TFile): Promise<void>;
  onOpen?(): Promise<void> | void;
  onClose?(): Promise<void> | void;
}

export interface ViewState {
  type: string;
  state?: Record<string, unknown>;
  active?: boolean;
}

export class MarkdownView extends Component {
  file: TFile | null = null;
  constructor(
    readonly editor: Editor,
    readonly containerEl: HTMLElement,
  ) {
    super();
  }
  getViewType(): string {
    return "markdown";
  }
  getDisplayText(): string {
    return this.file?.basename ?? "Markdown";
  }
}

export class WorkspaceLeaf extends Events {
  readonly id = crypto.randomUUID();
  readonly containerEl = document.createElement("div");
  private ephemeralState: unknown = {};
  private state: ViewState;
  readonly isDeferred = false;
  view: WorkspaceView;
  private readonly workspace: Workspace;
  parent?: WorkspaceSplit;
  constructor(viewOrApp: WorkspaceView | { workspace: Workspace }, workspace?: Workspace) {
    super();
    this.workspace = workspace ?? (viewOrApp as { workspace: Workspace }).workspace;
    this.view = workspace ? viewOrApp as WorkspaceView : new MarkdownView(this.workspace.markdownView.editor, document.createElement("div"));
    this.state = { type: this.view.getViewType() };
    this.containerEl.className = "workspace-leaf";
  }
  get app(): object | undefined { return this.workspace.app; }
  getRoot() { return this.workspace.rootSplit; }
  async openFile(file: TFile, openState?: { active?: boolean; state?: Record<string, unknown> }): Promise<void> {
    this.workspace.validateFile(file);
    if (!this.app) return this.workspace.navigateFile(file);
    await this.setViewState({ type: this.workspace.viewType(file), state: { ...openState?.state, file: file.path }, active: openState?.active ?? true });
  }
  getViewState(): ViewState {
    return { ...this.state, state: { ...this.state.state, ...this.view.getState?.(), ...(this.view.file ? { file: this.view.file.path } : {}) } };
  }
  async setViewState(state: ViewState, _eState?: unknown): Promise<void> {
    await this.workspace.openState(this, state);
    this.state = { ...state, state: { ...state.state } };
  }
  getEphemeralState(): unknown { return this.ephemeralState; }
  setEphemeralState(state: unknown): void { this.ephemeralState = state; }
  async loadIfDeferred(): Promise<void> {}
  detach(): void { this.workspace.detach(this); }
  getDisplayText(): string { return this.view.getDisplayText(); }
  getIcon(): string { return (this.view as WorkspaceView & { getIcon?(): string }).getIcon?.() ?? "file"; }
  onResize(): void { this.workspace.trigger("resize"); }
  async closeView(): Promise<void> {
    const current = this.view;
    // Obsidian unloads the component first; Excalidraw's onClose documents that order.
    try { await current.unloadAsync(); }
    finally {
      try { await current.onClose?.(); }
      finally { current.containerEl.remove(); }
    }
  }
}

/** Detached split containers are used by plugins for their own embedded file views. */
export class WorkspaceSplit {
  readonly containerEl = document.createElement("div");
  readonly children: WorkspaceLeaf[] = [];
  constructor(private readonly workspace: Workspace, readonly direction = "vertical") {}
  getRoot(): unknown { return this.workspace.rootSplit; }
  getContainer(): HTMLElement { return this.containerEl; }
  insertChild(index: number, leaf: WorkspaceLeaf): void {
    if (leaf.parent) throw new Error("Leaf already belongs to a split");
    this.children.splice(index, 0, leaf);
    leaf.parent = this;
    this.containerEl.insertBefore(leaf.containerEl, this.containerEl.children[index] ?? null);
  }
}

export interface HoverLinkSource {
  display: string;
  defaultMod: boolean;
}

export class Workspace extends Events {
  activeLeaf: WorkspaceLeaf;
  readonly layoutReady = true;
  readonly containerEl: HTMLElement;
  readonly rootSplit: { containerEl: HTMLElement; getRoot(): unknown };
  readonly markdownLeaf: WorkspaceLeaf;
  app?: object;
  private services?: PluginServices;
  private readonly leaves = new Set<WorkspaceLeaf>();
  private readonly hoverSources = new Map<string, HoverLinkSource>();
  private readonly tasks: Promise<unknown>[] = [];
  private readonly layoutTasks: Promise<unknown>[] = [];
  private recentFile: TFile | null = null;
  /** The shell supplies navigation and presentation; the registry owns view lifecycle. */
  host?: {
    open(leaf: WorkspaceLeaf, state: ViewState): Promise<void>;
    activate?(leaf: WorkspaceLeaf): void;
    detach?(leaf: WorkspaceLeaf): void;
  };
  constructor(
    readonly markdownView: MarkdownView,
    private readonly navigate: (file: TFile) => Promise<void>,
    private readonly extensions: EditorExtensionRegistry,
  ) {
    super();
    this.containerEl = markdownView.containerEl;
    const root = { containerEl: this.containerEl, getRoot: () => root };
    this.rootSplit = root;
    this.markdownLeaf = this.activeLeaf = new WorkspaceLeaf(markdownView, this);
    this.leaves.add(this.activeLeaf);
  }
  connect(app: object, services: PluginServices): void { this.app = app; this.services = services; }
  get activeEditor(): { editor: Editor; file: TFile } | null {
    const view = this.activeLeaf.view;
    return view instanceof MarkdownView && view.file ? { editor: view.editor, file: view.file } : null;
  }
  getActiveFile(): TFile | null {
    if (this.activeLeaf.view instanceof MarkdownView) return this.activeLeaf.view.file;
    return this.activeLeaf.view.file ?? this.recentFile;
  }
  getActiveViewOfType<T>(Constructor: new (...args: never[]) => T): T | null {
    if (this.activeLeaf.view instanceof MarkdownView && !this.activeLeaf.view.file) return null;
    return this.activeLeaf.view instanceof Constructor ? this.activeLeaf.view : null;
  }
  getLeavesOfType(type: string): WorkspaceLeaf[] {
    return [...this.leaves].filter(leaf => leaf.view.getViewType() === type);
  }
  /** Register an existing shell view without opening or moving its DOM. */
  registerHostView(view: WorkspaceView): WorkspaceLeaf {
    const leaf = new WorkspaceLeaf(view, this);
    this.leaves.add(leaf);
    this.trigger("layout-change");
    return leaf;
  }
  registerHoverLinkSource(id: string, info: HoverLinkSource): void {
    this.hoverSources.set(id, info);
  }
  unregisterHoverLinkSource(id: string): void {
    this.hoverSources.delete(id);
  }
  getLeaf(newLeaf?: boolean | string): WorkspaceLeaf {
    if (!newLeaf) return this.activeLeaf;
    if (newLeaf !== true && newLeaf !== "tab")
      throw new Error("Plugin split and popout panes are not implemented");
    const empty = new MarkdownView(this.markdownView.editor, document.createElement("div"));
    const leaf = new WorkspaceLeaf(empty, this);
    this.leaves.add(leaf);
    return leaf;
  }
  onLayoutReady(callback: () => unknown): void {
    const task = Promise.resolve(callback());
    void task.catch(() => {});
    this.layoutTasks.push(task);
  }
  async flushLayoutReady(): Promise<void> {
    while (this.layoutTasks.length) await Promise.all(this.layoutTasks.splice(0));
  }
  iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => unknown): void { for (const leaf of [...this.leaves]) callback(leaf); }
  iterateRootLeaves(callback: (leaf: WorkspaceLeaf) => unknown): void { this.iterateAllLeaves(callback); }
  getLeafById(id: string): WorkspaceLeaf | null { return [...this.leaves].find(leaf => leaf.id === id) ?? null; }
  getMostRecentLeaf(): WorkspaceLeaf { return this.activeLeaf; }
  setActiveLeaf(leaf: WorkspaceLeaf): void {
    if (!this.leaves.has(leaf)) throw new Error("Leaf does not belong to this workspace");
    const changed = this.activeLeaf !== leaf;
    this.activeLeaf = leaf;
    if (leaf.view.file) this.recentFile = leaf.view.file;
    this.host?.activate?.(leaf);
    if (changed) {
      this.trigger("active-leaf-change", leaf);
      this.trigger("file-open", leaf.view.file ?? null);
    }
  }
  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> { this.setActiveLeaf(leaf); }
  detachLeavesOfType(type: string): void { for (const leaf of this.getLeavesOfType(type)) leaf.detach(); }
  closePluginViews(pluginId: string): Promise<void> | undefined {
    for (const type of this.services?.getViewsFor(pluginId) ?? []) this.detachLeavesOfType(type);
    if (this.tasks.length) return this.flushPending();
  }
  detach(leaf: WorkspaceLeaf): void {
    if (!this.leaves.delete(leaf)) return;
    this.host?.detach?.(leaf);
    this.track(leaf.closeView());
    if (leaf === this.activeLeaf) {
      if (leaf === this.markdownLeaf) this.markdownLeaf.view = this.markdownView;
      this.leaves.add(this.markdownLeaf);
      this.setActiveLeaf(this.markdownLeaf);
    }
    this.trigger("layout-change");
  }
  private track(task: Promise<unknown>): void { void task.catch(() => {}); this.tasks.push(task); }
  async flushPending(): Promise<void> {
    while (this.tasks.length) {
      const tasks = [...this.tasks];
      const results = await Promise.allSettled(tasks);
      this.tasks.splice(0, tasks.length);
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Workspace view cleanup failed");
    }
  }
  validateFile(file: TFile): void {
    const vault = (this.app as { vault?: { getFileByPath(path: string): TFile | null } } | undefined)?.vault;
    if (vault && vault.getFileByPath(file.path) !== file) throw new Error("File belongs to another or stale vault");
  }
  viewType(file: TFile): string { return this.services?.getViewTypeForExtension(file.extension) ?? "markdown"; }
  navigateFile(file: TFile): Promise<void> { return this.navigate(file); }
  async openState(leaf: WorkspaceLeaf, state: ViewState): Promise<void> {
    if (!this.leaves.has(leaf)) throw new Error("Leaf does not belong to this workspace");
    if (this.host) return this.host.open(leaf, state);
    await this.loadView(leaf, state);
  }
  /** Called by the shell after it has selected the real tab and presentation container. */
  async loadView(leaf: WorkspaceLeaf, state: ViewState, host?: HTMLElement): Promise<void> {
    this.leaves.add(leaf);
    const path = state.state?.file;
    const vault = (this.app as { vault?: { getFileByPath(path: string): TFile | null } } | undefined)?.vault;
    const file = typeof path === "string" ? vault?.getFileByPath(path) : null;
    if (typeof path === "string" && !file) throw new Error(`File not found: ${path}`);
    if (state.type === "markdown") {
      if (file) await this.navigate(file);
      leaf.view = this.markdownView;
      this.markdownView.file = file ?? null;
    } else {
      const factory = this.services?.getView(state.type);
      if (!factory) throw new Error(`View type is not registered: ${state.type}`);
      if (leaf.view.getViewType() !== state.type) {
        if (!(leaf.view instanceof MarkdownView)) await leaf.closeView();
        const view = factory(leaf) as WorkspaceView;
        if (!(view.containerEl instanceof HTMLElement)) throw new Error("Plugin view has no container");
        leaf.view = view;
        (host ?? this.containerEl).append(view.containerEl);
        view.load();
        await view.onOpen?.();
      } else if (host) host.append(leaf.view.containerEl);
      if (file && leaf.view.file !== file) await leaf.view.loadFile?.(file);
      await leaf.view.setState?.(state.state ?? {}, {});
    }
    if (state.active !== false) this.setActiveLeaf(leaf);
    await this.flushLayoutReady();
    this.trigger("layout-change");
  }
  updateOptions(): void {
    this.extensions.refresh();
  }
  /** Called by the host only after a successful UI navigation or metadata refresh. */
  setActiveFile(file: TFile | null): void {
    if (file === this.markdownView.file && this.activeLeaf.view === this.markdownView) return;
    this.markdownView.file = file;
    this.markdownLeaf.view = this.markdownView;
    if (file) this.recentFile = file;
    this.activeLeaf = this.markdownLeaf;
    this.trigger("file-open", file);
    this.trigger("active-leaf-change", this.activeLeaf);
  }
}
