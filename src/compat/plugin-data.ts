import { TFile, TFolder } from "./files";
import type { PluginDataStore } from "./plugin";
import { PLUGIN_DIRECTORY } from "./plugin-bundles";
import type { Vault } from "./vault";

const PLUGIN_ID = /^[a-z0-9][a-z0-9_-]*$/;
/** Settings files are small; a larger file is almost certainly not settings. */
export const MAX_PLUGIN_DATA_BYTES = 16 * 1024 * 1024;

/**
 * Settings tabs call `saveData` on every keystroke. Writes are coalesced per
 * plugin: one write after typing pauses for `debounceMs`, but never later than
 * `maxWaitMs` after the first unsaved change. Every vault write of data.json
 * also leaves a history backup, so this keeps one backup per edit burst
 * instead of one per character.
 */
export interface PluginDataTiming {
  debounceMs: number;
  maxWaitMs: number;
}
export const PLUGIN_DATA_TIMING: PluginDataTiming = {
  debounceMs: 1000,
  maxWaitMs: 5000,
};

interface PendingWrite {
  text: string;
  since: number;
  timer: ReturnType<typeof setTimeout> | null;
  waiters: Array<{ resolve(): void; reject(error: unknown): void }>;
}

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
  /** Coalesced `saveData` values that are not yet handed to the queue. */
  private readonly pending = new Map<string, PendingWrite>();
  /** After `close()`, writes go straight to the vault again. */
  private immediate = false;

  constructor(
    private readonly vault: Vault,
    private readonly vaultId: string,
    private readonly legacy: Pick<
      Storage,
      "getItem" | "removeItem"
    > = localStorage,
    private readonly root = PLUGIN_DIRECTORY,
    private readonly timing: PluginDataTiming = PLUGIN_DATA_TIMING,
  ) {}

  read(id: string): Promise<unknown> {
    // A read after an unsaved `saveData` must see that value, so write it now.
    void this.flushOne(id);
    return this.serialized(id, () => this.readNow(id));
  }

  /**
   * Resolves once the value (or a newer one saved in the same burst) is on
   * disk. Invalid values are rejected right away, not after the delay.
   */
  write(id: string, value: unknown): Promise<void> {
    let text: string;
    try {
      this.dataPath(id);
      text = serialize(id, value);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.immediate)
      return this.serialized(id, () => this.writeNow(id, text));
    const now = Date.now();
    let entry = this.pending.get(id);
    if (entry) {
      entry.text = text;
      if (entry.timer) clearTimeout(entry.timer);
    } else {
      entry = { text, since: now, timer: null, waiters: [] };
      this.pending.set(id, entry);
    }
    const delay = Math.max(
      0,
      Math.min(
        this.timing.debounceMs,
        entry.since + this.timing.maxWaitMs - now,
      ),
    );
    entry.timer = setTimeout(() => void this.flushOne(id), delay);
    const waiters = entry.waiters;
    return new Promise<void>((resolve, reject) =>
      waiters.push({ resolve, reject }),
    );
  }

  /** True while a coalesced value has not been handed to the vault yet. */
  hasPendingWrites(): boolean {
    return this.pending.size > 0;
  }

  /** Writes every coalesced value now and waits until all writes settled. */
  async flush(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((id) => this.flushOne(id)));
    await Promise.all([...this.queues.values()]);
  }

  /** Flushes and makes later writes (e.g. from `onunload`) go out directly. */
  close(): Promise<void> {
    this.immediate = true;
    return this.flush();
  }

  private flushOne(id: string): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) return Promise.resolve();
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    const written = this.serialized(id, () => this.writeNow(id, entry.text));
    return written.then(
      () => entry.waiters.forEach((waiter) => waiter.resolve()),
      (error) => entry.waiters.forEach((waiter) => waiter.reject(error)),
    );
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

  private async writeNow(id: string, text: string): Promise<void> {
    const existing = this.dataFile(id);
    if (existing) {
      // Unchanged settings (a toggle flipped and back) need no write or backup.
      if ((await this.vault.read(existing)) === text) {
        this.legacy.removeItem(legacyPluginDataKey(this.vaultId, id));
        return;
      }
      await this.vault.modify(existing, text);
    } else {
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

function serialize(id: string, value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined)
    throw new TypeError("Plugin data must be a JSON value");
  if (new TextEncoder().encode(text).byteLength > MAX_PLUGIN_DATA_BYTES)
    throw new Error(`Plugin "${id}" data exceeds the 16 MiB limit`);
  return text;
}
