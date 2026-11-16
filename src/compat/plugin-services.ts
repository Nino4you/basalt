export interface PluginEditorContext {
  editor: unknown;
  view: unknown;
}

export type PluginEditorProvider = () => PluginEditorContext | null;

export interface PluginCommand {
  id: string;
  name: string;
  icon?: string;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
  editorCallback?: (editor: unknown, view: unknown) => unknown;
  editorCheckCallback?: (
    checking: boolean,
    editor: unknown,
    view: unknown,
  ) => boolean | void;
  hotkeys?: readonly unknown[];
}

export interface PluginHotkey { modifiers: string[]; key: string }

export interface RegisteredCommand extends PluginCommand {
  pluginId: string;
}

interface PluginResources {
  commands: Set<string>;
  ribbonIcons: HTMLElement[];
  statusBarItems: HTMLElement[];
  views: Set<string>;
  extensions: Set<string>;
  settingTabs: unknown[];
  codeBlockProcessors: Set<string>;
  postProcessors: Set<unknown>;
  editorSuggests: Set<unknown>;
  protocolHandlers: Set<string>;
}

/** The parameters of an `obsidian://action?…` link, as Obsidian passes them. */
export type ObsidianProtocolData = { action: string } & Record<string, string>;
export type ObsidianProtocolHandler = (params: ObsidianProtocolData) => unknown;

/** `obsidian://action?a=1&b=2` → `{ action, a, b }`, or null for other URLs. */
export function parseObsidianUrl(url: string): ObsidianProtocolData | null {
  const match = /^obsidian:\/\/([^?#/]+)\/?(?:\?([^#]*))?/i.exec(url.trim());
  if (!match) return null;
  let action: string;
  try {
    action = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const data: ObsidianProtocolData = { action };
  for (const [key, value] of new URLSearchParams(match[2] ?? ""))
    if (key !== "action") data[key] = value;
  return data;
}

function emptyResources(): PluginResources {
  return {
    commands: new Set(),
    ribbonIcons: [],
    statusBarItems: [],
    views: new Set(),
    extensions: new Set(),
    settingTabs: [],
    codeBlockProcessors: new Set(),
    postProcessors: new Set(),
    editorSuggests: new Set(),
    protocolHandlers: new Set(),
  };
}

/**
 * Host-side registries for plugin contributions. Nothing here evaluates plugin
 * source; UI wiring can consume the registries without widening the API.
 */
export class PluginServices {
  private readonly commands = new Map<string, RegisteredCommand>();
  /** Live record exposed as `app.commands.commands`, like Obsidian's registry. */
  readonly commandIndex: Record<string, RegisteredCommand> = Object.create(
    null,
  );
  private readonly views = new Map<string, (leaf: unknown) => unknown>();
  private readonly extensions = new Map<string, string>();
  private readonly codeBlockProcessors = new Map<
    string,
    (source: string, el: HTMLElement, ctx: unknown) => unknown
  >();
  private readonly postProcessors: unknown[] = [];
  private readonly protocolHandlers = new Map<string, ObsidianProtocolHandler>();
  private readonly resources = new Map<string, PluginResources>();
  private readonly defaultHotkeys = new Map<string, PluginHotkey[]>();
  private readonly doc: Document;

  constructor(
    private readonly ribbonEl?: HTMLElement,
    private readonly statusEl?: HTMLElement,
    doc?: Document,
    private readonly editorProvider?: PluginEditorProvider,
  ) {
    this.doc = doc ?? document;
  }

  private requireEditor(id: string): PluginEditorContext {
    const context = this.editorProvider?.();
    if (!context)
      throw new Error(`Command is unavailable: ${id} (no active editor)`);
    return context;
  }

  private resource(pluginId: string): PluginResources {
    let value = this.resources.get(pluginId);
    if (!value) this.resources.set(pluginId, (value = emptyResources()));
    return value;
  }

  addCommand(pluginId: string, command: PluginCommand): void {
    if (!command.id || !command.name)
      throw new Error("Plugin commands need an id and a name");
    const existing = this.commands.get(command.id);
    if (existing && existing.pluginId !== pluginId)
      throw new Error(`Command id is already registered: ${command.id}`);
    const registered = { ...command, pluginId };
    this.commands.set(command.id, registered);
    this.commandIndex[command.id] = registered;
    this.resource(pluginId).commands.add(command.id);
  }

  removeCommand(pluginId: string, id: string): void {
    const command = this.commands.get(id);
    if (command?.pluginId !== pluginId) return;
    this.removeCommandById(id);
  }

  /** Host-level removal used by `app.commands.removeCommand`. */
  removeCommandById(id: string): void {
    const command = this.commands.get(id);
    if (!command) return;
    this.commands.delete(id);
    delete this.commandIndex[id];
    this.resource(command.pluginId).commands.delete(id);
  }

  getCommands(): RegisteredCommand[] {
    return [...this.commands.values()];
  }

  getCommandsFor(pluginId: string): RegisteredCommand[] {
    return this.getCommands().filter(
      (command) => command.pluginId === pluginId,
    );
  }

  getViews(): string[] {
    return [...this.views.keys()];
  }

  getRegisteredExtensions(): Array<[string, string]> {
    return [...this.extensions.entries()];
  }

  getCodeBlockLanguages(): string[] {
    return [...this.codeBlockProcessors.keys()];
  }

  getMarkdownPostProcessorCount(): number {
    return this.postProcessors.length;
  }

  getRibbonIconCount(pluginId: string): number {
    return this.resource(pluginId).ribbonIcons.length;
  }

  getStatusBarItemCount(pluginId: string): number {
    return this.resource(pluginId).statusBarItems.length;
  }

  /**
   * Run a command using Obsidian's callback precedence. Editor commands need an
   * active editor from the host; `checking: true` is only used to test
   * availability before the command is actually invoked with `checking: false`.
   */
  runCommand(id: string): unknown {
    const command = this.commands.get(id);
    if (!command) throw new Error(`Unknown command: ${id}`);
    if (command.editorCheckCallback) {
      const { editor, view } = this.requireEditor(id);
      if (command.editorCheckCallback(true, editor, view) === false)
        throw new Error(`Command is unavailable: ${id}`);
      return command.editorCheckCallback(false, editor, view);
    }
    if (command.editorCallback) {
      const { editor, view } = this.requireEditor(id);
      return command.editorCallback(editor, view);
    }
    if (command.checkCallback) {
      if (command.checkCallback(true) === false)
        throw new Error(`Command is unavailable: ${id}`);
      return command.checkCallback(false);
    }
    return command.callback?.();
  }
  getViewsFor(pluginId: string): string[] { return [...(this.resources.get(pluginId)?.views ?? [])]; }

  addDefaultHotkeys(id: string, hotkeys: PluginHotkey[]): void {
    if (!this.commands.has(id)) throw new Error(`Unknown command: ${id}`);
    this.defaultHotkeys.set(id, hotkeys);
  }

  handleKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return;
    for (const command of this.commands.values()) {
      const keys = this.defaultHotkeys.get(command.id) ?? command.hotkeys as PluginHotkey[] | undefined;
      if (!keys?.some(hotkey => {
        const modifiers = new Set(hotkey.modifiers);
        const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Ctrl";
        if (modifiers.delete("Mod")) modifiers.add(mod);
        return event.key.toLowerCase() === hotkey.key.toLowerCase() &&
          event.ctrlKey === modifiers.has("Ctrl") && event.metaKey === modifiers.has("Meta") &&
          event.shiftKey === modifiers.has("Shift") && event.altKey === modifiers.has("Alt");
      }) || !this.isCommandAvailable(command.id)) continue;
      event.preventDefault();
      Promise.resolve(this.runCommand(command.id)).catch(error => console.error("Plugin command failed", error));
      return;
    }
  }

  /**
   * Whether a command can currently run. Palette filtering should use this
   * rather than invoking the command callbacks in their execution mode.
   */
  isCommandAvailable(id: string): boolean {
    const command = this.commands.get(id);
    if (!command) return false;
    try {
      if (command.editorCheckCallback) {
        const context = this.editorProvider?.();
        if (!context) return false;
        return (
          command.editorCheckCallback(true, context.editor, context.view) !==
          false
        );
      }
      if (command.editorCallback) return this.editorProvider?.() != null;
      if (command.checkCallback) return command.checkCallback(true) !== false;
      return true;
    } catch {
      // A plugin's availability check must not break palette rendering.
      return false;
    }
  }

  addRibbonIcon(
    pluginId: string,
    icon: string,
    title: string,
    callback: (event: MouseEvent) => unknown,
  ): HTMLElement {
    const button = this.doc.createElement("button");
    button.className = "clickable-icon basalt-plugin-ribbon";
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.dataset.icon = icon;
    button.addEventListener("click", (event) => callback(event));
    this.ribbonEl?.append(button);
    this.resource(pluginId).ribbonIcons.push(button);
    return button;
  }

  addStatusBarItem(pluginId: string): HTMLElement {
    const item = this.doc.createElement("div");
    item.className = "basalt-plugin-status";
    this.statusEl?.append(item);
    this.resource(pluginId).statusBarItems.push(item);
    return item;
  }

  addSettingTab(pluginId: string, tab: unknown): void {
    this.resource(pluginId).settingTabs.push(tab);
  }

  getSettingTabs(pluginId: string): unknown[] {
    return [...this.resource(pluginId).settingTabs];
  }

  registerView(
    pluginId: string,
    type: string,
    factory: (leaf: unknown) => unknown,
  ): void {
    if (!type || typeof factory !== "function")
      throw new Error("View registration needs a type and a factory");
    if (this.views.has(type))
      throw new Error(`View type is already registered: ${type}`);
    this.views.set(type, factory);
    this.resource(pluginId).views.add(type);
    this.viewListener?.(type);
  }

  /** Called after each `registerView`; the workspace loads leaves waiting for that type. */
  viewListener?: (type: string) => void;

  getView(type: string): ((leaf: unknown) => unknown) | undefined {
    return this.views.get(type);
  }

  registerExtensions(
    pluginId: string,
    extensions: readonly string[],
    viewType: string,
  ): void {
    for (const extension of extensions) {
      const key = extension.toLowerCase();
      if (this.extensions.has(key))
        throw new Error(`File extension is already registered: ${extension}`);
      this.extensions.set(key, viewType);
      this.resource(pluginId).extensions.add(key);
    }
  }

  getViewTypeForExtension(extension: string): string | undefined {
    return this.extensions.get(extension.toLowerCase());
  }

  registerMarkdownCodeBlockProcessor(
    pluginId: string,
    language: string,
    handler: (source: string, el: HTMLElement, ctx: unknown) => unknown,
  ): void {
    if (this.codeBlockProcessors.has(language))
      throw new Error(`Code block language is already registered: ${language}`);
    this.codeBlockProcessors.set(language, handler);
    this.resource(pluginId).codeBlockProcessors.add(language);
  }

  getCodeBlockProcessor(
    language: string,
  ): ((source: string, el: HTMLElement, ctx: unknown) => unknown) | undefined {
    return this.codeBlockProcessors.get(language);
  }

  registerMarkdownPostProcessor(pluginId: string, handler: unknown): void {
    this.postProcessors.push(handler);
    this.resource(pluginId).postProcessors.add(handler);
  }

  getMarkdownPostProcessors(): unknown[] {
    return [...this.postProcessors];
  }

  registerEditorSuggest(pluginId: string, suggest: unknown): void {
    this.resource(pluginId).editorSuggests.add(suggest);
  }

  getEditorSuggests(): unknown[] {
    return [...this.resources.values()].flatMap((resources) => [
      ...resources.editorSuggests,
    ]);
  }

  registerObsidianProtocolHandler(
    pluginId: string,
    action: string,
    handler: ObsidianProtocolHandler,
  ): void {
    if (typeof handler !== "function")
      throw new TypeError("Protocol handlers must be functions");
    if (this.protocolHandlers.has(action))
      throw new Error(`Protocol action is already registered: ${action}`);
    this.protocolHandlers.set(action, handler);
    this.resource(pluginId).protocolHandlers.add(action);
  }

  /**
   * Runs the plugin handler for an `obsidian://` link opened inside Basalt.
   * False when the URL is not one or no plugin handles its action.
   */
  handleObsidianUrl(url: string): boolean {
    const data = parseObsidianUrl(url);
    const handler = data && this.protocolHandlers.get(data.action);
    if (!data || !handler) return false;
    void Promise.resolve()
      .then(() => handler(data))
      .catch((error) => console.error(`obsidian://${data.action}:`, error));
    return true;
  }

  /** Remove every contribution of one plugin. Called from its unload path. */
  removePlugin(pluginId: string): void {
    const resources = this.resources.get(pluginId);
    if (!resources) return;
    for (const command of resources.commands) { this.commands.delete(command); this.defaultHotkeys.delete(command); }
    for (const icon of resources.ribbonIcons) icon.remove();
    for (const item of resources.statusBarItems) item.remove();
    for (const type of resources.views) this.views.delete(type);
    for (const extension of resources.extensions)
      this.extensions.delete(extension);
    for (const language of resources.codeBlockProcessors)
      this.codeBlockProcessors.delete(language);
    for (const handler of resources.postProcessors) {
      const index = this.postProcessors.indexOf(handler);
      if (index >= 0) this.postProcessors.splice(index, 1);
    }
    for (const action of resources.protocolHandlers)
      this.protocolHandlers.delete(action);
    this.resources.delete(pluginId);
  }
}
