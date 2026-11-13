import { scanNote } from "../app/vault-index";
import { documentOutline, splitFrontmatter } from "../markdown";
import { Events } from "./events";
import { TFile, type TAbstractFile } from "./files";
import type { Vault } from "./vault";

export interface Position {
  line: number;
  col: number;
  offset: number;
}

export interface Pos {
  start: Position;
  end: Position;
}

export interface LinkCache {
  link: string;
  original: string;
  position: Pos;
}

export interface EmbedCache {
  link: string;
  original: string;
  position: Pos;
}

export interface TagCache {
  tag: string;
  position: Pos;
}

export interface HeadingCache {
  heading: string;
  level: number;
  position: Pos;
}

export type FrontMatterCache = Record<string, string | string[]>;

export interface CachedMetadata {
  links: LinkCache[];
  embeds: EmbedCache[];
  tags: TagCache[];
  headings: HeadingCache[];
  frontmatter?: FrontMatterCache;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (
    let at = source.indexOf("\n");
    at >= 0;
    at = source.indexOf("\n", at + 1)
  )
    starts.push(at + 1);
  return starts;
}

/** Notes per batched read during `reindex`. */
const REINDEX_BATCH = 64;

/** Last line whose start is at or before `offset` (binary search). */
function lineOfOffset(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

function withoutMarkdown(path: string): string {
  return path.replace(/\.md$/i, "");
}

/** Same first-wins order as `scanNote`, so positions match the app's own parser. */
function parseNote(source: string): CachedMetadata {
  const note = scanNote(source);
  const starts = lineStarts(source);
  const pos = (line: number, col: number, length: number): Pos => {
    const offset = (starts[line] ?? 0) + col;
    return {
      start: { line, col, offset },
      end: { line, col: col + length, offset: offset + length },
    };
  };

  const links: LinkCache[] = [];
  const embeds: EmbedCache[] = [];
  for (const link of note.links) {
    // The scanner keeps the target without alias; `original` cannot restore it.
    const cache = {
      link: link.target,
      original: link.target,
      position: pos(link.line, link.col, link.length),
    };
    if (link.embed) embeds.push(cache);
    else links.push(cache);
  }

  const headings = documentOutline(source).map((entry) => {
    const line = lineOfOffset(starts, entry.offset);
    const col = source.indexOf("#", entry.offset) - starts[line];
    return {
      heading: entry.text,
      level: entry.depth,
      position: pos(line, col, entry.text.length),
    };
  });

  const properties = splitFrontmatter(source).properties;
  const frontmatter: FrontMatterCache | undefined = properties
    ? Object.fromEntries(
        properties.map((property) => [
          property.key,
          property.values.length > 1
            ? property.values
            : (property.values[0] ?? ""),
        ]),
      )
    : undefined;

  const result: CachedMetadata = {
    links,
    embeds,
    tags: note.tagRefs.map((ref) => ({
      tag: `#${ref.tag}`,
      position: pos(ref.line, ref.col, ref.length),
    })),
    headings,
  };
  if (frontmatter) result.frontmatter = frontmatter;
  return result;
}

/**
 * Parsed note metadata for plugins. The vault only reads text on demand, so
 * `reindex()` warms every Markdown note once and vault events keep it current;
 * `getFileCache` stays synchronous and returns null until a note is indexed.
 */
export class MetadataCache extends Events {
  private readonly cache = new Map<string, CachedMetadata>();

  constructor(private readonly vault: Vault) {
    super();
    this.vault.on(
      "modify",
      (file: TAbstractFile) => void this.refreshFile(file),
    );
    this.vault.on(
      "create",
      (file: TAbstractFile) => void this.refreshFile(file),
    );
    this.vault.on("delete", (file: TAbstractFile) =>
      this.cache.delete(file.path),
    );
    this.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
      this.cache.delete(oldPath);
      void this.refreshFile(file);
    });
  }

  get resolvedLinks(): Record<string, Record<string, number>> {
    return this.linkCounts(true);
  }

  get unresolvedLinks(): Record<string, Record<string, number>> {
    return this.linkCounts(false);
  }

  private linkCounts(resolved: boolean): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = Object.create(null);
    for (const [source, metadata] of this.cache) {
      const counts: Record<string, number> = Object.create(null);
      for (const link of [...metadata.links, ...metadata.embeds]) {
        const linkpath = link.link.split("#")[0].split("^")[0].trim();
        if (!linkpath) continue;
        const file = this.getFirstLinkpathDest(linkpath, source);
        if (Boolean(file) !== resolved) continue;
        const target = file?.path ?? linkpath;
        counts[target] = (counts[target] ?? 0) + 1;
      }
      if (Object.keys(counts).length) result[source] = counts;
    }
    return result;
  }

  getFirstLinkpathDest(linkpath: string, sourcePath = ""): TFile | null {
    const target = linkpath.trim().replace(/^\/+/, "");
    if (!target) return null;
    const exact = this.vault.getFileByPath(target);
    if (exact) return exact;
    const exactMarkdown = this.vault.getFileByPath(`${target}.md`);
    if (exactMarkdown) return exactMarkdown;

    const sourceFolder = sourcePath.includes("/")
      ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
      : "";
    const relative = sourceFolder ? `${sourceFolder}/${target}` : target;
    const relativeFile =
      this.vault.getFileByPath(relative) ??
      this.vault.getFileByPath(`${relative}.md`);
    if (relativeFile) return relativeFile;

    const candidates = this.vault
      .getFiles()
      .filter(
        (file) =>
          file.path === target ||
          file.path.endsWith(`/${target}`) ||
          file.path.endsWith(`/${target}.md`) ||
          (file.extension.toLowerCase() === "md" &&
            file.basename === withoutMarkdown(target)) ||
          file.name === target,
      )
      .sort((first, second) => {
        const firstLocal = first.path.startsWith(`${sourceFolder}/`) ? 0 : 1;
        const secondLocal = second.path.startsWith(`${sourceFolder}/`) ? 0 : 1;
        if (firstLocal !== secondLocal) return firstLocal - secondLocal;
        return (
          first.path.length - second.path.length ||
          first.path.localeCompare(second.path)
        );
      });
    return candidates[0] ?? null;
  }

  fileToLinktext(file: TFile, sourcePath = "", omitMdExtension = true): string {
    // Never drop attachment extensions (e.g. worksheet.pdf vs worksheet.md).
    const short = omitMdExtension ? withoutMarkdown(file.name) : file.name;
    if (this.getFirstLinkpathDest(short, sourcePath) === file) return short;
    const full = omitMdExtension ? withoutMarkdown(file.path) : file.path;
    return full;
  }

  /** Reads every Markdown note so plugins can use `getFileCache` right away. */
  async reindex(): Promise<void> {
    const files = this.vault.getMarkdownFiles();
    const present = new Set(files.map((file) => file.path));
    for (const path of [...this.cache.keys()])
      if (!present.has(path)) this.cache.delete(path);
    // Native reads are IPC round-trips: read in batches, and keep two batches
    // in flight so parsing one overlaps reading the next.
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const batch = files.slice(next, (next += REINDEX_BATCH));
        const texts = await this.vault.cachedReadMany(batch);
        batch.forEach((file, index) => this.applyText(file, texts[index], true));
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(2, files.length) }, worker),
    );
  }

  getFileCache(file: TFile | null): CachedMetadata | null {
    if (!file) return null;
    return this.cache.get(file.path) ?? null;
  }

  getCache(path: string): CachedMetadata | null { return this.cache.get(path) ?? null; }

  /** Tag occurrences across all indexed notes, matching Obsidian's API shape. */
  getTags(): Record<string, number> {
    const tags: Record<string, number> = {};
    for (const cache of this.cache.values())
      for (const tag of cache.tags ?? [])
        tags[tag.tag] = (tags[tag.tag] ?? 0) + 1;
    return tags;
  }
  /** Used by plugins to enumerate metadata already indexed by the host. */
  getCachedFiles(): string[] { return [...this.cache.keys()]; }

  private async refreshFile(file: TAbstractFile, quiet = false): Promise<void> {
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") {
      this.cache.delete(file.path);
      return;
    }
    let text: string | Error;
    try {
      text = await this.vault.cachedRead(file);
    } catch (error) {
      text = error instanceof Error ? error : new Error(String(error));
    }
    this.applyText(file, text, quiet);
  }

  private applyText(file: TFile, text: string | Error, quiet: boolean): void {
    try {
      if (text instanceof Error) throw text;
      // A refresh may have replaced the object while the read was in flight.
      if (this.vault.getFileByPath(file.path) !== file) return;
      const cache = parseNote(text);
      this.cache.set(file.path, cache);
      this.trigger("changed", file, text, cache);
    } catch (error) {
      this.cache.delete(file.path);
      if (!quiet)
        console.warn(`Metadata for ${file.path} is unavailable`, error);
    }
  }
}
