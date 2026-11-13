import type { Plugin } from "./plugin";
import type { PluginManifest } from "./plugin";
import type { PluginRegistry } from "./plugin";
import type { VaultPluginBundles } from "./plugin-bundles";
import { loadPluginConstructor, type PluginModuleHost } from "./plugin-module";
import { loadIconLibrary } from "../ui/icon-library";
import type { PluginResourceUrls } from "./plugin-resources";

interface BundleHostOptions {
  bundles: VaultPluginBundles;
  registry: PluginRegistry;
  moduleHost: PluginModuleHost;
  /** Resource URL grants, held exactly while a plugin is active. */
  resources?: PluginResourceUrls;
  /** Tests may inject a different document; the app uses the current one. */
  document?: Document;
}

interface Activation {
  promise: Promise<Plugin>;
  cancelled: boolean;
  stopping?: Promise<void>;
}

/**
 * Explicit lifecycle around installed bundles: discovery never evaluates
 * source, and only `enable(id)` compiles and activates one bundle.
 */
export class PluginBundleHost {
  private readonly enabled = new Set<string>();
  private readonly styles = new Map<string, HTMLStyleElement>();
  private readonly activations = new Map<string, Activation>();
  private readonly doc: Document;
  private closed = false;

  constructor(private readonly options: BundleHostOptions) {
    this.doc = options.document ?? document;
  }

  list(): ReturnType<VaultPluginBundles["list"]> {
    return this.options.bundles.list();
  }

  isEnabled(id: string): boolean {
    return this.enabled.has(id);
  }

  enable(id: string): Promise<Plugin> {
    if (this.closed)
      return Promise.reject(new Error("Plugin host has been disposed"));
    const pending = this.activations.get(id);
    if (pending?.stopping) return pending.stopping.then(() => this.enable(id));
    if (pending) return pending.promise;
    if (this.enabled.has(id)) {
      const existing = this.options.registry.plugins[id];
      if (existing) return Promise.resolve(existing);
    }
    const entry: Activation = {
      cancelled: false,
      promise: Promise.resolve().then(() => this.activate(id, entry)),
    };
    this.activations.set(id, entry);
    void entry.promise.catch(() => {});
    return entry.promise;
  }

  private async activate(id: string, entry: Activation): Promise<Plugin> {
    let style: HTMLStyleElement | null = null;
    try {
      // `setIcon` is synchronous, so the full Lucide set must be in memory
      // before plugin code runs; the host UI only bundles its own icons.
      const [bundle] = await Promise.all([
        this.options.bundles.read(id),
        loadIconLibrary(),
      ]);
      if (entry.cancelled || this.closed)
        throw new Error("Plugin activation was cancelled");
      const Constructor = loadPluginConstructor(
        bundle.source,
        bundle.manifest.id,
        this.options.moduleHost,
      );
      if (entry.cancelled || this.closed)
        throw new Error("Plugin activation was cancelled");
      style = bundle.styles
        ? this.injectStyles(bundle.manifest.id, bundle.styles)
        : null;
      // Granted before onload so the synchronous getResourcePath works there.
      await this.options.resources?.grant(id);
      if (entry.cancelled || this.closed)
        throw new Error("Plugin activation was cancelled");
      const plugin = await this.options.registry.enable(
        {
          ...bundle.manifest,
          dir: `.obsidian/plugins/${bundle.manifest.id}`,
        },
        Constructor,
      );
      if (entry.cancelled || this.closed) {
        await this.options.registry.disable(id);
        throw new Error("Plugin activation was cancelled");
      }
      this.enabled.add(bundle.manifest.id);
      if (style) this.styles.set(bundle.manifest.id, style);
      return plugin;
    } catch (error) {
      style?.remove();
      await this.revokeResources(id);
      throw error;
    } finally {
      if (!entry.stopping && this.activations.get(id) === entry)
        this.activations.delete(id);
    }
  }

  disable(id: string): Promise<void> {
    const entry = this.activations.get(id);
    if (entry?.stopping) return entry.stopping;
    if (entry) entry.cancelled = true;
    // Stop loaded resources immediately, including while async onload waits.
    const shutdown = this.options.registry.disable(id);
    const stopping = (async () => {
      try {
        const results = await Promise.allSettled([shutdown, entry?.promise]);
        if (results[0].status === "rejected") throw results[0].reason;
      } finally {
        await this.revokeResources(id);
        this.enabled.delete(id);
        this.styles.get(id)?.remove();
        this.styles.delete(id);
        if (entry && this.activations.get(id) === entry)
          this.activations.delete(id);
      }
    })();
    if (entry) entry.stopping = stopping;
    return stopping;
  }

  private async revokeResources(id: string): Promise<void> {
    try {
      await this.options.resources?.revoke(id);
    } catch (error) {
      // The grant dies with the native session anyway; never mask the cause.
      console.warn(`Resource URLs of plugin ${id} could not be revoked`, error);
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const ids = new Set([
      ...this.activations.keys(),
      ...Object.keys(this.options.registry.plugins),
      ...this.enabled,
    ]);
    const results = await Promise.allSettled(
      [...ids].map((id) => this.disable(id)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Plugin host cleanup failed");
  }

  manifests(): PluginManifest[] {
    return Object.values(this.options.registry.plugins).map(
      (plugin) => plugin.manifest,
    );
  }

  private injectStyles(id: string, css: string): HTMLStyleElement {
    const style = this.doc.createElement("style");
    style.dataset.basaltPlugin = id;
    style.textContent = css;
    this.doc.head.append(style);
    return style;
  }
}
