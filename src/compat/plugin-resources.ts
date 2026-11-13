import { invoke } from "@tauri-apps/api/core";

/**
 * Host side of resource URLs for plugin folders. The native app grants a
 * random, per-plugin base URL that only serves `Basalt/Plugins/<id>/…` of the
 * current vault session (see `src-tauri/src/resources.rs` and SECURITY.md).
 */
export interface PluginResourceHost {
  /** Base URL ending in `/` for the plugin folder, valid until revoked. */
  grant(pluginId: string): Promise<string>;
  revoke(pluginId: string): Promise<void>;
}

export type PluginResourceInvoke = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

const RESOURCE_BASE =
  /^(?:basalt-resource:\/\/localhost|https?:\/\/basalt-resource\.localhost)\/[0-9a-f]{64}\/$/;

export class NativePluginResources implements PluginResourceHost {
  private readonly run: PluginResourceInvoke;

  constructor(
    private readonly vaultId: string,
    run?: PluginResourceInvoke,
  ) {
    this.run = run ?? ((command, args) => invoke(command, args));
  }

  async grant(pluginId: string): Promise<string> {
    const base = await this.run("plugin_resource_grant", {
      vaultId: this.vaultId,
      pluginId,
    });
    if (typeof base !== "string" || !RESOURCE_BASE.test(base))
      throw new Error("Native resource grant returned an invalid URL");
    return base;
  }

  async revoke(pluginId: string): Promise<void> {
    await this.run("plugin_resource_revoke", {
      vaultId: this.vaultId,
      pluginId,
    });
  }
}

/**
 * Granted base URLs of the active plugins, shared by the bundle host (which
 * grants and revokes around activation) and the adapter (which only reads,
 * because `getResourcePath` is synchronous).
 */
export class PluginResourceUrls {
  private readonly bases = new Map<string, string>();

  constructor(private readonly host: PluginResourceHost | null) {}

  get available(): boolean {
    return this.host !== null;
  }

  async grant(pluginId: string): Promise<void> {
    if (!this.host) return;
    this.bases.set(pluginId, await this.host.grant(pluginId));
  }

  async revoke(pluginId: string): Promise<void> {
    if (!this.bases.delete(pluginId) || !this.host) return;
    await this.host.revoke(pluginId);
  }

  /**
   * URL for a path below `Basalt/Plugins/<id>`; `rest` may name a folder
   * (tesseract.js appends file names to `langPath`). Null without a grant.
   */
  url(pluginId: string, rest: string): string | null {
    const base = this.bases.get(pluginId);
    if (base === undefined) return null;
    return base + rest.split("/").map(encodeURIComponent).join("/");
  }
}
