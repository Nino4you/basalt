import { Document, parseDocument } from "yaml";
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
  constructor(private readonly vault: Vault) {}

  getNewFileParent(sourcePath: string): TFolder {
    return (
      this.vault.getFolderByPath(folderPath(sourcePath)) ?? this.vault.getRoot()
    );
  }

  async getAvailablePathForAttachment(
    filename: string,
    sourcePath = "",
  ): Promise<string> {
    const folder = folderPath(sourcePath);
    const safe = filename.replace(/[\\/:]/g, "-");
    const dot = safe.lastIndexOf(".");
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const extension = dot > 0 ? safe.slice(dot) : "";
    let candidate = `${folder === "/" ? "" : `${folder}/`}${safe}`;
    let index = 1;
    while (this.vault.getAbstractFileByPath(candidate))
      candidate = `${folder === "/" ? "" : `${folder}/`}${stem} ${index++}${extension}`;
    return candidate;
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

  async renameFile(file: TFile, newPath: string): Promise<void> {
    await this.vault.rename(file, newPath);
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
