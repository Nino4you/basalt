import type { FileEntry } from "./files";
import { CONFIG_DIRECTORY, PLUGIN_DIRECTORY } from "./plugin-bundles";
import type { VaultStoragePort } from "./storage-port";

const CONFIG_ROOTS = [PLUGIN_DIRECTORY, CONFIG_DIRECTORY];

/** True for the Basalt plugin and config folders and everything below them. */
export function isPluginConfigPath(path: string): boolean {
  return CONFIG_ROOTS.some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}

/** True for the config folders, their contents and the folders above them. */
function isPluginConfigOrAncestor(path: string): boolean {
  return (
    isPluginConfigPath(path) ||
    CONFIG_ROOTS.some((root) => root.startsWith(`${path}/`))
  );
}

/**
 * Restricts a storage port to a subset of vault paths. Obsidian keeps plugin
 * code in the hidden `.obsidian` folder, so plugins never see it as vault
 * content. Basalt stores it in the visible `Basalt/Plugins` folder (Android SAF
 * does not reliably expose hidden folders), so the plugin-facing vault hides
 * that folder and a separate config view, reachable only through the adapter
 * and the bundle loader, exposes it. Without this split, sync plugins treat
 * installed plugin code as user attachments and upload it.
 */
export class ScopedVaultPort implements VaultStoragePort {
  private constructor(
    private readonly inner: VaultStoragePort,
    private readonly includes: (path: string) => boolean,
    private readonly label: string,
  ) {}

  /** Everything except the plugin folder. */
  static content(inner: VaultStoragePort): ScopedVaultPort {
    return new ScopedVaultPort(
      inner,
      (path) => !isPluginConfigPath(path),
      "vault content",
    );
  }

  /** Only the plugin folder and the folders above it. */
  static pluginConfig(inner: VaultStoragePort): ScopedVaultPort {
    return new ScopedVaultPort(
      inner,
      isPluginConfigOrAncestor,
      "plugin configuration",
    );
  }

  get vaultId(): string {
    return this.inner.vaultId;
  }

  async snapshot(): Promise<FileEntry[]> {
    const entries = await this.inner.snapshot();
    if (!Array.isArray(entries)) return entries;
    return entries.filter(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        typeof entry.path !== "string" ||
        this.includes(entry.path),
    );
  }

  read(path: string) {
    this.check(path);
    return this.inner.read(path);
  }

  create(path: string, bytes: Uint8Array) {
    this.check(path);
    return this.inner.create(path, bytes);
  }

  write(path: string, bytes: Uint8Array, expectedVersion: string) {
    this.check(path);
    return this.inner.write(path, bytes, expectedVersion);
  }

  get remove(): VaultStoragePort["remove"] {
    const remove = this.inner.remove;
    if (!remove) return undefined;
    return (path: string, expectedVersion: string) => {
      this.check(path);
      return remove.call(this.inner, path, expectedVersion);
    };
  }

  mkdir(path: string): Promise<void> {
    this.check(path);
    return this.inner.mkdir(path);
  }

  private check(path: string): void {
    if (typeof path !== "string" || !this.includes(path))
      throw new Error(`Path is outside the ${this.label}: ${String(path)}`);
  }
}
