import { Events } from "./events";
import {
  FileIndex,
  TFile,
  TFolder,
  type FileEntry,
  type FileStats,
  type TAbstractFile,
} from "./files";
import type { VaultStoragePort } from "./storage-port";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", {
  fatal: true,
  // "ignoreBOM" keeps a leading BOM as U+FEFF instead of stripping it.
  ignoreBOM: true,
});
const INVALID_PATH_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

function invalidPath(path: unknown): Error {
  return new Error(
    `Invalid vault-relative path: ${typeof path === "string" ? JSON.stringify(path) : String(path)}`,
  );
}

/** Paths are always relative, slash-separated and cannot escape their parent. */
function validateRelativePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || path.length === 0) throw invalidPath(path);
  if (path.startsWith("/")) throw invalidPath(path);
  if (path.includes("\\")) throw invalidPath(path);
  if (INVALID_PATH_CHARACTERS.test(path)) throw invalidPath(path);
  if (
    path
      .split("/")
      .some((part) => part.length === 0 || part === "." || part === "..")
  )
    throw invalidPath(path);
}

function validStat(stat: unknown, path: string): FileStats {
  if (!stat || typeof stat !== "object")
    throw new Error(`Vault metadata is missing file stats for ${path}`);
  const { ctime, mtime, size } = stat as FileStats;
  if (
    ![ctime, mtime, size].every(
      (part) => typeof part === "number" && Number.isFinite(part),
    ) ||
    size < 0
  )
    throw new Error(`Vault metadata has invalid file stats for ${path}`);
  return { ctime, mtime, size };
}

function sameStat(
  first: FileStats | undefined,
  second: FileStats | undefined,
): boolean {
  return (
    !!first &&
    !!second &&
    first.ctime === second.ctime &&
    first.mtime === second.mtime &&
    first.size === second.size
  );
}

function copyBinary(data: ArrayBuffer): Uint8Array {
  let length: number;
  try {
    // A native brand check accepts genuine buffers from other JS realms,
    // unlike instanceof, while still rejecting views and SharedArrayBuffer.
    const getter = Object.getOwnPropertyDescriptor(
      ArrayBuffer.prototype,
      "byteLength",
    )!.get!;
    length = getter.call(data);
  } catch {
    throw new TypeError("Vault binary data must be an ArrayBuffer");
  }
  const copy = new Uint8Array(length);
  copy.set(new Uint8Array(data));
  return copy;
}

function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
  if (first.byteLength !== second.byteLength) return false;
  for (let index = 0; index < first.byteLength; index++)
    if (first[index] !== second[index]) return false;
  return true;
}

interface CapturedEntry {
  kind: "file" | "folder";
  file: TAbstractFile;
  stat?: FileStats;
}

interface CachedText {
  file: TFile;
  version: string;
  data: string;
}

/**
 * Metadata-and-content facade over one storage port. External changes are only
 * observed by an explicit `refresh()`; this class does not install a watcher.
 */
export class Vault extends Events {
  private readonly index: FileIndex;
  /** Host-provided storage adapter. */
  adapter: object | null = null;
  readonly configDir = ".obsidian";
  private readonly textCache = new Map<string, CachedText>();
  private cacheRevision = 0;
  private readonly queues = new Map<string, Promise<void>>();
  /** Serializes refreshes with mutations so a stale snapshot cannot publish late. */
  private gate: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly port: VaultStoragePort,
    private readonly vaultName: string,
  ) {
    super();
    if (!port || typeof port.snapshot !== "function")
      throw new TypeError("Vault requires a vault storage port");
    // The FileIndex owner is this Vault, so every TFile/TFolder.vault is stable.
    this.index = new FileIndex(this);
  }

  getName(): string {
    return this.vaultName;
  }

  /** Obsidian's internal theme lookup; the host currently ships the default theme. */
  getConfig(key: string): unknown {
    return key === "cssTheme" ? "obsidian" : undefined;
  }

  getRoot(): TFolder {
    return this.index.getRoot();
  }

  getFiles(): TFile[] {
    return this.index.getFiles();
  }

  getMarkdownFiles(): TFile[] {
    return this.index.getMarkdownFiles();
  }

  getAllLoadedFiles(): TAbstractFile[] {
    return this.index.getAllLoadedFiles();
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.index.getAbstractFileByPath(path);
  }

  /** Read-only lookup used by plugins before creating a folder. Never rewrites a path. */
  getAbstractFileByPathInsensitive(path: string): TAbstractFile | null {
    if (path === "" || path === "/") return this.getRoot();
    const exact = this.getAbstractFileByPath(path);
    if (exact) return exact;
    const matches = this.getAllLoadedFiles().filter(file => file.path.toLowerCase() === path.toLowerCase());
    if (matches.length > 1) throw new Error(`Ambiguous vault path: ${path}`);
    return matches[0] ?? null;
  }

  getFileByPath(path: string): TFile | null {
    return this.index.getFileByPath(path);
  }

  getResourcePath(file: TAbstractFile): string {
    if (!(file instanceof TFile))
      throw new TypeError("Resource URLs require a TFile");
    this.requireOwnedFile(file);
    const adapter = this.adapter as {
      getResourcePath?: (path: string) => string;
    };
    if (!adapter?.getResourcePath)
      throw new Error("This vault has no resource URL adapter");
    return adapter.getResourcePath(file.path);
  }

  getFolderByPath(path: string): TFolder | null {
    return this.index.getFolderByPath(path);
  }

  /** Initial load is a refresh from an empty metadata graph. */
  async initialize(): Promise<void> {
    await this.refresh();
  }

  /**
   * Fetch and validate a complete native snapshot, then publish the new graph
   * before emitting any diff event. Existing paths keep their object identity.
   */
  async refresh(): Promise<void> {
    await this.runExclusive(async () => {
      const snapshot = this.normalizeSnapshot(await this.port.snapshot());
      // A throwaway index validates the entire graph before published objects
      // or their stats are touched.
      new FileIndex(this).replace(snapshot);
      const before = this.captureIndex();
      this.index.replace(snapshot);
      this.invalidateTextCache();
      const after = this.captureIndex();
      this.emitDiffs(before, after);
    });
  }

  /**
   * Re-reads one known file after the host wrote it without going through
   * this vault (the app's own note saves). Much cheaper than `refresh()`,
   * which walks the whole vault; an unknown path falls back to `refresh()`.
   * Emits `modify` only when the file's stats changed, like `refresh()`.
   */
  async refreshFile(path: string): Promise<void> {
    const file = this.index.getFileByPath(path);
    if (!file) return this.refresh();
    await this.enqueue(path, async () => {
      if (this.index.getFileByPath(path) !== file) return;
      const latest = await this.port.read(path);
      if (sameStat(file.stat, latest.stat)) return;
      let text: string | undefined;
      try {
        text = this.decodeText(latest.bytes, path);
      } catch {
        // Binary or invalid UTF-8: publish the stats, leave the cache empty.
      }
      this.commitWrite(file, latest.version, latest.stat, text);
    });
  }

  async read(file: TFile): Promise<string> {
    const owned = this.requireOwnedFile(file);
    const { bytes } = await this.port.read(owned.path);
    return this.decodeText(bytes, owned.path);
  }

  async cachedRead(file: TFile): Promise<string> {
    const owned = this.requireOwnedFile(file);
    const cached = this.textCache.get(owned.path);
    if (cached && cached.file === owned) return cached.data;
    // Reads stay outside the publication gate, including reads from event
    // callbacks. A late read must not repopulate a cache invalidated meanwhile.
    const revision = this.cacheRevision;
    const { bytes, version } = await this.port.read(owned.path);
    // Never cache text against an object that refresh replaced while we waited.
    if (this.index.getFileByPath(owned.path) !== owned)
      throw new Error(
        `File metadata is stale; refresh the vault before using ${owned.path}`,
      );
    const data = this.decodeText(bytes, owned.path);
    if (revision === this.cacheRevision)
      this.textCache.set(owned.path, { file: owned, version, data });
    return data;
  }

  /**
   * `cachedRead` for many files with as few backend round-trips as the port
   * allows. Each entry is the text or the error `cachedRead` would throw.
   */
  async cachedReadMany(files: TFile[]): Promise<Array<string | Error>> {
    const results: Array<string | Error> = new Array(files.length);
    const missing: number[] = [];
    files.forEach((file, index) => {
      try {
        const owned = this.requireOwnedFile(file);
        const cached = this.textCache.get(owned.path);
        if (cached && cached.file === owned) results[index] = cached.data;
        else missing.push(index);
      } catch (error) {
        results[index] = asError(error);
      }
    });
    if (!missing.length) return results;
    if (!this.port.readMany) {
      // Single reads, a few in flight, like a caller looping over cachedRead.
      let next = 0;
      const worker = async () => {
        while (next < missing.length) {
          const index = missing[next++];
          results[index] = await this.cachedRead(files[index]).catch(asError);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(8, missing.length) }, worker),
      );
      return results;
    }
    const revision = this.cacheRevision;
    const reads = await this.port.readMany(
      missing.map((index) => files[index].path),
    );
    missing.forEach((index, position) => {
      const file = files[index];
      const read = reads[position];
      if (read instanceof Error) {
        results[index] = read;
        return;
      }
      // Same rules as `cachedRead`: never cache against a replaced object.
      if (this.index.getFileByPath(file.path) !== file) {
        results[index] = new Error(
          `File metadata is stale; refresh the vault before using ${file.path}`,
        );
        return;
      }
      try {
        const data = this.decodeText(read.bytes, file.path);
        if (revision === this.cacheRevision)
          this.textCache.set(file.path, { file, version: read.version, data });
        results[index] = data;
      } catch (error) {
        results[index] = asError(error);
      }
    });
    return results;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const owned = this.requireOwnedFile(file);
    const { bytes } = await this.port.read(owned.path);
    // Detach from the port's buffer and narrow a possibly offset view.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }

  async create(path: string, data: string): Promise<TFile> {
    validateRelativePath(path);
    if (typeof data !== "string")
      throw new TypeError("Vault.create data must be a string");
    const bytes = textEncoder.encode(data);
    return this.enqueue(path, async () => {
      this.assertPathFree(path);
      const result = await this.port.create(path, bytes);
      return this.publishFile(path, result.stat);
    });
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    validateRelativePath(path);
    const bytes = copyBinary(data);
    return this.enqueue(path, async () => {
      this.assertPathFree(path);
      const result = await this.port.create(path, bytes);
      return this.publishFile(path, result.stat);
    });
  }

  async createFolder(path: string): Promise<TFolder> {
    validateRelativePath(path);
    return this.enqueue(path, async () => {
      this.assertPathFree(path);
      await this.port.mkdir(path);
      return this.publishFolder(path);
    });
  }

  async copy(file: TFile, newPath: string): Promise<TFile> {
    validateRelativePath(newPath);
    const owned = this.requireOwnedFile(file);
    return this.enqueue(newPath, async () => {
      const current = this.requireOwnedFile(file);
      this.assertPathFree(newPath);
      const { bytes } = await this.port.read(current.path);
      const created = await this.port.create(newPath, bytes);
      return this.publishFile(newPath, created.stat);
    });
  }

  async delete(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile))
      throw new TypeError("Only file deletion is implemented");
    const owned = this.requireOwnedFile(file);
    if (!this.port.remove)
      throw new Error("This vault backend does not support deletion");
    await this.enqueue(owned.path, async () => {
      const current = this.requireOwnedFile(file);
      const latest = await this.port.read(current.path);
      try {
        await this.port.remove!(current.path, latest.version);
      } catch (error) {
        this.invalidateTextCache(current.path);
        throw error;
      }
      this.removePath(current.path);
      this.trigger("delete", current);
    });
  }

  async rename(file: TFile, newPath: string): Promise<void> {
    validateRelativePath(newPath);
    const owned = this.requireOwnedFile(file);
    if (newPath === owned.path) return;
    if (!this.port.remove)
      throw new Error("This vault backend does not support renaming");
    await this.enqueue(owned.path, async () => {
      const current = this.requireOwnedFile(file);
      this.assertPathFree(newPath);
      const latest = await this.port.read(current.path);
      const created = await this.port.create(newPath, latest.bytes);
      try {
        await this.port.remove!(current.path, latest.version);
      } catch (error) {
        // Providers may report a failure after removing the original. Never
        // delete the destination as a speculative rollback: it may be the only
        // remaining visible copy. Publish it and explain the partial outcome.
        this.publishFile(newPath, created.stat);
        this.invalidateTextCache(current.path);
        throw new Error(
          `Rename was not completed; the copy at ${newPath} was kept for recovery. Refresh the vault before retrying.`,
          { cause: error },
        );
      }
      const oldPath = current.path;
      this.index.relocateFile(current, newPath, created.stat);
      this.invalidateTextCache(oldPath);
      this.invalidateTextCache(newPath);
      this.trigger("rename", current, oldPath);
    });
  }

  async append(
    file: TFile,
    data: string,
    _options?: { ctime?: number; mtime?: number },
  ): Promise<void> {
    await this.process(file, (content) => content + data);
  }

  async trash(file: TAbstractFile, _system: boolean): Promise<void> {
    await this.delete(file);
  }

  async modify(file: TFile, data: string): Promise<void> {
    if (typeof data !== "string")
      throw new TypeError("Vault.modify data must be a string");
    const owned = this.requireOwnedFile(file);
    const path = owned.path;
    validateRelativePath(path);
    await this.enqueue(path, async () => {
      const current = this.requireOwnedFile(file);
      // The public API has no version argument, so read one current CAS token.
      const latest = await this.port.read(current.path);
      const bytes = textEncoder.encode(data);
      if (sameBytes(latest.bytes, bytes)) {
        // A no-op keeps the stored metadata untouched but refreshes the cache
        // against the version that was actually observed.
        this.invalidateTextCache(current.path);
        this.textCache.set(current.path, {
          file: current,
          version: latest.version,
          data,
        });
        return;
      }
      let written: { version: string; stat: FileStats };
      try {
        written = await this.port.write(current.path, bytes, latest.version);
      } catch (error) {
        // A rejected compare-and-swap means native content may have moved on.
        this.invalidateTextCache(current.path);
        throw error;
      }
      this.commitWrite(current, written.version, written.stat, data);
    });
  }

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    const owned = this.requireOwnedFile(file);
    const path = owned.path;
    validateRelativePath(path);
    const bytes = copyBinary(data);
    await this.enqueue(path, async () => {
      const current = this.requireOwnedFile(file);
      const latest = await this.port.read(current.path);
      if (sameBytes(latest.bytes, bytes)) {
        this.invalidateTextCache(current.path);
        return;
      }
      let written: { version: string; stat: FileStats };
      try {
        written = await this.port.write(current.path, bytes, latest.version);
      } catch (error) {
        this.invalidateTextCache(current.path);
        throw error;
      }
      this.commitWrite(current, written.version, written.stat);
    });
  }

  /**
   * Read fresh content, invoke the callback exactly once, and write with the
   * observed version. A conflict is propagated; the callback is never retried.
   */
  async process(
    file: TFile,
    transform: (data: string) => string,
  ): Promise<string> {
    if (typeof transform !== "function")
      throw new TypeError("Vault.process requires a callback");
    const owned = this.requireOwnedFile(file);
    const path = owned.path;
    validateRelativePath(path);
    return this.enqueue(path, async () => {
      const current = this.requireOwnedFile(file);
      const latest = await this.port.read(current.path);
      const previous = this.decodeText(latest.bytes, current.path);
      const result = transform(previous);
      if (typeof result !== "string") {
        // Do not leave a rejected async callback unhandled when it was
        // supplied where a synchronous string was required.
        if (
          result &&
          typeof (result as unknown as PromiseLike<unknown>).then === "function"
        )
          void Promise.resolve(result).catch(() => {});
        throw new TypeError(
          "Vault.process callback must return a string synchronously",
        );
      }
      if (result === previous) {
        this.invalidateTextCache(current.path);
        this.textCache.set(current.path, {
          file: current,
          version: latest.version,
          data: result,
        });
        return result;
      }
      const bytes = textEncoder.encode(result);
      let written: { version: string; stat: FileStats };
      try {
        written = await this.port.write(current.path, bytes, latest.version);
      } catch (error) {
        // No retry: the callback already ran, and a conflict means the
        // stored text is no longer what it observed.
        this.invalidateTextCache(current.path);
        throw error;
      }
      this.commitWrite(current, written.version, written.stat, result);
      return result;
    });
  }

  private normalizeSnapshot(snapshot: unknown): FileEntry[] {
    if (!Array.isArray(snapshot))
      throw new Error("Vault snapshot must be an array");
    return snapshot.map((candidate, index): FileEntry => {
      if (!candidate || typeof candidate !== "object")
        throw new Error(`Invalid vault snapshot entry at index ${index}`);
      const entry = candidate as Partial<FileEntry>;
      const path = entry.path;
      validateRelativePath(path);
      if (entry.kind === "folder") return { path, kind: "folder" };
      if (entry.kind !== "file")
        throw new Error(`Unknown vault snapshot entry kind for ${path}`);
      return { path, kind: "file", stat: validStat(entry.stat, path) };
    });
  }

  private captureIndex(): Map<string, CapturedEntry> {
    const captured = new Map<string, CapturedEntry>();
    for (const file of this.index.getAllLoadedFiles()) {
      // The synthetic root is not part of a native snapshot or a diff.
      if (file.path === "/") continue;
      captured.set(
        file.path,
        file instanceof TFile
          ? { kind: "file", file, stat: { ...file.stat } }
          : { kind: "folder", file },
      );
    }
    return captured;
  }

  private emitDiffs(
    before: Map<string, CapturedEntry>,
    after: Map<string, CapturedEntry>,
  ): void {
    const deleted: CapturedEntry[] = [];
    const created: CapturedEntry[] = [];
    const modified: CapturedEntry[] = [];
    for (const [path, previous] of before) {
      const next = after.get(path);
      if (!next || next.kind !== previous.kind) deleted.push(previous);
    }
    for (const [path, next] of after) {
      const previous = before.get(path);
      if (!previous || previous.kind !== next.kind) created.push(next);
    }
    for (const [path, next] of after) {
      const previous = before.get(path);
      if (
        previous &&
        previous.kind === "file" &&
        next.kind === "file" &&
        !sameStat(previous.stat, next.stat)
      )
        modified.push(next);
    }
    const byPath = (first: CapturedEntry, second: CapturedEntry) =>
      first.file.path < second.file.path
        ? -1
        : first.file.path > second.file.path
          ? 1
          : 0;
    deleted.sort(byPath);
    created.sort(byPath);
    modified.sort(byPath);
    // Every branch below observes the fully replaced index.
    for (const entry of deleted) this.trigger("delete", entry.file);
    for (const entry of created) this.trigger("create", entry.file);
    for (const entry of modified) this.trigger("modify", entry.file);
  }

  /**
   * Global publication gate. Refresh captures a snapshot under the same gate
   * as mutations publish their metadata, so a snapshot that began earlier can
   * never be applied after a later create/modify. The tail always resolves, so
   * one rejected refresh does not block the rest of the queue.
   */
  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.gate.then(operation, operation);
    this.gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * One queue per path serializes read-modify-write operations. A rejected tail
   * is caught so the next operation on that path still runs.
   */
  private enqueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(path) ?? Promise.resolve();
    // Reserve the global slot synchronously, before a following refresh can
    // overtake this mutation's per-path queue microtask.
    const run = this.runExclusive(() => previous.then(operation));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(path, tail);
    void tail.then(() => {
      if (this.queues.get(path) === tail) this.queues.delete(path);
    });
    return run;
  }

  private requireOwnedFile(file: TFile): TFile {
    if (!(file instanceof TFile))
      throw new TypeError("Vault operation requires a TFile");
    validateRelativePath(file.path);
    if (file.vault !== this)
      throw new Error(`File belongs to a different vault: ${file.path}`);
    const current = this.index.getFileByPath(file.path);
    if (current !== file)
      throw new Error(
        `File metadata is stale; refresh the vault before using ${file.path}`,
      );
    return file;
  }

  private assertPathFree(path: string): void {
    if (this.index.getAbstractFileByPath(path))
      throw new Error(`A vault entry already exists at ${path}`);
    const slash = path.lastIndexOf("/");
    const parentPath = slash < 0 ? "/" : path.slice(0, slash);
    const parent = this.index.getAbstractFileByPath(parentPath);
    if (parent && !(parent instanceof TFolder))
      throw new Error(`Vault parent is not a folder: ${parentPath}`);
  }

  private removePath(path: string): void {
    const entries = this.currentEntries().filter(
      (entry) => entry.path !== path,
    );
    this.index.replace(entries);
    this.invalidateTextCache(path);
  }

  private publishFile(path: string, stat: FileStats): TFile {
    const entries = this.currentEntries().filter(
      (entry) => entry.path !== path,
    );
    entries.push({ path, kind: "file", stat: validStat(stat, path) });
    this.index.replace(entries);
    const file = this.index.getFileByPath(path);
    if (!file)
      throw new Error(`Created file is missing from the vault index: ${path}`);
    this.invalidateTextCache(path);
    this.trigger("create", file);
    return file;
  }

  private publishFolder(path: string): TFolder {
    const entries = this.currentEntries().filter(
      (entry) => entry.path !== path,
    );
    entries.push({ path, kind: "folder" });
    this.index.replace(entries);
    const folder = this.index.getFolderByPath(path);
    if (!folder)
      throw new Error(
        `Created folder is missing from the vault index: ${path}`,
      );
    this.invalidateTextCache(path);
    this.trigger("create", folder);
    return folder;
  }

  private currentEntries(): FileEntry[] {
    const entries: FileEntry[] = [];
    for (const file of this.index.getAllLoadedFiles()) {
      if (file.path === "/") continue;
      entries.push(
        file instanceof TFile
          ? { path: file.path, kind: "file", stat: { ...file.stat } }
          : { path: file.path, kind: "folder" },
      );
    }
    return entries;
  }

  private commitWrite(
    file: TFile,
    version: string,
    stat: FileStats,
    text?: string,
  ): void {
    this.invalidateTextCache(file.path);
    if (this.index.getFileByPath(file.path) !== file) {
      // The object disappeared while the native write was in flight. Do not
      // resurrect stale metadata or claim an event for it; the next refresh
      // will reconcile the snapshot.
      return;
    }
    file.stat = { ...validStat(stat, file.path) };
    if (text !== undefined)
      this.textCache.set(file.path, { file, version, data: text });
    this.trigger("modify", file);
  }

  private invalidateTextCache(path?: string): void {
    this.cacheRevision++;
    if (path === undefined) this.textCache.clear();
    else this.textCache.delete(path);
  }

  private decodeText(bytes: Uint8Array, path: string): string {
    try {
      return textDecoder.decode(bytes);
    } catch {
      throw new Error(`Vault file is not valid UTF-8: ${path}`);
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
