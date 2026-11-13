import type { FileEntry, FileStats } from "../../src/compat/files";
import type { VaultStoragePort } from "../../src/compat/storage-port";
import { Vault } from "../../src/compat/vault";

const encoder = new TextEncoder();

function stats(bytes: Uint8Array): FileStats {
  return { ctime: 1, mtime: 1, size: bytes.byteLength };
}

/** In-memory storage with real versions and exclusive create, for vault-level tests. */
export class MemoryPort implements VaultStoragePort {
  readonly vaultId = "memory-test";
  private readonly files = new Map<
    string,
    { bytes: Uint8Array; version: string }
  >();
  private clock = 0;
  private readonly folders = new Set<string>();

  constructor(contents: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(contents))
      this.files.set(path, {
        bytes: encoder.encode(text),
        version: this.next(),
      });
  }

  private next(): string {
    return String(++this.clock);
  }

  async snapshot(): Promise<FileEntry[]> {
    return [
      ...[...this.folders].map((path) => ({
        path,
        kind: "folder" as const,
        stat: { ctime: 1, mtime: 1, size: 0 },
      })),
      ...[...this.files].map(([path, entry]) => ({
        path,
        kind: "file" as const,
        stat: stats(entry.bytes),
      })),
    ];
  }

  async read(path: string) {
    const entry = this.files.get(path);
    if (!entry) throw new Error(`ENOENT: ${path}`);
    return {
      bytes: entry.bytes,
      version: entry.version,
      stat: stats(entry.bytes),
    };
  }

  async create(path: string, bytes: Uint8Array) {
    if (this.files.has(path)) throw new Error(`EEXIST: ${path}`);
    const version = this.next();
    this.files.set(path, { bytes, version });
    return { version, stat: stats(bytes) };
  }

  async write(path: string, bytes: Uint8Array, expectedVersion: string) {
    const entry = this.files.get(path);
    if (!entry) throw new Error(`ENOENT: ${path}`);
    if (entry.version !== expectedVersion) throw new Error("conflict");
    const version = this.next();
    this.files.set(path, { bytes, version });
    return { version, stat: stats(bytes) };
  }

  async remove(path: string, expectedVersion: string): Promise<void> {
    const entry = this.files.get(path);
    if (!entry) throw new Error(`ENOENT: ${path}`);
    if (entry.version !== expectedVersion) throw new Error("conflict");
    this.files.delete(path);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }
}

export async function memoryVault(contents: Record<string, string> = {}) {
  const vault = new Vault(new MemoryPort(contents), "Vault");
  await vault.initialize();
  return vault;
}
