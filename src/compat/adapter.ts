import type { TAbstractFile } from "./files";
import { TFile, TFolder } from "./files";
import { CONFIG_DIRECTORY, PLUGIN_DIRECTORY } from "./plugin-bundles";
import type { PluginResourceUrls } from "./plugin-resources";
import type { Vault } from "./vault";

export interface AdapterStat {
  type: "file" | "folder";
  ctime: number;
  mtime: number;
  size: number;
}

/** Maps a Basalt configuration storage path back to Obsidian's config dir. */
function fromConfigPath(path: string): string {
  if (path === PLUGIN_DIRECTORY || path.startsWith(`${PLUGIN_DIRECTORY}/`))
    return `.obsidian/plugins${path.slice(PLUGIN_DIRECTORY.length)}`;
  if (path === CONFIG_DIRECTORY || path.startsWith(`${CONFIG_DIRECTORY}/`))
    return `.obsidian${path.slice(CONFIG_DIRECTORY.length)}`;
  return path;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * Storage adapter for the part of the Obsidian adapter API that plugins
 * actually call. Obsidian plugin paths are mapped onto the visible Basalt
 * plugin folder, because Android SAF does not reliably expose `.obsidian`.
 *
 * Deletion keeps a native backup. Resource URLs exist only for files in the
 * folder of an activated plugin, served read-only by the native resource
 * protocol with the same path/symlink rules as scoped vault reads. Note
 * content (images, PDFs) has no resource URLs yet.
 */
export class VaultAdapter {
  private readonly config: Vault;

  /**
   * `config` is the separate view on `Basalt/Plugins`. The plugin-facing
   * vault hides that folder, as Obsidian hides `.obsidian`, so plugin paths
   * resolve through the config view. Without one, both share `vault`.
   */
  constructor(
    private readonly vault: Vault,
    private readonly basePath: string | null = null,
    config?: Vault,
    private readonly resources: PluginResourceUrls | null = null,
  ) {
    this.config = config ?? vault;
  }

  getBasePath(): string | null {
    return this.basePath;
  }

  private resolve(path: string): {
    vault: Vault;
    path: string;
    /** Maps a storage path from the resolved vault back to the plugin's view. */
    external: (inner: string) => string;
  } {
    if (
      typeof path !== "string" ||
      path.includes("\\") ||
      /[\u0000-\u001f\u007f-\u009f]/.test(path)
    )
      throw new Error("Invalid vault-relative adapter path");
    // Obsidian adapters accept what `normalizePath` produces and what plugins
    // build by string concatenation: leading or trailing slashes and repeated
    // separators (Iconize checks `${folder}/` for its icon folder). Collapsing
    // those never changes which file is meant. Traversal stays rejected, so
    // nothing can leave the vault.
    const normalized = path.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
    if (
      normalized &&
      normalized.split("/").some((part) => part === "." || part === "..")
    )
      throw new Error("Invalid vault-relative adapter path");
    const config = normalized.match(/^\.obsidian(?:\/(.*))?$/);
    if (config) {
      const rest = config[1] ?? "";
      if (rest.split("/").some((part) => part.startsWith(".")))
        throw new Error("Invalid or hidden plugin adapter path");
      const plugin = rest.match(/^plugins\/([^/]+)(?:\/(.*))?$/);
      if (plugin) {
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(plugin[1]))
          throw new Error("Invalid or hidden plugin adapter path");
        return {
          vault: this.config,
          path: `${PLUGIN_DIRECTORY}/${plugin[1]}${plugin[2] ? `/${plugin[2]}` : ""}`,
          external: (inner) => fromConfigPath(inner),
        };
      }
      // Other configuration (Iconize keeps icon packs in `.obsidian/icons`)
      // lives in a visible folder that, like the plugin folder, is hidden
      // from vault content and reachable only through this adapter.
      return {
        vault: this.config,
        path: rest ? `${CONFIG_DIRECTORY}/${rest}` : CONFIG_DIRECTORY,
        external: (inner) => fromConfigPath(inner),
      };
    }
    if (normalized.split("/").some((part) => part.startsWith(".")))
      throw new Error(`Hidden paths are not exposed to plugins: ${normalized}`);
    return { vault: this.vault, path: normalized, external: (inner) => inner };
  }

  async stat(path: string): Promise<AdapterStat | null> {
    const target = this.resolve(path);
    const entry = target.vault.getAbstractFileByPath(target.path);
    if (!entry) return null;
    if (entry instanceof TFolder)
      return { type: "folder", ctime: 0, mtime: 0, size: 0 };
    const file = entry as TFile;
    return {
      type: "file",
      ctime: file.stat.ctime,
      mtime: file.stat.mtime,
      size: file.stat.size,
    };
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
  }

  async read(path: string): Promise<string> {
    const { vault, file } = this.requireFile(path);
    return vault.read(file);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const { vault, file } = this.requireFile(path);
    return vault.readBinary(file);
  }

  async write(path: string, data: string): Promise<void> {
    const target = this.resolve(path);
    const existing = target.vault.getFileByPath(target.path);
    if (existing) await target.vault.modify(existing, data);
    else
      await this.createWithParents(
        target.vault,
        target.path,
        new TextEncoder().encode(data),
      );
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const target = this.resolve(path);
    const bytes = new Uint8Array(data);
    const existing = target.vault.getFileByPath(target.path);
    if (existing)
      await target.vault.modifyBinary(existing, bytes.slice().buffer);
    else await this.createWithParents(target.vault, target.path, bytes);
  }

  async mkdir(path: string): Promise<void> {
    const target = this.resolve(path);
    const entry = target.vault.getAbstractFileByPath(target.path);
    if (entry instanceof TFolder) return;
    if (entry) throw new Error(`Vault path is not a folder: ${path}`);
    await this.ensureFolder(target.vault, target.path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const target = this.resolve(path);
    const folder = target.vault.getFolderByPath(target.path);
    if (!folder) return { files: [], folders: [] };
    return {
      files: folder.children
        .filter((child) => child instanceof TFile)
        .map((child) => target.external(child.path)),
      folders: folder.children
        .filter((child) => child instanceof TFolder)
        .map((child) => target.external(child.path)),
    };
  }

  async remove(path: string): Promise<void> {
    const { vault, file } = this.requireFile(path);
    await vault.delete(file);
  }

  async rename(path: string, nextPath: string): Promise<void> {
    const { vault, file } = this.requireFile(path);
    const next = this.resolve(nextPath);
    if (next.vault !== vault)
      throw new Error(
        "Files cannot be moved between plugin configuration and vault content",
      );
    await vault.rename(file, next.path);
  }

  getResourcePath(path: string): string {
    const target = this.resolve(path);
    const plugin =
      target.vault === this.config
        ? target.path.match(/^Basalt\/Plugins\/([^/]+)(?:\/(.*))?$/)
        : null;
    if (!plugin)
      throw new Error(
        `Resource URLs are only available for plugin folders; read ${target.path} as binary data instead`,
      );
    if (!this.resources?.available)
      throw new Error(
        `No resource URLs are available on this platform: ${target.path}`,
      );
    const url = this.resources.url(plugin[1], plugin[2] ?? "");
    if (url === null)
      throw new Error(
        `Resource URLs are only available for activated plugins: ${target.path}`,
      );
    return url;
  }

  private requireFile(path: string): { vault: Vault; file: TFile } {
    const target = this.resolve(path);
    const entry: TAbstractFile | null = target.vault.getAbstractFileByPath(
      target.path,
    );
    if (!(entry instanceof TFile))
      throw new Error(`Vault file not found: ${path}`);
    return { vault: target.vault, file: entry };
  }

  private async createWithParents(
    vault: Vault,
    mapped: string,
    bytes: Uint8Array,
  ): Promise<void> {
    await this.ensureFolder(vault, parentOf(mapped));
    await vault.createBinary(mapped, bytes.slice().buffer);
  }

  private async ensureFolder(vault: Vault, path: string): Promise<void> {
    if (!path) return;
    const entry = vault.getAbstractFileByPath(path);
    if (entry instanceof TFolder) return;
    if (entry) throw new Error(`Vault path is not a folder: ${path}`);
    await this.ensureFolder(vault, parentOf(path));
    if (!vault.getFolderByPath(path)) await vault.createFolder(path);
  }
}
