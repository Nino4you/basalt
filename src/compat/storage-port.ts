import type { FileEntry, FileStats } from "./files";

/** The largest binary payload the native bridge accepts in a single command. */
export const MAX_VAULT_BINARY_BYTES = 64 * 1024 * 1024;

/**
 * Storage boundary for a single vault. Versions are opaque CAS tokens supplied
 * by the backend; this layer never treats them as content and never retries a
 * failed compare-and-swap.
 */
export interface PortRead {
  bytes: Uint8Array;
  version: string;
  stat: FileStats;
}

export interface VaultStoragePort {
  /** Immutable identifier captured when the port is constructed. */
  readonly vaultId: string;
  /** Complete metadata snapshot, excluding the synthetic root folder. */
  snapshot(): Promise<FileEntry[]>;
  read(
    path: string,
  ): Promise<{ bytes: Uint8Array; version: string; stat: FileStats }>;
  /**
   * Optional batched `read`: one entry per path, in order, each the read
   * result or the error a single `read` of that path would have thrown.
   */
  readMany?(paths: string[]): Promise<Array<PortRead | Error>>;
  /** Exclusive creation; the backend must refuse to overwrite an existing entry. */
  create(
    path: string,
    bytes: Uint8Array,
  ): Promise<{ version: string; stat: FileStats }>;
  /** Replace only when the current version equals `expectedVersion`. */
  write(
    path: string,
    bytes: Uint8Array,
    expectedVersion: string,
  ): Promise<{ version: string; stat: FileStats }>;
  /**
   * Delete one file only when the current version equals `expectedVersion`.
   * The backend keeps a backup. Folders are intentionally out of scope.
   */
  remove?(path: string, expectedVersion: string): Promise<void>;
  /** Create one folder; its parent must already exist and the path must be free. */
  mkdir(path: string): Promise<void>;
}
