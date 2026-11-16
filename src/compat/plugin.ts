import { Component } from "./component";
import { constructLegacy } from "./legacy-constructor";
import type { Extension } from "@codemirror/state";
import type { EditorExtensionRegistry } from "./editor-extensions";
import type {
  ObsidianProtocolHandler,
  PluginCommand,
  PluginServices,
} from "./plugin-services";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
  isDesktopOnly?: boolean;
  dir?: string;
}

export interface PluginDataStore {
  read(id: string): Promise<unknown>;
  write(id: string, value: unknown): Promise<void>;
}

const storage = new WeakMap<object, PluginDataStore>();
const editorHosts = new WeakMap<object, EditorExtensionRegistry>();
const pluginServices = new WeakMap<object, PluginServices>();
function cloneJson(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError("Plugin data must be a JSON value");
  return JSON.parse(encoded);
}

function validId(id: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error("Invalid plugin id");
}

/** Host API shared by compiled plugins and explicitly enabled external bundles. */
export class Plugin extends Component {
  static call(receiver: Plugin, app: object, manifest: PluginManifest): Plugin {
    return constructLegacy(this, receiver, [app, manifest]);
  }
  static apply(receiver: Plugin, args: ArrayLike<unknown>): Plugin {
    return constructLegacy(this, receiver, args);
  }

  private epoch = 0;
  constructor(
    readonly app: object,
    readonly manifest: PluginManifest,
  ) {
    super();
    validId(manifest.id);
  }

  private dataStore(): PluginDataStore {
    const backend = storage.get(this.app);
    if (!backend)
      throw new Error("Plugin data storage is not registered for this host");
    return backend;
  }
  async loadData(): Promise<unknown> {
    const value = await this.dataStore().read(this.manifest.id);
    return value === undefined ? null : cloneJson(value);
  }
  async saveData(value: unknown): Promise<void> {
    await this.dataStore().write(this.manifest.id, cloneJson(value));
  }

  registerEditorExtension(extension: Extension): void {
    const host = editorHosts.get(this.app);
    if (!host)
      throw new Error("Editor extensions are not available in this host");
    this.register(host.register(extension));
  }

  private services(): PluginServices {
    const host = pluginServices.get(this.app);
    if (!host)
      throw new Error("Plugin services are not available in this host");
    return host;
  }

  addCommand(command: PluginCommand): PluginCommand {
    if (!command.id || !command.name)
      throw new Error("Plugin commands need an id and a name");
    const registered = {
      ...command,
      id: `${this.manifest.id}:${command.id}`,
      name: `${this.manifest.name}: ${command.name}`,
    };
    this.services().addCommand(this.manifest.id, registered);
    return registered;
  }

  removeCommand(id: string): void {
    this.services().removeCommand(
      this.manifest.id,
      `${this.manifest.id}:${id}`,
    );
  }

  addRibbonIcon(
    icon: string,
    title: string,
    callback: (event: MouseEvent) => unknown,
  ): HTMLElement {
    return this.services().addRibbonIcon(
      this.manifest.id,
      icon,
      title,
      callback,
    );
  }

  addStatusBarItem(): HTMLElement {
    return this.services().addStatusBarItem(this.manifest.id);
  }

  addSettingTab(tab: unknown): void {
    this.services().addSettingTab(this.manifest.id, tab);
  }

  registerView(type: string, factory: (leaf: unknown) => unknown): void {
    this.services().registerView(this.manifest.id, type, factory);
  }

  registerExtensions(extensions: readonly string[], viewType: string): void {
    this.services().registerExtensions(this.manifest.id, extensions, viewType);
  }

  registerMarkdownCodeBlockProcessor(
    language: string,
    handler: (source: string, el: HTMLElement, ctx: unknown) => unknown,
  ): void {
    this.services().registerMarkdownCodeBlockProcessor(
      this.manifest.id,
      language,
      handler,
    );
  }

  registerMarkdownPostProcessor(handler: unknown): void {
    this.services().registerMarkdownPostProcessor(this.manifest.id, handler);
  }

  /** Registers a hover-link source on the workspace for this plugin's lifetime. */
  registerHoverLinkSource(id: string, info: { display: string; defaultMod: boolean }): void {
    const workspace = (this.app as {
      workspace?: {
        registerHoverLinkSource(id: string, info: unknown): void;
        unregisterHoverLinkSource(id: string): void;
      };
    }).workspace;
    if (!workspace) throw new Error("Hover link sources are not available in this host");
    workspace.registerHoverLinkSource(id, info);
    this.register(() => workspace.unregisterHoverLinkSource(id));
  }

  /**
   * Handles `obsidian://<action>?…` links that are opened inside Basalt (in
   * notes, canvases and plugin views). Basalt does not register the scheme
   * with the system, so links from other apps do not arrive.
   */
  registerObsidianProtocolHandler(
    action: string,
    handler: ObsidianProtocolHandler,
  ): void {
    this.services().registerObsidianProtocolHandler(
      this.manifest.id,
      action,
      handler,
    );
  }

  registerEditorSuggest(suggest: unknown): void {
    this.services().registerEditorSuggest(this.manifest.id, suggest);
  }

  /** Compiled, explicitly supplied plugin constructors only; never evaluates source strings. */
  async activate(): Promise<void> {
    if (!this.beginLifecycle()) return;
    const epoch = ++this.epoch;
    try {
      await this.onload();
      await (this.app as { workspace?: { flushLayoutReady?(): Promise<void> } }).workspace?.flushLayoutReady?.();
      if (epoch !== this.epoch)
        throw new Error("Plugin activation was cancelled");
    } catch (error) {
      try {
        await this.unloadAsync();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Plugin load and rollback failed",
        );
      }
      throw error;
    }
  }

  override unload(): void {
    ++this.epoch;
    try {
      super.unload();
    } finally {
      pluginServices.get(this.app)?.removePlugin(this.manifest.id);
    }
  }
}

export type PluginConstructor = new (
  app: object,
  manifest: PluginManifest,
) => Plugin;
interface Entry {
  plugin: Plugin;
  activated: Promise<Plugin>;
  stopping?: Promise<void>;
}

/** Host-managed registry, isolated from the main app until the rest of the Obsidian API exists. */
/**
 * Loads and unloads installed bundles by id, for plugins that reload
 * themselves (or others) through `app.plugins.enablePlugin`/`disablePlugin`.
 */
export interface PluginToggleHost {
  enable(id: string): Promise<unknown>;
  disable(id: string): Promise<void>;
  /** Persists the current enabled set (the `...AndSave` variants). */
  save(): void;
}

export class PluginRegistry {
  readonly plugins: Record<string, Plugin> = Object.create(null);
  readonly enabledPlugins = new Set<string>();
  private readonly entries = new Map<string, Entry>();
  private toggleHost: PluginToggleHost | null = null;

  constructor(
    private readonly app: object,
    data: PluginDataStore,
    private readonly mobile = false,
    extensions?: EditorExtensionRegistry,
    services?: PluginServices,
  ) {
    if (storage.has(app))
      throw new Error("This app already has a plugin data registry");
    storage.set(app, data);
    if (extensions) editorHosts.set(app, extensions);
    if (services) pluginServices.set(app, services);
  }

  enable(
    manifest: PluginManifest,
    Constructor: PluginConstructor,
  ): Promise<Plugin> {
    validId(manifest.id);
    if (this.mobile && manifest.isDesktopOnly)
      return Promise.reject(
        new Error("Desktop-only plugin cannot run on mobile"),
      );
    const previous = this.entries.get(manifest.id);
    if (previous?.stopping)
      return previous.stopping.then(() => this.enable(manifest, Constructor));
    if (previous) return previous.activated;
    const immutableManifest = Object.freeze({ ...manifest });
    const plugin = new Constructor(this.app, immutableManifest);
    const entry: Entry = { plugin, activated: Promise.resolve(plugin) };
    this.entries.set(manifest.id, entry);
    this.plugins[manifest.id] = plugin;
    entry.activated = Promise.resolve().then(async () => {
      if (this.entries.get(manifest.id) !== entry || entry.stopping)
        throw new Error("Plugin activation was cancelled");
      try {
        await plugin.activate();
        if (entry.stopping) throw new Error("Plugin activation was cancelled");
        this.enabledPlugins.add(manifest.id);
        return plugin;
      } catch (error) {
        if (!entry.stopping && this.entries.get(manifest.id) === entry) {
          this.entries.delete(manifest.id);
          delete this.plugins[manifest.id];
        }
        throw error;
      }
    });
    // Hosts still receive the rejected activation promise; ignoring it cannot cause an unhandled rejection.
    void entry.activated.catch(() => {});
    return entry.activated;
  }

  setToggleHost(host: PluginToggleHost): void {
    this.toggleHost = host;
  }

  private host(): PluginToggleHost {
    if (!this.toggleHost)
      throw new Error("Plugins cannot be enabled or disabled here");
    return this.toggleHost;
  }

  getPlugin(id: string): Plugin | null {
    return this.plugins[id] ?? null;
  }

  /**
   * Obsidian's `app.plugins.enablePlugin`: loads an installed bundle for this
   * session (re-reading its files, so updated code takes effect). Unlike
   * Obsidian, a failure rejects instead of resolving `false`, so it stays
   * visible to the caller.
   */
  async enablePlugin(id: string): Promise<boolean> {
    await this.host().enable(id);
    return true;
  }

  disablePlugin(id: string): Promise<void> {
    return this.host().disable(id);
  }

  async enablePluginAndSave(id: string): Promise<boolean> {
    await this.enablePlugin(id);
    this.host().save();
    return true;
  }

  async disablePluginAndSave(id: string): Promise<void> {
    await this.disablePlugin(id);
    this.host().save();
  }

  disable(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    if (entry.stopping) return entry.stopping;
    this.enabledPlugins.delete(id);
    delete this.plugins[id];
    // Stop owned resources immediately, but never start a replacement instance while the
    // old async onload is still running and could write that plugin's settings.
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    entry.stopping = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    void entry.stopping.catch(() => {});
    // Publish the stopping state before invoking a plugin hook: hooks can re-enter the registry.
    const shutdown = (async () => {
      const workspace = (this.app as { workspace?: { closePluginViews?(id: string): Promise<void> | undefined; flushPending?(): Promise<void> } }).workspace;
      const closing = workspace?.closePluginViews?.(id);
      if (closing) await closing;
      await entry.plugin.unloadAsync();
      await workspace?.flushPending?.();
    })();
    void Promise.allSettled([shutdown, entry.activated]).then((results) => {
      if (this.entries.get(id) === entry) this.entries.delete(id);
      if (results[0].status === "rejected") reject(results[0].reason);
      else resolve();
    });
    return entry.stopping;
  }
}
