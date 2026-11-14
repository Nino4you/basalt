import { Document, parseDocument } from "yaml";
import { LinkUpdate } from "../app/link-update";
import { scanNote } from "../app/vault-index";
import { canvasIndexText } from "../canvas/model";
import { attachmentFolder, availablePath } from "../attachments";
import { getFrontMatterInfo } from "./frontmatter";
import type { TFile, TFolder } from "./files";
import type { Vault } from "./vault";

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function folderPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "/" : path.slice(0, slash);
}

/** The small, non-destructive part of Obsidian's FileManager used by plugins. */
export class FileManager {
  constructor(
    private readonly vault: Vault,
    /** The user's "Automatically update internal links" preference. */
    private readonly updateLinks: () => boolean = () => false,
    /** The user's attachment folder setting, see `attachmentFolder`. */
    private readonly attachmentSetting: () => string = () => "./",
  ) {}

  getNewFileParent(sourcePath: string): TFolder {
    return (
      this.vault.getFolderByPath(folderPath(sourcePath)) ?? this.vault.getRoot()
    );
  }

  async getAvailablePathForAttachment(
    filename: string,
    sourcePath = "",
  ): Promise<string> {
    const folder = attachmentFolder(this.attachmentSetting(), sourcePath);
    // Like Obsidian, the configured folder exists once the path is handed out.
    const parts = folder ? folder.split("/") : [];
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      if (!this.vault.getAbstractFileByPath(path))
        await this.vault.createFolder(path);
    }
    const safe = filename.replace(/[\\/:]/g, "-");
    return availablePath(
      folder,
      safe,
      (candidate) => !!this.vault.getAbstractFileByPath(candidate),
    );
  }

  generateMarkdownLink(
    file: TFile,
    _sourcePath?: string,
    subpath?: string,
    alias?: string,
  ): string {
    const target = subpath ? `${file.path}${subpath}` : file.path;
    return alias ? `[[${target}|${alias}]]` : `[[${target}]]`;
  }

  async createNewMarkdownFile(
    parent: TFolder,
    filename: string,
  ): Promise<TFile> {
    const path = `${parent.path === "/" ? "" : `${parent.path}/`}${filename.endsWith(".md") ? filename : `${filename}.md`}`;
    return this.vault.create(path, `# ${filename.replace(/\.md$/i, "")}\n\n`);
  }

  async createFolder(path: string): Promise<TFolder> {
    return this.vault.createFolder(path);
  }

  /**
   * Renames or moves a file and, if the user wants that, rewrites the links
   * to it like a rename in the app does. Each rewrite is a version-checked
   * `Vault.process`; a failed one leaves that file unchanged and is reported
   * after the others were tried.
   */
  async renameFile(file: TFile, newPath: string): Promise<void> {
    const oldPath = file.path;
    const update =
      this.updateLinks() && newPath !== oldPath
        ? new LinkUpdate(
            this.vault.getFiles().map((entry) => entry.path),
            new Map([[oldPath, newPath]]),
          )
        : null;
    const sources = update ? await this.linkSources(update) : [];
    await this.vault.rename(file, newPath);
    if (!update) return;
    const failures: unknown[] = [];
    for (const source of sources) {
      const target = this.vault.getFileByPath(update.moved(source));
      if (!target) continue;
      try {
        await this.vault.process(
          target,
          (text) => update.rewrite(text, source) ?? text,
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        `Renamed ${oldPath} to ${newPath}, but links in ${failures.length} file(s) could not be updated`,
      );
  }

  /** Notes and canvases whose links the update would change (old paths). */
  private async linkSources(update: LinkUpdate): Promise<string[]> {
    const sources: string[] = [];
    for (const entry of this.vault.getFiles()) {
      const canvas = entry.extension.toLowerCase() === "canvas";
      if (!canvas && entry.extension.toLowerCase() !== "md") continue;
      const text = await this.vault.cachedRead(entry);
      const links = scanNote(canvas ? canvasIndexText(text) : text).links;
      if (update.affects(entry.path, links)) sources.push(entry.path);
    }
    return sources;
  }

  async trashFile(file: TFile): Promise<void> {
    await this.vault.delete(file);
  }

  async processFrontMatter(
    file: TFile,
    fn: (frontmatter: Record<string, unknown>) => void,
    _options?: { ctime?: number; mtime?: number },
  ): Promise<void> {
    await this.vault.process(file, (text) => {
      const info = getFrontMatterInfo(text);
      const body = info.exists
        ? text.slice(info.contentStart).replace(/^\r?\n/, "")
        : text;
      const doc = info.exists
        ? parseDocument(info.frontmatter)
        : new Document({});
      if (doc.errors.length) throw doc.errors[0];
      const frontmatter = plainObject(doc.toJS());
      const before = structuredClone(frontmatter);

      fn(frontmatter);

      // Rewrite only the changed keys so untouched YAML keeps its formatting.
      let changed = false;
      for (const key of Object.keys(before))
        if (!(key in frontmatter)) {
          doc.delete(key);
          changed = true;
        }
      for (const [key, value] of Object.entries(frontmatter))
        if (
          !(key in before) ||
          JSON.stringify(before[key]) !== JSON.stringify(value)
        ) {
          doc.set(key, value);
          changed = true;
        }
      if (!changed) return text;

      const serialized = doc.toString();
      return `---\n${serialized}${serialized.endsWith("\n") ? "" : "\n"}---\n\n${body}`;
    });
  }
}
