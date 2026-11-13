import { TFile, TFolder } from "./files";
import type { PluginDataStore } from "./plugin";
import { PLUGIN_DIRECTORY } from "./plugin-bundles";
import type { Vault } from "./vault";

const PLUGIN_ID = /^[a-z0-9][a-z0-9_-]*$/;
/** Settings files are small; a larger file is almost certainly not settings. */
export const MAX_PLUGIN_DATA_BYTES = 16 * 1024 * 1024;

/** Where `loadData`/`saveData` used to live before they moved into the vault. */
export function legacyPluginDataKey(vaultId: string, id: string): string {
  return `basalt-plugin-settings:${JSON.stringify([vaultId, id])}`;
}

/**
 * Stores `Plugin.loadData`/`saveData` as `Basalt/Plugins/<id>/data.json`, the
 * same place Obsidian uses (`.obsidian/plugins/<id>/data.json`). Settings then
 * travel with the vault (backups, a second device, reinstalling the app) instead
 * of staying in one WebView's localStorage.
 *
 * Values that an older Basalt kept in localStorage are still returned until the
 * plugin saves again; the first successful file write removes the old entry, so
 * an upgrade never loses settings and never reads stale ones afterwards.
 */
export class VaultPluginDataStore implements PluginDataStore {
  /** Saves for one plugin run in call order, so the last `saveData` wins. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly vault: Vault,
    private readonly vaultId: string,
    private readonly legacy: Pick<
      Storage,
      "getItem" | "removeItem"
    > = localStorage,
    private readonly root = PLUGIN_DIRECTORY,
  ) {}

  read(id: string): Promise<unknown> {
    return this.serialized(id, () => this.readNow(id));
  }

  write(id: string, value: unknown): Promise<void> {
    return this.serialized(id, () => this.writeNow(id, value));
  }

  private async readNow(id: string): Promise<unknown> {
    const file = this.dataFile(id);
    if (file) {
      if (file.stat.size > MAX_PLUGIN_DATA_BYTES)
        throw new Error(`Plugin "${id}" data.json exceeds the 16 MiB limit`);
      const text = await this.vault.read(file);
      // An empty file is what a crash between create and write leaves behind.
      if (!text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        // Failing loudly keeps the plugin from saving defaults over a file the
        // user may still want to repair by hand.
        throw new Error(`Plugin "${id}" data.json is not valid JSON`);
      }
    }
    const legacy = this.legacy.getItem(legacyPluginDataKey(this.vaultId, id));
    return legacy === null ? null : JSON.parse(legacy);
  }

  private async writeNow(id: string, value: unknown): Promise<void> {
    const text = JSON.stringify(value, null, 2);
    if (text === undefined)
      throw new TypeError("Plugin data must be a JSON value");
    if (new TextEncoder().encode(text).byteLength > MAX_PLUGIN_DATA_BYTES)
      throw new Error(`Plugin "${id}" data exceeds the 16 MiB limit`);
    const existing = this.dataFile(id);
    if (existing) await this.vault.modify(existing, text);
    else {
      await this.ensureFolder(`${this.root}/${id}`);
      await this.vault.create(this.dataPath(id), text);
    }
    this.legacy.removeItem(legacyPluginDataKey(this.vaultId, id));
  }

  private dataPath(id: string): string {
    if (!PLUGIN_ID.test(id)) throw new Error("Invalid plugin id");
    return `${this.root}/${id}/data.json`;
  }

  private dataFile(id: string): TFile | null {
    const entry = this.vault.getAbstractFileByPath(this.dataPath(id));
    if (entry && !(entry instanceof TFile))
      throw new Error(`Plugin "${id}" data.json is not a file`);
    return entry instanceof TFile ? entry : null;
  }

  /** Create missing folders one level at a time; never touches existing ones. */
  private async ensureFolder(path: string): Promise<void> {
    let current = "";
    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      const entry = this.vault.getAbstractFileByPath(current);
      if (entry instanceof TFolder) continue;
      if (entry) throw new Error(`${current} is a file, not a folder`);
      await this.vault.createFolder(current);
    }
  }

  private serialized<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => undefined);
    this.queues.set(id, settled);
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id);
    });
    return next;
  }
}
