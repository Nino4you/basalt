import { describe, expect, it } from "vitest";
import {
  TFile,
  TFolder,
  type FileEntry,
  type FileStats,
  type TAbstractFile,
} from "../../src/compat/files";
import {
  NativeVaultPort,
  base64ToBytes,
  bytesToBase64,
  type NativeVaultInvoke,
} from "../../src/compat/native-port";
import {
  MAX_VAULT_BINARY_BYTES,
  type VaultStoragePort,
} from "../../src/compat/storage-port";
import { Vault } from "../../src/compat/vault";

const encoder = new TextEncoder();

function bytesOf(value: string | Uint8Array): Uint8Array {
  return typeof value === "string"
    ? encoder.encode(value)
    : new Uint8Array(value);
}

function bufferOf(values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

interface StoredFile {
  data: Uint8Array;
  version: string;
  stat: FileStats;
}

/**
 * In-memory port with real byte storage and compare-and-swap semantics. Reads
 * deliberately return a view at a non-zero offset into a larger buffer.
 */
class MemoryVaultPort implements VaultStoragePort {
  readonly folders = new Set<string>();
  readonly files = new Map<string, StoredFile>();
  readonly calls: string[] = [];
  snapshotError: Error | null = null;
  snapshotOverride: FileEntry[] | null = null;
  failNextRead: Error | null = null;
  failNextCreate: Error | null = null;
  failNextWrite: Error | null = null;
  failNextMkdir: Error | null = null;
  beforeWrite: ((path: string) => void) | null = null;
  beforeRemove: ((path: string) => void) | null = null;
  readCount = 0;
  writeCount = 0;
  createCount = 0;
  mkdirCount = 0;
  snapshotCount = 0;
  private clock = 0;
  private versionCounter = 0;
  private deferredSnapshot: {
    wait: Promise<void>;
    started: () => void;
  } | null = null;

  constructor(readonly vaultId = "memory-vault") {}

  private nextVersion(bytes: Uint8Array): string {
    return `v${++this.versionCounter}:${bytes.byteLength}:${this.clock}`;
  }

  seedFolder(path: string): void {
    this.folders.add(path);
  }

  seedFile(path: string, content: string | Uint8Array, mtime?: number): void {
    this.ensureParents(path);
    const at = mtime ?? ++this.clock;
    this.clock = Math.max(this.clock, at);
    const data = bytesOf(content);
    const version = this.nextVersion(data);
    this.files.set(path, {
      data,
      version,
      stat: { ctime: at, mtime: at, size: data.byteLength },
    });
  }

  externalWrite(path: string, content: string | Uint8Array): void {
    const existing = this.files.get(path);
    if (!existing) throw new Error(`ENOENT: ${path}`);
    const data = bytesOf(content);
    const mtime = ++this.clock;
    const version = this.nextVersion(data);
    this.files.set(path, {
      data,
      version,
      stat: { ctime: existing.stat.ctime, mtime, size: data.byteLength },
    });
  }

  externalDelete(path: string): void {
    this.files.delete(path);
  }

  private ensureParents(path: string): void {
    const parts = path.split("/");
    parts.pop();
    for (let depth = 1; depth <= parts.length; depth++)
      this.folders.add(parts.slice(0, depth).join("/"));
  }

  async snapshot(): Promise<FileEntry[]> {
    this.snapshotCount++;
    if (this.snapshotError) throw this.snapshotError;
    // Capture before waiting so a delayed response really is a stale snapshot.
    const entries = this.buildSnapshot();
    const deferred = this.deferredSnapshot;
    if (deferred) {
      this.deferredSnapshot = null;
      deferred.started();
      await deferred.wait;
    }
    return entries;
  }

  deferNextSnapshot(): { started: Promise<void>; release: () => void } {
    let release!: () => void;
    let markStarted!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    this.deferredSnapshot = { wait, started: markStarted };
    return { started, release };
  }

  private buildSnapshot(): FileEntry[] {
    if (this.snapshotOverride)
      return this.snapshotOverride.map((entry) => ({
        ...entry,
        ...(entry.stat ? { stat: { ...entry.stat } } : {}),
      }));
    const folders = [...this.folders]
      .sort()
      .map((path): FileEntry => ({ path, kind: "folder" }));
    const files = [...this.files.keys()].sort().map((path): FileEntry => {
      const stored = this.files.get(path)!;
      return { path, kind: "file", stat: { ...stored.stat } };
    });
    return [...folders, ...files];
  }

  async read(
    path: string,
  ): Promise<{ bytes: Uint8Array; version: string; stat: FileStats }> {
    if (this.failNextRead) {
      const error = this.failNextRead;
      this.failNextRead = null;
      throw error;
    }
    this.readCount++;
    const file = this.files.get(path);
    if (!file) throw new Error(`ENOENT: ${path}`);
    const backing = new Uint8Array(file.data.byteLength + 8);
    backing.set(file.data, 4);
    return {
      bytes: backing.subarray(4, 4 + file.data.byteLength),
      version: file.version,
      stat: { ...file.stat },
    };
  }

  async create(
    path: string,
    bytes: Uint8Array,
  ): Promise<{ version: string; stat: FileStats }> {
    if (this.failNextCreate) {
      const error = this.failNextCreate;
      this.failNextCreate = null;
      throw error;
    }
    this.createCount++;
    if (this.files.has(path) || this.folders.has(path))
      throw new Error(`EEXIST: ${path}`);
    const data = new Uint8Array(bytes);
    const at = ++this.clock;
    const version = this.nextVersion(data);
    const stat = { ctime: at, mtime: at, size: data.byteLength };
    this.files.set(path, { data, version, stat });
    return { version, stat: { ...stat } };
  }

  async write(
    path: string,
    bytes: Uint8Array,
    expectedVersion: string,
  ): Promise<{ version: string; stat: FileStats }> {
    if (this.failNextWrite) {
      const error = this.failNextWrite;
      this.failNextWrite = null;
      throw error;
    }
    this.writeCount++;
    if (!this.files.has(path)) throw new Error(`ENOENT: ${path}`);
    if (this.beforeWrite) this.beforeWrite(path);
    const current = this.files.get(path)!;
    if (current.version !== expectedVersion)
      throw new Error(`EVERSION: ${path}`);
    const data = new Uint8Array(bytes);
    const stat = {
      ctime: current.stat.ctime,
      mtime: ++this.clock,
      size: data.byteLength,
    };
    const version = this.nextVersion(data);
    this.files.set(path, { data, version, stat });
    return { version, stat: { ...stat } };
  }

  async remove(path: string, expectedVersion: string): Promise<void> {
    this.beforeRemove?.(path);
    const stored = this.files.get(path);
    if (!stored) throw new Error(`ENOENT: ${path}`);
    if (stored.version !== expectedVersion)
      throw new Error(`EVERSION: ${path}`);
    this.files.delete(path);
  }

  async mkdir(path: string): Promise<void> {
    if (this.failNextMkdir) {
      const error = this.failNextMkdir;
      this.failNextMkdir = null;
      throw error;
    }
    this.mkdirCount++;
    if (this.folders.has(path) || this.files.has(path))
      throw new Error(`EEXIST: ${path}`);
    const parent = parentOf(path);
    if (parent && !this.folders.has(parent))
      throw new Error(`ENOENT: ${parent}`);
    this.folders.add(path);
  }
}

function recordEvents(vault: Vault): string[] {
  const events: string[] = [];
  for (const name of ["create", "modify", "delete", "rename"])
    vault.on(name, (file: TAbstractFile) => {
      events.push(`${name}:${file.path}`);
    });
  return events;
}

describe("Vault text and binary operations", () => {
  it("accepts genuine cross-realm buffers but not views or forged buffer objects", async () => {
    const port = new MemoryVaultPort();
    const vault = new Vault(port, "Vault");
    await vault.initialize();
    // TextEncoder can come from a different realm (e.g. a Node polyfill).
    const bytes = encoder.encode("buffer");
    const file = await vault.createBinary(
      "cross.bin",
      bytes.buffer as ArrayBuffer,
    );
    expect(await vault.read(file)).toBe("buffer");
    await expect(
      vault.createBinary("view.bin", bytes as unknown as ArrayBuffer),
    ).rejects.toThrow(/ArrayBuffer/);
    await expect(
      vault.createBinary("fake.bin", { byteLength: 1 } as ArrayBuffer),
    ).rejects.toThrow(/ArrayBuffer/);
  });
  it("reports the default theme to plugins through getConfig", () => {
    const vault = new Vault(new MemoryVaultPort(), "Vault");
    expect(vault.getConfig("cssTheme")).toBe("obsidian");
    expect(vault.getConfig("unknown")).toBeUndefined();
  });
  it("roundtrips UTF-8 text, folders and binary through the storage port", async () => {
    const port = new MemoryVaultPort();
    port.seedFolder("Notes");
    port.seedFile("Notes/Hello.md", "héllo 🌍");
    const vault = new Vault(port, "Test Vault");
    await vault.initialize();

    expect(vault.getName()).toBe("Test Vault");
    expect(vault.getRoot()).toBeInstanceOf(TFolder);
    expect(vault.getRoot().isRoot()).toBe(true);
    expect(vault.getAllLoadedFiles()).toContain(vault.getRoot());
    expect(vault.getFolderByPath("Notes")!.parent).toBe(vault.getRoot());
    const hello = vault.getFileByPath("Notes/Hello.md")!;
    expect(hello.vault).toBe(vault);
    expect(vault.getMarkdownFiles()).toEqual([hello]);
    expect(await vault.read(hello)).toBe("héllo 🌍");
    expect(await vault.cachedRead(hello)).toBe("héllo 🌍");
    expect(await vault.cachedRead(hello)).toBe("héllo 🌍");

    const created = await vault.create("Notes/New.md", "alpha");
    expect(created).toBeInstanceOf(TFile);
    expect(created.vault).toBe(vault);
    expect(created.parent).toBe(vault.getFolderByPath("Notes"));
    expect(created.stat.size).toBe(encoder.encode("alpha").byteLength);
    expect(Array.from(port.files.get("Notes/New.md")!.data)).toEqual(
      Array.from(encoder.encode("alpha")),
    );
    expect(await vault.read(created)).toBe("alpha");

    await vault.modify(created, "beta!");
    expect(created.stat.size).toBe(encoder.encode("beta!").byteLength);
    expect(await vault.read(created)).toBe("beta!");
    expect(await vault.cachedRead(created)).toBe("beta!");

    expect(await vault.process(created, (data) => data.toUpperCase())).toBe(
      "BETA!",
    );
    expect(await vault.cachedRead(created)).toBe("BETA!");

    const assets = await vault.createFolder("Assets");
    expect(assets).toBe(vault.getFolderByPath("Assets"));
    expect(assets.parent).toBe(vault.getRoot());

    const binary = Uint8Array.of(0, 255, 128, 1);
    const binaryFile = await vault.createBinary(
      "Assets/pic.bin",
      bufferOf([...binary]),
    );
    expect(binaryFile.parent).toBe(assets);
    expect(new Uint8Array(await vault.readBinary(binaryFile))).toEqual(binary);

    await vault.modifyBinary(binaryFile, bufferOf([9, 0, 9]));
    expect(new Uint8Array(await vault.readBinary(binaryFile))).toEqual(
      Uint8Array.of(9, 0, 9),
    );
  });

  it("preserves a UTF-8 BOM across reads and no-op writes", async () => {
    const port = new MemoryVaultPort();
    const original = Uint8Array.of(
      0xef,
      0xbb,
      0xbf,
      ...encoder.encode("# Überschrift\n"),
    );
    port.seedFile("bom.md", original);
    const vault = new Vault(port, "Vault");
    await vault.initialize();
    const file = vault.getFileByPath("bom.md")!;
    const expected = "\uFEFF# Überschrift\n";

    expect(await vault.read(file)).toBe(expected);
    expect(await vault.cachedRead(file)).toBe(expected);
    expect(await vault.process(file, (data) => data)).toBe(expected);
    expect(port.writeCount).toBe(0);
    expect(Array.from(port.files.get("bom.md")!.data)).toEqual(
      Array.from(original),
    );

    const events = recordEvents(vault);
    await vault.modify(file, expected);
    expect(port.writeCount).toBe(0);
    expect(events).toEqual([]);
    expect(await vault.cachedRead(file)).toBe(expected);
    expect(Array.from(port.files.get("bom.md")!.data)).toEqual(
      Array.from(original),
    );
  });

  it("copies, renames and deletes with events and stale-handle protection", async () => {
    const port = new MemoryVaultPort();
    port.seedFile("source.md", "content", 10);
    const vault = new Vault(port, "Vault");
    await vault.initialize();
    const source = vault.getFileByPath("source.md")!;
    const events = recordEvents(vault);

    const copied = await vault.copy(source, "copied.md");
    expect(await vault.read(copied)).toBe("content");
    expect(events).toEqual(["create:copied.md"]);

    await vault.rename(copied, "renamed.md");
    expect(vault.getFileByPath("copied.md")).toBeNull();
    const renamed = vault.getFileByPath("renamed.md")!;
    expect(renamed).toBe(copied);
    expect(await vault.read(renamed)).toBe("content");
    expect(events).toEqual(["create:copied.md", "rename:renamed.md"]);
    expect(copied.path).toBe("renamed.md");
    expect(await vault.read(copied)).toBe("content");

    await vault.refresh();
    expect(await vault.read(renamed)).toBe("content");
    await vault.delete(renamed);
    expect(vault.getFileByPath("renamed.md")).toBeNull();
    expect(events.at(-1)).toBe("delete:renamed.md");
    await expect(vault.read(renamed)).rejects.toThrow(/stale/);

    const folder = await vault.createFolder("Folder");
    await expect(
      vault.delete(folder as unknown as TAbstractFile),
    ).rejects.toThrow(/Only file deletion/);
  });

  it("returns an exact detached ArrayBuffer and rejects invalid UTF-8", async () => {
    const port = new MemoryVaultPort();
    port.seedFile("image.bin", Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7));
    port.seedFile("bad.txt", Uint8Array.of(0xff, 0xfe));
    const vault = new Vault(port, "Vault");
    await vault.initialize();

    const image = vault.getFileByPath("image.bin")!;
    const buffer = await vault.readBinary(image);
    expect(buffer.byteLength).toBe(8);
    expect(Array.from(new Uint8Array(buffer))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    new Uint8Array(buffer)[0] = 99;
    expect(new Uint8Array(await vault.readBinary(image))[0]).toBe(0);
    expect(port.files.get("image.bin")!.data[0]).toBe(0);

    await expect(vault.read(vault.getFileByPath("bad.txt")!)).rejects.toThrow(
      /UTF-8/,
    );
  });

  it("rejects create collisions, including native-only collisions, without events", async () => {
    const port = new MemoryVaultPort();
    port.seedFile("one.md", "one");
    const vault = new Vault(port, "Vault");
    await vault.initialize();
    const events = recordEvents(vault);

    await expect(vault.create("one.md", "two")).rejects.toThrow();
    expect(await vault.read(vault.getFileByPath("one.md")!)).toBe("one");
    expect(events).toEqual([]);

    // Native has a file the local snapshot has not seen yet.
    port.seedFile("hidden.md", "native");
    await expect(vault.create("hidden.md", "overwrite")).rejects.toThrow(
      /EEXIST/,
    );
    expect(vault.getFileByPath("hidden.md")).toBeNull();
    expect(Array.from(port.files.get("hidden.md")!.data)).toEqual(
      Array.from(encoder.encode("native")),
    );
    expect(events).toEqual([]);
  });
});

describe("Vault metadata graph", () => {
  it("preserves stable file/folder identities and parents across refresh", async () => {
    const port = new MemoryVaultPort();
    port.seedFile("A/B.md", "b");
    port.seedFile("A/C.md", "c");
    const vault = new Vault(port, "Vault");
    await vault.initialize();

    const b = vault.getFileByPath("A/B.md")!;
    const folder = vault.getFolderByPath("A")!;
    expect(b.parent).toBe(folder);
    expect(folder.parent).toBe(vault.getRoot());
    expect(vault.getRoot().children.map((child) => child.path)).toEqual(["A"]);

    port.externalWrite("A/B.md", "b2");
    port.seedFile("A/D.md", "d");
    await vault.refresh();

    expect(vault.getFileByPath("A/B.md")).toBe(b);
    expect(vault.getFolderByPath("A")).toBe(folder);
    expect(b.parent).toBe(folder);
    expect(folder.children).toContain(b);
    expect(folder.children).toContain(vault.getFileByPath("A/D.md"));
    expect(vault.getFileByPath("A/D.md")!.parent).toBe(folder);
  });

  it("rejects foreign, stale and fabricated TFile objects before touching storage", async () => {
    const firstPort = new MemoryVaultPort("vault-one");
    firstPort.seedFile("shared.md", "one");
    const secondPort = new MemoryVaultPort("vault-two");
    secondPort.seedFile("shared.md", "two");
    const first = new Vault(firstPort, "One");
    const second = new Vault(secondPort, "Two");
    await first.initialize();
    await second.initialize();

    const local = first.getFileByPath("shared.md")!;
    const foreign = second.getFileByPath("shared.md")!;
    await expect(first.read(foreign)).rejects.toThrow(/different vault/);
    await expect(first.modify(foreign, "x")).rejects.toThrow(/different vault/);
    await expect(first.process(foreign, (data) => data)).rejects.toThrow(
      /different vault/,
    );
    expect(firstPort.readCount).toBe(0);
    expect(await first.read(local)).toBe("one");

    firstPort.externalDelete("shared.md");
    await first.refresh();
    await expect(first.read(local)).rejects.toThrow(/stale/);
    const fabricated = new TFile(first, "shared.md", {
      ctime: 1,
      mtime: 1,
      size: 1,
    });
    await expect(first.read(fabricated)).rejects.toThrow(/stale/);

    for (const path of [
      "",
      "/absolute.md",
      "../escape.md",
      "a\\b.md",
      "a//b.md",
      "a/./b.md",
      "a/\u0001.md",
    ])
      await expect(first.create(path, "x")).rejects.toThrow(/Invalid/);
  });

  it("refreshes adds, modifications and deletions after the index is consistent", async () => {
    const port = new MemoryVaultPort();
    port.seedFile("Keep/A.md", "a", 100);
    port.seedFile("Keep/B.md", "b", 100);
    const vault = new Vault(port, "Vault");
    await vault.initialize();
    const a = vault.getFileByPath("Keep/A.md")!;
    const b = vault.getFileByPath("Keep/B.md")!;
    const originalStat = { ...a.stat };
    const events = recordEvents(vault);

    const assertConsistent = () => {
      expect(vault.getFileByPath("Keep/C.md")).not.toBeNull();
      expect(vault.getFileByPath("Keep/B.md")).toBeNull();
      expect(vault.getFileByPath("Keep/A.md")).toBe(a);
    };
    vault.on("delete", () => assertConsistent());
    vault.on("create", () => assertConsistent());
    vault.on("modify", () => assertConsistent());

    port.externalWrite("Keep/A.md", "a2");
    port.seedFile("Keep/C.md", "c");
    port.externalDelete("Keep/B.md");
    await vault.refresh();

    expect(vault.getFileByPath("Keep/A.md")).toBe(a);
    expect(a.stat.mtime).toBeGreaterThan(originalStat.mtime);
    expect(vault.getFileByPath("Keep/B.md")).toBeNull();
    expect(vault.getFileByPath("Keep/C.md")).not.toBeNull();
    expect(b.vault).toBe(vault);
    expect(events).toEqual([
      "delete:Keep/B.md",
      "create:Keep/C.md",
      "modify:Keep/A.md",
    ]);

    await vault.refresh();
    expect(events).toHaveLength(3);

    port.snapshotError = new Error("snapshot failed");
    await expect(vault.refresh()).rejects.toThrow("snapshot failed");
    port.snapshotError = null;
    expect(vault.getFileByPath("Keep/A.md")).toBe(a);
    expect(a.stat).toEqual(expect.objectContaining({ size: 2 }));

    port.snapshotOverride = [
      { path: "Keep/A.md", kind: "file", stat: { ...a.stat } },
      {
        path: "../escape.md",
        kind: "file",
        stat: { ctime: 1, mtime: 1, size: 1 },
      },
    ];
    await expect(vault.refresh()).rejects.toThrow(/Invalid/);
    expect(vault.getFileByPath("Keep/A.md")).toBe(a);
    expect(events).toHaveLength(3);
  });
});

describe("Vault concurrency and conflicts", () => {
  it("keeps the destination as recovery copy when rename deletion is uncertain", async () => {
    const port = new MemoryVaultPort();
    port.seedFile("original.md", "important");
    const vault = new Vault(port, "Vault");
    await vault.initialize();
    const file = vault.getFileByPath("original.md")!;
    const events = recordEvents(vault);
    port.beforeRemove = (path) => {
      // Simulate a provider reporting failure after it already removed a file.
      port.externalDelete(path);
      throw new Error("provider disconnected");
    };
    await expect(vault.rename(file, "recovery.md")).rejects.toThrow(
      /kept for recovery/,
    );
    expect(await vault.read(vault.getFileByPath("recovery.md")!)).toBe(
      "important",
    );
    expect(events).toEqual(["create:recovery.md"]);
    port.beforeRemove = null;
    await vault.refresh();
    expect(vault.getFileByPath("original.md")).toBeNull();
    expect(vault.getFileByPath("recovery.md")).not.toBeNull();
  });

  it("invalidates cached content when deletion hits an external version conflict", async () => {
    const port = new MemoryVaultPort();
    port.seedFile("conflict.md", "old");
    const vault = new Vault(port, "Vault");
    await vault.initialize();
    const file = vault.getFileByPath("conflict.md")!;
    expect(await vault.cachedRead(file)).toBe("old");
    port.beforeRemove = (path) => port.externalWrite(path, "external");
    await expect(vault.delete(file)).rejects.toThrow(/EVERSION/);
    expect(await vault.cachedRead(file)).toBe("external");
  });

  it("revalidates a queued copy source after an earlier refresh removed it", async () => {
    const port = new MemoryVaultPort();
    port.seedFile("old.md", "old");
    const vault = new Vault(port, "Vault");
    await vault.initialize();
    const file = vault.getFileByPath("old.md")!;
    port.externalDelete("old.md");
    const refreshing = vault.refresh();
    const copying = vault.copy(file, "copy.md");
    await refreshing;
    await expect(copying).rejects.toThrow(/stale/);
    expect(port.createCount).toBe(0);
  });
  it("never applies a stale snapshot over a mutation queued behind it", async () => {
    const port = new MemoryVaultPort();
    port.seedFile("race.md", "base", 10);
    const vault = new Vault(port, "Vault");
    await vault.initialize();
    const file = vault.getFileByPath("race.md")!;
    const events = recordEvents(vault);

    // Capture the old snapshot, then queue a write while the snapshot is in
    // flight. The write must publish after the snapshot, never before it.
    const deferred = port.deferNextSnapshot();
    const refresh = vault.refresh();
    await deferred.started;
    const modify = vault.modify(file, "changed");
    deferred.release();
    await Promise.all([refresh, modify]);

    expect(await vault.read(file)).toBe("changed");
    expect(file.stat.size).toBe(encoder.encode("changed").byteLength);
    expect(vault.getFileByPath("race.md")).toBe(file);
    expect(events).toEqual(["modify:race.md"]);

    // A later refresh observes the already-published write and must not
    // manufacture another modification event.
    const second = port.deferNextSnapshot();
    const later = vault.refresh();
    await second.started;
    second.release();
    await later;
    expect(events).toEqual(["modify:race.md"]);
  });

  it("serializes process calls per path and invokes each callback exactly once", async () => {
    const port = new MemoryVaultPort();
    port.seedFile("counter.md", "0");
    const vault = new Vault(port, "Vault");
    await vault.initialize();
    const file = vault.getFileByPath("counter.md")!;
    const observed: string[] = [];

    const first = vault.process(file, (data) => {
      observed.push(data);
      return `${Number(data) + 1}`;
    });
    const second = vault.process(file, (data) => {
      observed.push(data);
      return `${Number(data) + 1}`;
    });

    await expect(Promise.all([first, second])).resolves.toEqual(["1", "2"]);
    expect(observed).toEqual(["0", "1"]);
    expect(await vault.read(file)).toBe("2");
    expect(port.writeCount).toBe(2);

    const writes = port.writeCount;
    const events = recordEvents(vault);
    expect(await vault.process(file, (data) => data)).toBe("2");
    expect(port.writeCount).toBe(writes);
    expect(events).toEqual([]);

    await expect(
      vault.process(file, () => {
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");
    await expect(
      vault.process(file, (() => 42) as unknown as (data: string) => string),
    ).rejects.toThrow(/string synchronously/);
    expect(await vault.process(file, (data) => `${data}!`)).toBe("2!");
  });

  it("propagates CAS conflicts without retry, optimistic stats or fake events", async () => {
    const port = new MemoryVaultPort();
    port.seedFile("doc.md", "start", 10);
    const vault = new Vault(port, "Vault");
    await vault.initialize();
    const file = vault.getFileByPath("doc.md")!;
    const originalStat = { ...file.stat };
    const events = recordEvents(vault);
    let callbackCount = 0;

    expect(await vault.cachedRead(file)).toBe("start");
    port.beforeWrite = (path) => {
      if (path === "doc.md" && port.writeCount === 1)
        port.externalWrite("doc.md", "external");
    };
    await expect(
      vault.process(file, (data) => {
        callbackCount++;
        return `mine:${data}`;
      }),
    ).rejects.toThrow(/EVERSION/);
    expect(callbackCount).toBe(1);
    expect(port.writeCount).toBe(1);
    expect(events).toEqual([]);
    expect(file.stat).toEqual(originalStat);
    expect(Array.from(port.files.get("doc.md")!.data)).toEqual(
      Array.from(encoder.encode("external")),
    );
    expect(await vault.read(file)).toBe("external");
    expect(await vault.cachedRead(file)).toBe("external");

    port.beforeWrite = () => port.externalWrite("doc.md", "again");
    const statBeforeModify = { ...file.stat };
    await expect(vault.modify(file, "nope")).rejects.toThrow(/EVERSION/);
    expect(file.stat).toEqual(statBeforeModify);
    expect(events).toEqual([]);
    expect(Array.from(port.files.get("doc.md")!.data)).toEqual(
      Array.from(encoder.encode("again")),
    );
    expect(await vault.cachedRead(file)).toBe("again");

    port.beforeWrite = null;
    await expect(
      vault.process(file, (data) => {
        callbackCount++;
        return `${data}!`;
      }),
    ).resolves.toBe("again!");
    expect(callbackCount).toBe(2);
    expect(events).toEqual(["modify:doc.md"]);
  });

  it("recovers the per-path queue after rejected storage operations", async () => {
    const port = new MemoryVaultPort();
    port.seedFile("queued.md", "start");
    const vault = new Vault(port, "Vault");
    await vault.initialize();
    const file = vault.getFileByPath("queued.md")!;

    port.failNextWrite = new Error("disk full");
    await expect(vault.process(file, (data) => `${data}!`)).rejects.toThrow(
      "disk full",
    );
    expect(await vault.read(file)).toBe("start");
    expect(await vault.process(file, (data) => `${data}!`)).toBe("start!");

    port.failNextCreate = new Error("create denied");
    await expect(vault.create("new.md", "value")).rejects.toThrow(
      "create denied",
    );
    expect(vault.getFileByPath("new.md")).toBeNull();
    expect(await vault.create("new.md", "value")).toBe(
      vault.getFileByPath("new.md"),
    );

    port.failNextMkdir = new Error("mkdir denied");
    await expect(vault.createFolder("Folder")).rejects.toThrow("mkdir denied");
    expect(vault.getFolderByPath("Folder")).toBeNull();
    expect(await vault.createFolder("Folder")).toBe(
      vault.getFolderByPath("Folder"),
    );
  });
});

describe("NativeVaultPort", () => {
  it("preserves a fixed vaultId and exact base64 bytes in command arguments", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke = (async (
      command: string,
      args?: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push({ command, args: args ?? {} });
      switch (command) {
        case "plugin_vault_snapshot":
          return [
            {
              path: "File.md",
              kind: "file",
              stat: { ctime: 1, mtime: 2, size: 3 },
            },
          ];
        case "plugin_vault_read":
          return {
            data: bytesToBase64(Uint8Array.of(0, 255, 1, 0)),
            version: "version-1",
            stat: { ctime: 1, mtime: 2, size: 4 },
          };
        case "plugin_vault_create":
        case "plugin_vault_write":
          return {
            version: "version-2",
            stat: { ctime: 2, mtime: 3, size: 5 },
          };
        case "plugin_vault_delete":
          return undefined;
        case "plugin_vault_mkdir":
          return undefined;
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    }) as NativeVaultInvoke;

    const port = new NativeVaultPort("vault-fixed", invoke);
    expect(port.vaultId).toBe("vault-fixed");
    expect(Object.getOwnPropertyDescriptor(port, "vaultId")).toBeUndefined();
    expect(() => {
      (port as unknown as { vaultId: string }).vaultId = "other";
    }).toThrow(TypeError);
    expect(port.vaultId).toBe("vault-fixed");

    await expect(port.snapshot()).resolves.toEqual([
      {
        path: "File.md",
        kind: "file",
        stat: { ctime: 1, mtime: 2, size: 3 },
      },
    ]);
    expect(calls.at(-1)).toEqual({
      command: "plugin_vault_snapshot",
      args: { vaultId: "vault-fixed" },
    });

    const read = await port.read("File.md");
    expect(Array.from(read.bytes)).toEqual([0, 255, 1, 0]);
    expect(read.version).toBe("version-1");
    expect(read.stat).toEqual({ ctime: 1, mtime: 2, size: 4 });
    expect(calls.at(-1)).toEqual({
      command: "plugin_vault_read",
      args: { vaultId: "vault-fixed", path: "File.md" },
    });

    const backing = Uint8Array.of(9, 9, 1, 2, 3, 9);
    await port.create("Asset.bin", backing.subarray(2, 5));
    expect(calls.at(-1)).toEqual({
      command: "plugin_vault_create",
      args: {
        vaultId: "vault-fixed",
        path: "Asset.bin",
        data: bytesToBase64(Uint8Array.of(1, 2, 3)),
      },
    });

    await port.create("Empty.bin", new Uint8Array(0));
    expect(calls.at(-1)).toEqual({
      command: "plugin_vault_create",
      args: { vaultId: "vault-fixed", path: "Empty.bin", data: "" },
    });

    await port.write("File.md", Uint8Array.of(0), "version-1");
    expect(calls.at(-1)).toEqual({
      command: "plugin_vault_write",
      args: {
        vaultId: "vault-fixed",
        path: "File.md",
        data: bytesToBase64(Uint8Array.of(0)),
        expectedVersion: "version-1",
      },
    });

    await port.remove("File.md", "version-1");
    expect(calls.at(-1)).toEqual({
      command: "plugin_vault_delete",
      args: {
        vaultId: "vault-fixed",
        path: "File.md",
        expectedVersion: "version-1",
      },
    });

    await port.mkdir("Folder");
    expect(calls.at(-1)).toEqual({
      command: "plugin_vault_mkdir",
      args: { vaultId: "vault-fixed", path: "Folder" },
    });
    expect(calls.every((call) => call.args.vaultId === "vault-fixed")).toBe(
      true,
    );

    expect(bytesToBase64(new Uint8Array(0))).toBe("");
    expect(bytesToBase64(Uint8Array.of(0))).toBe("AA==");
    expect(bytesToBase64(Uint8Array.of(255, 254))).toBe("//4=");
    expect(Array.from(base64ToBytes("//4="))).toEqual([255, 254]);
    expect(Array.from(base64ToBytes("AA=="))).toEqual([0]);
    expect(Array.from(base64ToBytes("/w=="))).toEqual([255]);
    expect(Array.from(base64ToBytes("//8="))).toEqual([255, 255]);
    expect(() => base64ToBytes("AB==")).toThrow(/padding bits/);
    expect(() => base64ToBytes("AAB=")).toThrow(/padding bits/);
    expect(() => base64ToBytes("AA=A")).toThrow(/padding/);
    expect(() => base64ToBytes("AAA===")).toThrow(/base64/);
    expect(() => base64ToBytes("AA")).toThrow(/multiple of four/);

    const callCount = calls.length;
    await expect(
      port.create("TooBig.bin", new Uint8Array(MAX_VAULT_BINARY_BYTES + 1)),
    ).rejects.toThrow(/64 MiB/);
    expect(calls).toHaveLength(callCount);
  });
});

describe("batched reads", () => {
  const readOf = (text: string) => ({
    data: Buffer.from(text, "utf8").toString("base64"),
    version: `v-${text}`,
    stat: { ctime: 1, mtime: 1, size: Buffer.byteLength(text) },
  });

  it("reads in chunks, falls back for deferred files and keeps errors per file", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke = (async (command, args) => {
      calls.push({ command, args });
      if (command === "plugin_vault_read")
        return readOf(`single:${args!.path as string}`);
      const paths = args!.paths as string[];
      return paths.map((path) =>
        path === "big.md"
          ? { error: "Batch byte budget exhausted", deferred: true }
          : path === "gone.md"
            ? { error: "not found", deferred: false }
            : readOf(path),
      );
    }) as NativeVaultInvoke;
    const port = new NativeVaultPort("vault", invoke);
    const paths = [
      ...Array.from({ length: 70 }, (_, i) => `n${i}.md`),
      "big.md",
      "gone.md",
    ];
    const results = await port.readMany(paths);
    expect(calls.filter((c) => c.command === "plugin_vault_read_many")).toHaveLength(2);
    expect(new TextDecoder().decode((results[0] as { bytes: Uint8Array }).bytes)).toBe("n0.md");
    expect(new TextDecoder().decode((results[70] as { bytes: Uint8Array }).bytes)).toBe("single:big.md");
    expect(results[71]).toBeInstanceOf(Error);
    expect((results[71] as Error).message).toBe("not found");
  });

  it("caches batch results like cachedRead and reports failures per file", async () => {
    const files: Record<string, string> = { "a.md": "A", "b.md": "B" };
    let batches = 0;
    const port: VaultStoragePort = {
      vaultId: "v",
      snapshot: async () =>
        Object.keys(files).map((path) => ({
          path,
          kind: "file" as const,
          stat: { ctime: 1, mtime: 1, size: 1 },
        })),
      read: async (path) => {
        throw new Error(`single read of ${path}`);
      },
      readMany: async (paths) => {
        batches++;
        return paths.map((path) =>
          path === "b.md"
            ? new Error("denied")
            : { bytes: encoder.encode(files[path]), version: "1", stat: { ctime: 1, mtime: 1, size: 1 } },
        );
      },
      create: async () => {
        throw new Error("unused");
      },
      write: async () => {
        throw new Error("unused");
      },
      mkdir: async () => {},
    };
    const vault = new Vault(port, "V");
    await vault.initialize();
    const a = vault.getFileByPath("a.md")!;
    const b = vault.getFileByPath("b.md")!;
    const [textA, errorB] = await vault.cachedReadMany([a, b]);
    expect(textA).toBe("A");
    expect((errorB as Error).message).toBe("denied");
    // The successful read is cached; only the failed one is asked for again.
    await expect(vault.cachedRead(a)).resolves.toBe("A");
    await vault.cachedReadMany([a, b]);
    expect(batches).toBe(2);
  });
});

describe("refreshing one saved file", () => {
  it("re-reads only that file and emits modify when its stats changed", async () => {
    const { MemoryPort } = await import("../helpers/vault-store");
    const port = new MemoryPort({ "a.md": "A", "b.md": "B" });
    const vault = new Vault(port, "V");
    await vault.initialize();
    const a = vault.getFileByPath("a.md")!;
    await expect(vault.cachedRead(a)).resolves.toBe("A");
    const events: string[] = [];
    vault.on("modify", (file: TFile) => events.push(`modify ${file.path}`));
    vault.on("create", (file: TFile) => events.push(`create ${file.path}`));

    // Saved by the host, not through the vault.
    const { version } = await port.read("a.md");
    await port.write("a.md", encoder.encode("A changed"), version);
    await vault.refreshFile("a.md");
    expect(events).toEqual(["modify a.md"]);
    expect(vault.getFileByPath("a.md")).toBe(a);
    expect(a.stat.size).toBe(9);
    await expect(vault.cachedRead(a)).resolves.toBe("A changed");

    // Unchanged stats: nothing to report.
    await vault.refreshFile("a.md");
    expect(events).toHaveLength(1);

    // An unknown path needs the full walk.
    await port.create("c.md", encoder.encode("C"));
    await vault.refreshFile("c.md");
    expect(events).toEqual(["modify a.md", "create c.md"]);
  });
});
