import { Editor, type EditorViewPort } from "./editor-adapter";
import { PluginCanvas } from "./canvas";
import { EditorExtensionRegistry } from "./editor-extensions";
import { editorModules } from "./editor-modules";
import { EmbedRegistry } from "./embeds";
import { VaultAdapter } from "./adapter";
import { FileManager } from "./file-manager";
import { MetadataCache } from "./metadata-cache";
import { NativeVaultPort } from "./native-port";
import {
  createObsidianApi,
  editorInfoEffect,
  editorInfoField,
  Scope,
} from "./obsidian-api";
import type { RequestUrl } from "./request";
import { PluginRegistry } from "./plugin";
import { VaultPluginBundles } from "./plugin-bundles";
import { VaultPluginDataStore } from "./plugin-data";
import { PluginBundleHost } from "./plugin-host";
import {
  NativePluginResources,
  PluginResourceUrls,
  type PluginResourceHost,
} from "./plugin-resources";
import { PluginServices } from "./plugin-services";
import { ScopedVaultPort } from "./scoped-port";
import type { VaultStoragePort } from "./storage-port";
import { Vault } from "./vault";
import { MarkdownView, Workspace } from "./workspace";

export interface CompatibilityOptions {
  vaultId: string;
  name: string;
  mobile: boolean;
  editor: Editor;
  extensions: EditorExtensionRegistry;
  container: HTMLElement;
  navigate(path: string): Promise<void>;
  /** Tests may use an isolated storage port; the native app always uses NativeVaultPort. */
  port?: VaultStoragePort;
  basePath?: string | null;
  renderMarkdown?(markdown: string): string;
  ribbonEl?: HTMLElement;
  statusBarEl?: HTMLElement;
  /** HTTP transport for `requestUrl`; the native app routes it through Rust. */
  requestUrl?: RequestUrl;
  /**
   * Resource URLs for plugin folders. Defaults to the native protocol only
   * with the native port; isolated ports get none unless a test passes one.
   */
  resources?: PluginResourceHost | null;
  /** Whether `FileManager.renameFile` rewrites links; off unless given. */
  updateLinks?: () => boolean;
  /** The attachment folder setting (see `attachmentFolder`); "./" if not given. */
  attachmentFolder?: () => string;
  /**
   * Called around plugin (re)loads that plugins start themselves through
   * `app.plugins`: the app releases plugin-owned UI before a plugin unloads
   * and rebuilds it afterwards (`error` is set when loading failed).
   */
  pluginUi?: {
    release(): void;
    refresh(id: string, error?: unknown): void;
  };
}

/** Internal app bridge, not an external plugin loader or a global `window.app`. */
export class CompatibilitySession {
  readonly id: string;
  readonly vault: Vault;
  /** `Basalt/Plugins`, hidden from `vault` like Obsidian hides `.obsidian`. */
  readonly configVault: Vault;
  /**
   * Plugins that were enabled last time but failed to start (for example on a
   * corrupt `data.json`). They are dropped from the enabled list, so the app
   * must show these errors; otherwise a plugin silently disappears.
   */
  readonly restoreFailures = new Map<string, unknown>();
  readonly workspace: Workspace;
  readonly plugins: PluginRegistry;
  readonly fileManager: FileManager;
  readonly metadataCache: MetadataCache;
  readonly embedRegistry: EmbedRegistry;
  readonly services: PluginServices;
  readonly bundles: VaultPluginBundles;
  readonly bundleHost: PluginBundleHost;
  readonly internalPlugins = { plugins: { canvas: {
    _loaded: true,
    views: { canvas: (_leaf: unknown) => ({ canvas: new PluginCanvas(this.vault) }) },
  } } };
  readonly hotkeyManager = { addDefaultHotkeys: (id: string, hotkeys: import("./plugin-services").PluginHotkey[]) => this.services.addDefaultHotkeys(id, hotkeys) };
  readonly statusBar: { containerEl: HTMLElement };
  readonly commands: {
    readonly commands: Record<
      string,
      import("./plugin-services").RegisteredCommand
    >;
    removeCommand(id: string): void;
    executeCommandById(id: string): boolean;
  };
  readonly scope = new Scope();
  private readonly scopes: Scope[] = [];
  readonly keymap = {
    getRootScope: () => this.scope,
    pushScope: (scope: Scope) => this.scopes.push(scope),
    popScope: (scope: Scope) => { const index = this.scopes.lastIndexOf(scope); if (index >= 0) this.scopes.splice(index, 1); },
  };
  private readonly keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if ((this.scopes.at(-1) ?? this.scope).handle(event)) event.preventDefault();
    else this.services.handleKeydown(event);
  };
  private readonly editorInfoCleanup: () => void;
  private disposePromise: Promise<void> | null = null;

  private constructor(options: CompatibilityOptions) {
    this.id = options.vaultId;
    if (options.port && options.port.vaultId !== options.vaultId)
      throw new Error(
        "Compatibility storage port belongs to a different vault",
      );
    const port = options.port ?? new NativeVaultPort(options.vaultId);
    const resources = new PluginResourceUrls(
      options.resources !== undefined
        ? options.resources
        : options.port
          ? null
          : new NativePluginResources(options.vaultId),
    );
    this.vault = new Vault(ScopedVaultPort.content(port), options.name);
    this.configVault = new Vault(
      ScopedVaultPort.pluginConfig(port),
      options.name,
    );
    this.vault.adapter = new VaultAdapter(
      this.vault,
      options.basePath ?? null,
      this.configVault,
      resources,
    );
    this.fileManager = new FileManager(
      this.vault,
      options.updateLinks,
      options.attachmentFolder,
    );
    this.metadataCache = new MetadataCache(this.vault);
    this.embedRegistry = new EmbedRegistry(this.metadataCache);
    const view = new MarkdownView(options.editor, options.container);
    this.workspace = new Workspace(
      view,
      async (file) => {
        if (
          file.vault !== this.vault ||
          this.vault.getFileByPath(file.path) !== file
        )
          throw new Error("File belongs to another or stale vault");
        await options.navigate(file.path);
        if (file.extension.toLowerCase() === "md" && view.file !== file)
          throw new Error("The note could not be opened");
      },
      options.extensions,
    );
    this.statusBar = {
      containerEl: options.statusBarEl ?? document.createElement("div"),
    };
    this.services = new PluginServices(
      options.ribbonEl,
      options.statusBarEl,
      undefined,
      () => (this.workspace.activeEditor ? { editor: view.editor, view } : null),
    );
    this.commands = {
      commands: this.services.commandIndex,
      removeCommand: (id) => this.services.removeCommandById(id),
      executeCommandById: (id) => {
        if (!this.services.isCommandAvailable(id)) return false;
        Promise.resolve(this.services.runCommand(id)).catch((error) =>
          console.error("Plugin command failed", error),
        );
        return true;
      },
    };
    this.workspace.connect(this, this.services);
    document.addEventListener("keydown", this.keydown);
    this.plugins = new PluginRegistry(
      this,
      new VaultPluginDataStore(this.configVault, options.vaultId),
      options.mobile,
      options.extensions,
      this.services,
    );
    this.bundles = new VaultPluginBundles(this.configVault);
    this.bundleHost = new PluginBundleHost({
      bundles: this.bundles,
      registry: this.plugins,
      resources,
      moduleHost: {
        obsidian: createObsidianApi({
          app: this,
          basePath: options.basePath,
          renderMarkdown: options.renderMarkdown,
          requestUrl: options.requestUrl,
        }),
        modules: editorModules,
      },
    });
    this.editorInfoCleanup = options.extensions.register(editorInfoField);
    const ui = options.pluginUi;
    this.plugins.setToggleHost({
      enable: async (id) => {
        // A self-update writes new files first; pick them up before loading.
        await this.configVault.refresh();
        try {
          await this.bundleHost.enable(id);
        } catch (error) {
          ui?.refresh(id, error);
          throw error;
        }
        ui?.refresh(id);
      },
      disable: async (id) => {
        ui?.release();
        try {
          await this.bundleHost.disable(id);
        } finally {
          ui?.refresh(id);
        }
      },
      save: () => this.saveEnabledPlugins(),
    });
  }

  static async create(
    options: CompatibilityOptions,
  ): Promise<CompatibilitySession> {
    const session = new CompatibilitySession(options);
    try {
      await session.vault.initialize();
      await session.configVault.initialize();
      session.setActivePath(null);
      // Warm parsed metadata before plugins load so `getFileCache` is useful.
      await session.metadataCache.reindex();
      const saved = session.savedPluginIds();
      const restored: string[] = [];
      for (const id of saved) {
        try {
          await session.bundleHost.enable(id);
          restored.push(id);
        } catch (error) {
          console.warn(`Plugin ${id} could not be restored`, error);
          session.restoreFailures.set(id, error);
        }
      }
      if (restored.length !== saved.length)
        localStorage.setItem(
          session.enabledStorageKey,
          JSON.stringify(restored),
        );
      return session;
    } catch (error) {
      try {
        await session.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Session initialization and cleanup failed",
        );
      }
      throw error;
    }
  }

  private get enabledStorageKey(): string {
    return `basalt-plugin-enabled:${JSON.stringify(this.id)}`;
  }

  private savedPluginIds(): string[] {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(this.enabledStorageKey) ?? "[]",
      );
      return Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  }

  saveEnabledPlugins(): void {
    localStorage.setItem(
      this.enabledStorageKey,
      JSON.stringify([...this.plugins.enabledPlugins]),
    );
  }

  setActivePath(path: string | null): void {
    const file = path === null ? null : this.vault.getFileByPath(path);
    // Publish editorInfoField first: file-open listeners must never observe the
    // previous file in the editor state.
    this.editorInfo(this.workspace.markdownView.editor.cm, file);
    this.workspace.setActiveFile(file);
  }

  /** Scoped per vault, as in Obsidian: logins and device ids must not leak. */
  private localStorageKey(key: string): string {
    return `basalt-app:${JSON.stringify([this.id, key])}`;
  }

  /** Re-read both the content view and the plugin configuration view. */
  async refresh(): Promise<void> {
    await this.vault.refresh();
    await this.configVault.refresh();
  }

  loadLocalStorage(key: string): unknown {
    const value = localStorage.getItem(this.localStorageKey(key));
    if (value === null) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  saveLocalStorage(key: string, value: unknown): void {
    if (value === null || value === undefined)
      localStorage.removeItem(this.localStorageKey(key));
    else localStorage.setItem(this.localStorageKey(key), JSON.stringify(value));
  }

  getAccentColor(): string {
    return getComputedStyle(document.body).getPropertyValue("--interactive-accent").trim();
  }

  private editorInfo(cm: EditorViewPort, file: import("./files").TFile | null) {
    cm.dispatch({ effects: editorInfoEffect.of({ file, app: this }) });
  }

  dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      try {
        // The host owns cancellation, plugin shutdown and style removal, so one
        // failing plugin cannot prevent the remaining cleanup.
        await this.bundleHost.dispose();
      } finally {
        document.removeEventListener("keydown", this.keydown);
        try {
          // Editor extensions belong to this session alone. Only clear the field
          // if it still points at this session, otherwise a replacement session's
          // active editor info would be erased.
          this.clearEditorInfoIfOwned();
        } finally {
          this.editorInfoCleanup();
        }
      }
    })();
    return this.disposePromise;
  }

  private clearEditorInfoIfOwned(): void {
    const cm = this.workspace.markdownView.editor.cm;
    const info = cm.state.field(editorInfoField, false);
    if (info?.app === this) cm.dispatch({ effects: editorInfoEffect.of(null) });
  }
}
