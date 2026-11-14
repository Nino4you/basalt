import { TFile } from "./files";
import type { PluginManifest } from "./plugin";
import { MAX_PLUGIN_SOURCE_BYTES, parsePluginManifest } from "./plugin-module";
import type { Vault } from "./vault";

export const PLUGIN_DIRECTORY = "Basalt/Plugins";
/**
 * Visible stand-in for the rest of Obsidian's `.obsidian` config dir, e.g.
 * Iconize's `.obsidian/icons`. Reachable for plugins only via the adapter.
 */
export const CONFIG_DIRECTORY = "Basalt/Config";
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_STYLES_BYTES = 1024 * 1024;
const PLUGIN_ID = /^[a-z0-9][a-z0-9_-]*$/;

export interface PluginBundleListing {
  /** Folder name below the plugin directory. */
  id: string;
  manifest: Readonly<PluginManifest> | null;
  error: string | null;
}

export interface PluginBundle {
  id: string;
  manifest: Readonly<PluginManifest>;
  source: string;
  styles: string | null;
}

/**
 * Reads explicitly installed plugin folders from a visible vault directory.
 * A visible directory is intentional: Android's Storage Access Framework does
 * not reliably expose hidden `.obsidian` folders. Importing an existing
 * `.obsidian/plugins` folder is a separate, explicit step.
 */
export class VaultPluginBundles {
  constructor(
    private readonly vault: Vault,
    private readonly root = PLUGIN_DIRECTORY,
  ) {
    if (
      !root ||
      root.startsWith("/") ||
      root.includes("\\") ||
      root.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Plugin directory must be a relative vault path");
  }

  /** All folders with a manifest, including broken ones for an honest UI. */
  async list(): Promise<PluginBundleListing[]> {
    const prefix = `${this.root}/`;
    const candidates: string[] = [];
    for (const entry of this.vault.getAllLoadedFiles()) {
      if (!(entry instanceof TFile)) continue;
      if (!entry.path.startsWith(prefix)) continue;
      const rest = entry.path.slice(prefix.length).split("/");
      if (rest.length !== 2 || rest[1] !== "manifest.json") continue;
      candidates.push(rest[0]);
    }
    candidates.sort();
    const seen = new Set<string>();
    const listings: PluginBundleListing[] = [];
    for (const id of candidates) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!PLUGIN_ID.test(id)) {
        listings.push({
          id,
          manifest: null,
          error: "Plugin folder name is not a valid plugin id",
        });
        continue;
      }
      try {
        listings.push({
          id,
          manifest: await this.readManifest(id),
          error: null,
        });
      } catch (error) {
        listings.push({
          id,
          manifest: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return listings;
  }

  async read(id: string): Promise<PluginBundle> {
    this.validateId(id);
    const manifest = await this.readManifest(id);
    const sourceFile = this.file(`${id}/main.js`);
    if (!sourceFile) throw new Error(`Plugin "${id}" has no main.js`);
    if (sourceFile.stat.size === 0)
      throw new Error(`Plugin "${id}" has an empty main.js`);
    if (sourceFile.stat.size > MAX_PLUGIN_SOURCE_BYTES)
      throw new Error(`Plugin "${id}" main.js exceeds the 8 MiB limit`);
    const source = await this.vault.read(sourceFile);
    if (new TextEncoder().encode(source).byteLength > MAX_PLUGIN_SOURCE_BYTES)
      throw new Error(`Plugin "${id}" main.js exceeds the 8 MiB limit`);
    const stylesFile = this.file(`${id}/styles.css`);
    let styles: string | null = null;
    if (stylesFile) {
      if (stylesFile.stat.size > MAX_STYLES_BYTES)
        throw new Error(`Plugin "${id}" styles.css exceeds the 1 MiB limit`);
      styles = await this.vault.read(stylesFile);
      if (new TextEncoder().encode(styles).byteLength > MAX_STYLES_BYTES)
        throw new Error(`Plugin "${id}" styles.css exceeds the 1 MiB limit`);
    }
    return { id, manifest, source, styles };
  }

  private async readManifest(id: string): Promise<Readonly<PluginManifest>> {
    this.validateId(id);
    const manifestFile = this.file(`${id}/manifest.json`);
    if (!manifestFile) throw new Error(`Plugin "${id}" has no manifest.json`);
    if (manifestFile.stat.size === 0)
      throw new Error(`Plugin "${id}" has an empty manifest.json`);
    if (manifestFile.stat.size > MAX_MANIFEST_BYTES)
      throw new Error(`Plugin "${id}" manifest.json exceeds the 64 KiB limit`);
    const text = await this.vault.read(manifestFile);
    if (new TextEncoder().encode(text).byteLength > MAX_MANIFEST_BYTES)
      throw new Error(`Plugin "${id}" manifest.json exceeds the 64 KiB limit`);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`Plugin "${id}" manifest.json is not valid JSON`);
    }
    return parsePluginManifest(value, id);
  }

  private file(relative: string): TFile | null {
    const entry = this.vault.getAbstractFileByPath(`${this.root}/${relative}`);
    return entry instanceof TFile ? entry : null;
  }

  private validateId(id: string): void {
    if (!PLUGIN_ID.test(id)) throw new Error("Invalid plugin id");
  }
}
