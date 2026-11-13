import { invoke } from "@tauri-apps/api/core";
import type { FileEntry, FileStats } from "./files";
import {
  MAX_VAULT_BINARY_BYTES,
  type PortRead,
  type VaultStoragePort,
} from "./storage-port";

/**
 * Injectable Tauri command runner. Tests supply a recorder; production uses
 * `@tauri-apps/api/core`'s `invoke`.
 */
export type NativeVaultInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index++)
    table[BASE64_ALPHABET.charCodeAt(index)] = index;
  return table;
})();
const MAX_BASE64_LENGTH = Math.ceil(MAX_VAULT_BINARY_BYTES / 3) * 4;

function invalidBase64(reason: string): Error {
  return new Error(`Invalid base64 vault payload: ${reason}`);
}

/**
 * Encode an exact byte range. Only `bytes.byteOffset .. byteOffset + byteLength`
 * is read, so views into larger buffers never leak their surrounding bytes.
 * Encoding is chunked instead of spreading the whole payload into one
 * `String.fromCharCode` call.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array))
    throw new TypeError("Vault payload must be a Uint8Array");
  if (bytes.byteLength > MAX_VAULT_BINARY_BYTES)
    throw new Error(
      `Vault binary payload exceeds the ${MAX_VAULT_BINARY_BYTES / (1024 * 1024)} MiB limit`,
    );
  const parts: string[] = [];
  let chunk = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const first = bytes[index];
    const second = remaining > 1 ? bytes[index + 1] : 0;
    const third = remaining > 2 ? bytes[index + 2] : 0;
    const combined = (first << 16) | (second << 8) | third;
    chunk +=
      BASE64_ALPHABET[(combined >> 18) & 63] +
      BASE64_ALPHABET[(combined >> 12) & 63] +
      (remaining > 1 ? BASE64_ALPHABET[(combined >> 6) & 63] : "=") +
      (remaining > 2 ? BASE64_ALPHABET[combined & 63] : "=");
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  parts.push(chunk);
  return parts.join("");
}

/** Decode canonical base64 without relying on `atob` argument/whitespace quirks. */
export function base64ToBytes(data: string): Uint8Array {
  if (typeof data !== "string")
    throw new TypeError("Vault base64 payload must be a string");
  if (data.length > MAX_BASE64_LENGTH)
    throw new Error(
      `Vault binary payload exceeds the ${MAX_VAULT_BINARY_BYTES / (1024 * 1024)} MiB limit`,
    );
  if (data.length % 4 !== 0)
    throw invalidBase64("length must be a multiple of four");

  let padding = 0;
  if (data.endsWith("==")) padding = 2;
  else if (data.endsWith("=")) padding = 1;

  const byteLength = (data.length / 4) * 3 - padding;
  if (byteLength > MAX_VAULT_BINARY_BYTES)
    throw new Error(
      `Vault binary payload exceeds the ${MAX_VAULT_BINARY_BYTES / (1024 * 1024)} MiB limit`,
    );

  const bytes = new Uint8Array(byteLength);
  let written = 0;
  for (let index = 0; index < data.length; index += 4) {
    const lastGroup = index + 4 === data.length;
    const firstCode = data.charCodeAt(index);
    const secondCode = data.charCodeAt(index + 1);
    const thirdCode = data.charCodeAt(index + 2);
    const fourthCode = data.charCodeAt(index + 3);
    const first = firstCode < 128 ? BASE64_LOOKUP[firstCode] : -1;
    const second = secondCode < 128 ? BASE64_LOOKUP[secondCode] : -1;
    if (first < 0 || second < 0)
      throw invalidBase64("contains a non-base64 character");

    if (thirdCode === 61 /* = */) {
      if (!lastGroup || fourthCode !== 61)
        throw invalidBase64("padding is only valid at the end");
      if ((second & 15) !== 0) throw invalidBase64("non-zero padding bits");
      const combined = (first << 18) | (second << 12);
      bytes[written++] = (combined >> 16) & 0xff;
      continue;
    }
    const third = thirdCode < 128 ? BASE64_LOOKUP[thirdCode] : -1;
    if (third < 0) throw invalidBase64("contains a non-base64 character");
    if (fourthCode === 61 /* = */) {
      if (!lastGroup) throw invalidBase64("padding is only valid at the end");
      if ((third & 3) !== 0) throw invalidBase64("non-zero padding bits");
      const combined = (first << 18) | (second << 12) | (third << 6);
      bytes[written++] = (combined >> 16) & 0xff;
      bytes[written++] = (combined >> 8) & 0xff;
      continue;
    }
    const fourth = fourthCode < 128 ? BASE64_LOOKUP[fourthCode] : -1;
    if (fourth < 0) throw invalidBase64("contains a non-base64 character");
    const combined = (first << 18) | (second << 12) | (third << 6) | fourth;
    bytes[written++] = (combined >> 16) & 0xff;
    bytes[written++] = (combined >> 8) & 0xff;
    bytes[written++] = combined & 0xff;
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nativeStat(value: unknown, context: string): FileStats {
  if (!isRecord(value))
    throw new Error(`Native vault ${context} response is missing file stats`);
  const { ctime, mtime, size } = value;
  if (
    ![ctime, mtime, size].every(
      (part) => typeof part === "number" && Number.isFinite(part),
    ) ||
    (size as number) < 0
  )
    throw new Error(`Native vault ${context} response has invalid file stats`);
  return {
    ctime: ctime as number,
    mtime: mtime as number,
    size: size as number,
  };
}

function nativeVersion(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Native vault ${context} response is missing a version`);
  return value;
}

function nativeResult(value: unknown): { version: string; stat: FileStats } {
  if (!isRecord(value))
    throw new Error("Native vault mutation response must be an object");
  return {
    version: nativeVersion(value.version, "mutation"),
    stat: nativeStat(value.stat, "mutation"),
  };
}

/** Files per `plugin_vault_read_many` call; must not exceed the backend's limit. */
const READ_BATCH = 64;

function parseRead(result: unknown): PortRead {
  if (!isRecord(result))
    throw new Error("Native vault read response must be an object");
  if (typeof result.data !== "string")
    throw new Error("Native vault read response is missing base64 data");
  const bytes = base64ToBytes(result.data);
  const version = nativeVersion(result.version, "read");
  const stat = nativeStat(result.stat, "read");
  if (bytes.byteLength !== stat.size)
    throw new Error(
      `Native vault read response decoded ${bytes.byteLength} bytes but stat reports ${stat.size}`,
    );
  return { bytes, version, stat };
}

/**
 * Frontend half of the native vault protocol. The id is captured once; this
 * class never consults a mutable "current vault" global. No browser file system
 * or Node `fs` access is used, and every payload stays inside the command args.
 */
export class NativeVaultPort implements VaultStoragePort {
  private readonly id: string;
  private readonly run: NativeVaultInvoke;

  constructor(vaultId: string, run?: NativeVaultInvoke) {
    if (typeof vaultId !== "string" || vaultId.length === 0)
      throw new Error("NativeVaultPort requires a non-empty vault id");
    this.id = vaultId;
    this.run = run ?? ((command, args) => invoke(command, args));
  }

  /** Getter only: there is no writable own property to accidentally rebind. */
  get vaultId(): string {
    return this.id;
  }

  async snapshot(): Promise<FileEntry[]> {
    const result = await this.run("plugin_vault_snapshot", {
      vaultId: this.id,
    });
    if (!Array.isArray(result))
      throw new Error("Native vault snapshot response must be an array");
    return result.map((entry, index): FileEntry => {
      if (!isRecord(entry) || typeof entry.path !== "string")
        throw new Error(`Native vault snapshot entry ${index} is invalid`);
      if (entry.kind === "folder") return { path: entry.path, kind: "folder" };
      if (entry.kind !== "file")
        throw new Error(
          `Native vault snapshot entry ${index} has an unknown kind`,
        );
      return {
        path: entry.path,
        kind: "file",
        stat: nativeStat(entry.stat, "snapshot"),
      };
    });
  }

  async read(
    path: string,
  ): Promise<{ bytes: Uint8Array; version: string; stat: FileStats }> {
    return parseRead(
      await this.run("plugin_vault_read", { vaultId: this.id, path }),
    );
  }

  /**
   * One IPC round-trip per batch instead of one per file. Files the backend
   * deferred because the batch byte budget ran out are read on their own.
   */
  async readMany(paths: string[]): Promise<Array<PortRead | Error>> {
    const results: Array<PortRead | Error> = [];
    for (let start = 0; start < paths.length; start += READ_BATCH) {
      const batch = paths.slice(start, start + READ_BATCH);
      const response = await this.run("plugin_vault_read_many", {
        vaultId: this.id,
        paths: batch,
      });
      if (!Array.isArray(response) || response.length !== batch.length)
        throw new Error("Native vault batch read response has the wrong shape");
      for (const [index, item] of response.entries()) {
        try {
          if (isRecord(item) && typeof item.error === "string") {
            if (item.deferred === true)
              results.push(await this.read(batch[index]));
            else results.push(new Error(item.error));
          } else results.push(parseRead(item));
        } catch (error) {
          results.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
    return results;
  }


  async create(
    path: string,
    bytes: Uint8Array,
  ): Promise<{ version: string; stat: FileStats }> {
    return nativeResult(
      await this.run("plugin_vault_create", {
        vaultId: this.id,
        path,
        data: bytesToBase64(bytes),
      }),
    );
  }

  async write(
    path: string,
    bytes: Uint8Array,
    expectedVersion: string,
  ): Promise<{ version: string; stat: FileStats }> {
    return nativeResult(
      await this.run("plugin_vault_write", {
        vaultId: this.id,
        path,
        data: bytesToBase64(bytes),
        expectedVersion,
      }),
    );
  }

  async remove(path: string, expectedVersion: string): Promise<void> {
    await this.run("plugin_vault_delete", {
      vaultId: this.id,
      path,
      expectedVersion,
    });
  }

  async mkdir(path: string): Promise<void> {
    await this.run("plugin_vault_mkdir", { vaultId: this.id, path });
  }
}
