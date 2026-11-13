import { canvasIndexText } from "../canvas/model";

/**
 * In-memory metadata for the open vault: link graph, tags and searchable text.
 * The backend only lists and reads notes, so everything here is derived in the
 * WebView and kept incremental (one note re-scanned per edit).
 */

export interface LinkRef {
  /** Raw link target as written, without alias. */
  target: string;
  line: number;
  /** Start column of the link in its line. */
  col: number;
  length: number;
  embed: boolean;
}

export interface NoteMeta {
  links: LinkRef[];
  tags: string[];
  /** Same tags with their source position, in first-seen order. */
  tagRefs: TagRef[];
}

export interface TagRef {
  /** Tag without the leading `#`. */
  tag: string;
  line: number;
  col: number;
  length: number;
}

export interface Mention {
  source: string;
  line: number;
  col: number;
  length: number;
  text: string;
}

const WIKI = /(!?)\[\[([^\]\n]+?)\]\]/g;
const MD_LINK = /(!?)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const TAG = /(?:^|[\s(])#([\p{L}\p{N}_/-]+)/gu;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Blanks out inline code so its contents are not read as links or tags. */
function maskInlineCode(line: string): string {
  if (!line.includes("`")) return line;
  return line.replace(/(`+)([^`]|[^`].*?[^`])\1(?!`)/g, (match) =>
    " ".repeat(match.length),
  );
}

export function frontmatterEnd(lines: readonly string[]): number {
  if (!/^---\s*$/.test(lines[0] ?? "")) return 0;
  for (let i = 1; i < lines.length; i++)
    if (/^(---|\.\.\.)\s*$/.test(lines[i])) return i + 1;
  return 0;
}

function frontmatterTags(lines: readonly string[], end: number): TagRef[] {
  const tags: TagRef[] = [];
  for (let i = 1; i < end - 1; i++) {
    const inline = /^tags?:\s*(.*)$/i.exec(lines[i]);
    if (!inline) continue;
    const rest = inline[1].trim();
    if (rest) {
      const base = inline[0].length - rest.length;
      const token = /[^\s,[\]"']+/g;
      for (let m = token.exec(rest); m; m = token.exec(rest)) {
        const value = m[0].replace(/^#+/, "");
        if (value)
          tags.push({
            tag: value,
            line: i,
            col: base + m.index,
            length: m[0].length,
          });
      }
    } else {
      for (let j = i + 1; j < end - 1; j++) {
        const item = /^\s*-\s+(.+)$/.exec(lines[j]);
        if (!item) break;
        const raw = item[1].trim();
        const value = raw.replace(/^["'#]+|["']+$/g, "");
        if (value)
          tags.push({
            tag: value,
            line: j,
            col: lines[j].indexOf(raw),
            length: raw.length,
          });
      }
    }
  }
  return tags;
}

export function scanNote(text: string): NoteMeta {
  const links: LinkRef[] = [];
  const tags = new Map<string, TagRef>();
  const lines = text.split("\n");
  const start = frontmatterEnd(lines);
  for (const ref of frontmatterTags(lines, start))
    if (!tags.has(ref.tag)) tags.set(ref.tag, ref);
  let fence: string | null = null;
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    const delimiter = FENCE.exec(raw);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (
        delimiter[1][0] === fence[0] &&
        delimiter[1].length >= fence.length
      )
        fence = null;
      continue;
    }
    if (fence) continue;
    if (!raw.includes("[") && !raw.includes("#")) continue;
    const line = maskInlineCode(raw);
    if (line.includes("[[")) {
      WIKI.lastIndex = 0;
      for (let m = WIKI.exec(line); m; m = WIKI.exec(line)) {
        const target = m[2].split("|")[0].trim();
        if (target)
          links.push({
            target,
            line: i,
            col: m.index,
            length: m[0].length,
            embed: !!m[1],
          });
      }
    }
    if (line.includes("](")) {
      MD_LINK.lastIndex = 0;
      for (let m = MD_LINK.exec(line); m; m = MD_LINK.exec(line)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(m[2]) || m[2].startsWith("#")) continue;
        let target = m[2];
        try {
          target = decodeURIComponent(target);
        } catch {
          // Keep the literal target when it is not valid percent-encoding.
        }
        links.push({
          target,
          line: i,
          col: m.index,
          length: m[0].length,
          embed: !!m[1],
        });
      }
    }
    if (line.includes("#")) {
      TAG.lastIndex = 0;
      for (let m = TAG.exec(line); m; m = TAG.exec(line)) {
        if (/^\d+$/.test(m[1]) || tags.has(m[1])) continue;
        const col = m.index + m[0].length - m[1].length - 1;
        tags.set(m[1], {
          tag: m[1],
          line: i,
          col,
          length: m[1].length + 1,
        });
      }
    }
  }
  return { links, tags: [...tags.keys()], tagRefs: [...tags.values()] };
}

/** Cached marker for links that point at their own source note. */
const SELF = "\0self";

const isNote = (path: string) => /\.md$/i.test(path);

/** One Markdown note's distinct contributions to the note graph. */
export interface NoteLinks {
  /** Resolved Markdown notes it links to, without itself. */
  notes: string[];
  /** Unresolved targets: graph id (`?<lowercase name>`) to the name as written. */
  unresolved: Map<string, string>;
  /** Tags: graph id (`#<lowercase tag>`) to the tag as written. */
  tags: Map<string, string>;
}

/**
 * Link graph between Markdown notes in both directions, plus which notes use
 * each unresolved target and tag. Kept up to date one note at a time, so the
 * local graph can walk a neighbourhood without resolving the whole vault on
 * every edit; a new file list (which changes link resolution) drops it.
 */
export class NoteGraph {
  readonly out = new Map<string, NoteLinks>();
  /** Note to the notes that link to it. */
  readonly incoming = new Map<string, Set<string>>();
  /** Unresolved or tag id to the notes that use it. */
  readonly users = new Map<string, Set<string>>();
  /** Position in the file list, for orders that match a full rebuild. */
  readonly position = new Map<string, number>();

  linksOf(path: string): NoteLinks | undefined {
    return this.out.get(path);
  }

  /** Earliest note in file-list order, so labels match a full rebuild. */
  first(paths: Iterable<string>): string | undefined {
    let best: string | undefined;
    let rank = Infinity;
    for (const path of paths) {
      const at = this.position.get(path) ?? Infinity;
      if (at < rank) [best, rank] = [path, at];
    }
    return best;
  }

  remove(path: string): void {
    const old = this.out.get(path);
    if (!old) return;
    this.out.delete(path);
    for (const note of old.notes) this.incoming.get(note)?.delete(path);
    for (const id of [...old.unresolved.keys(), ...old.tags.keys()]) {
      const set = this.users.get(id);
      set?.delete(path);
      if (set && !set.size) this.users.delete(id);
    }
  }

  add(path: string, links: NoteLinks): void {
    this.out.set(path, links);
    for (const note of links.notes) {
      let set = this.incoming.get(note);
      if (!set) this.incoming.set(note, (set = new Set()));
      set.add(path);
    }
    for (const id of [...links.unresolved.keys(), ...links.tags.keys()]) {
      let set = this.users.get(id);
      if (!set) this.users.set(id, (set = new Set()));
      set.add(path);
    }
  }
}

export class VaultIndex {
  files: string[] = [];
  private fileSet = new Set<string>();
  private byName = new Map<string, string[]>();
  private lowerPath = new Map<string, string>();
  /** `resolve` results by source folder and target; reset with the file list. */
  private resolved = new Map<string, string | null>();
  private readonly contents = new Map<string, string>();
  private readonly lowered = new Map<string, string>();
  private readonly meta = new Map<string, NoteMeta>();
  private backlinkCache: Map<string, Mention[]> | null = null;
  private tagCache: Map<string, string[]> | null = null;
  private graph: NoteGraph | null = null;
  private readonly listeners = new Set<() => void>();
  /** Bumped on every change; views use it to skip redundant renders. */
  revision = 0;

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private changed(): void {
    this.revision++;
    this.backlinkCache = null;
    this.tagCache = null;
    for (const listener of this.listeners) listener();
  }

  setFiles(files: string[]): void {
    this.files = files;
    this.fileSet = new Set(files);
    this.byName = new Map();
    this.lowerPath = new Map();
    this.resolved = new Map();
    this.graph = null;
    for (const path of files) {
      const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
      const list = this.byName.get(name);
      if (list) list.push(path);
      else this.byName.set(name, [path]);
      this.lowerPath.set(path.toLowerCase(), path);
    }
    for (const path of [...this.contents.keys()])
      if (!this.fileSet.has(path)) {
        this.contents.delete(path);
        this.lowered.delete(path);
        this.meta.delete(path);
      }
    this.changed();
  }

  has(path: string): boolean {
    return this.fileSet.has(path);
  }

  reset(): void {
    this.contents.clear();
    this.lowered.clear();
    this.meta.clear();
    this.setFiles([]);
  }

  /** `silent` batches many updates (initial indexing) behind one notification. */
  setContent(path: string, text: string, silent = false): void {
    // Canvases are indexed through a Markdown stand-in: file cards as links,
    // card text as searchable lines.
    if (/\.canvas$/i.test(path)) text = canvasIndexText(text);
    if (this.contents.get(path) === text) return;
    this.contents.set(path, text);
    this.lowered.delete(path);
    this.meta.set(path, scanNote(text));
    if (this.graph && isNote(path) && this.fileSet.has(path)) {
      this.graph.remove(path);
      this.graph.add(path, this.noteLinks(path));
    }
    if (silent) {
      this.backlinkCache = null;
      this.tagCache = null;
    } else this.changed();
  }

  flush(): void {
    this.changed();
  }

  content(path: string): string | undefined {
    return this.contents.get(path);
  }

  metaOf(path: string): NoteMeta | undefined {
    return this.meta.get(path);
  }

  lower(path: string): string {
    let value = this.lowered.get(path);
    if (value === undefined) {
      value = (this.contents.get(path) ?? "").toLowerCase();
      this.lowered.set(path, value);
    }
    return value;
  }

  /**
   * Same rules as `resolveNote` in markdown.ts (same folder, vault root, then a
   * unique basename), backed by maps instead of scanning the file list.
   */
  resolve(target: string, source: string): string | null {
    // The answer depends only on the file list and the source's folder, and
    // backlinks and the graph resolve every link in the vault on each rebuild.
    const key = `${source.slice(0, source.lastIndexOf("/") + 1)}\0${target}`;
    let cached = this.resolved.get(key);
    if (cached === undefined) {
      cached = this.resolveUncached(target, source);
      this.resolved.set(key, cached);
    }
    // An empty name links to the source itself, which differs per source.
    return cached === SELF ? source : cached;
  }

  private resolveUncached(target: string, source: string): string | null {
    const name = target.split("#")[0].split("^")[0].trim();
    if (!name) return SELF;
    if (this.fileSet.has(name)) return name;
    const requested = /\.md$/i.test(name) ? name : `${name}.md`;
    const slash = source.lastIndexOf("/");
    if (slash >= 0) {
      const sibling = source.slice(0, slash + 1) + requested;
      if (this.fileSet.has(sibling)) return sibling;
    }
    if (this.fileSet.has(requested)) return requested;
    const exact = this.lowerPath.get(requested.toLowerCase());
    if (exact) return exact;
    if (requested.includes("/")) return null;
    const matches = this.byName.get(requested.toLowerCase());
    return matches?.length === 1 ? matches[0] : null;
  }

  /** The note link graph, built once per file list and then kept current. */
  noteGraph(): NoteGraph {
    if (this.graph) return this.graph;
    const graph = new NoteGraph();
    this.files.forEach((path, i) => {
      if (!isNote(path)) return;
      graph.position.set(path, i);
      if (this.meta.has(path)) graph.add(path, this.noteLinks(path));
    });
    return (this.graph = graph);
  }

  /** Same rules as the full graph build in graph-model.ts. */
  private noteLinks(path: string): NoteLinks {
    const links: NoteLinks = {
      notes: [],
      unresolved: new Map(),
      tags: new Map(),
    };
    const meta = this.meta.get(path);
    if (!meta) return links;
    const notes = new Set<string>();
    for (const ref of meta.links) {
      const resolved = this.resolve(ref.target, path);
      if (resolved) {
        // Links to attachments are not part of the note graph.
        if (resolved !== path && isNote(resolved)) notes.add(resolved);
        continue;
      }
      const name = ref.target.split("#")[0].split("^")[0].trim();
      if (!name) continue;
      const label = name.replace(/\.md$/i, "");
      const id = `?${label.toLowerCase()}`;
      if (!links.unresolved.has(id)) links.unresolved.set(id, label);
    }
    links.notes = [...notes];
    for (const tag of meta.tags) {
      const id = `#${tag.toLowerCase()}`;
      if (!links.tags.has(id)) links.tags.set(id, tag);
    }
    return links;
  }

  private buildBacklinks(): Map<string, Mention[]> {
    const result = new Map<string, Mention[]>();
    for (const [source, meta] of this.meta) {
      for (const link of meta.links) {
        const resolved = this.resolve(link.target, source);
        if (!resolved || resolved === source) continue;
        let list = result.get(resolved);
        if (!list) result.set(resolved, (list = []));
        list.push({
          source,
          line: link.line,
          col: link.col,
          length: link.length,
          text: "",
        });
      }
    }
    return result;
  }

  backlinks(path: string): Mention[] {
    this.backlinkCache ??= this.buildBacklinks();
    const mentions = this.backlinkCache.get(path) ?? [];
    // Context lines are filled in only for the note that is asked about.
    let source = "";
    let lines: string[] = [];
    for (const mention of mentions) {
      if (mention.text) continue;
      if (mention.source !== source) {
        source = mention.source;
        lines = (this.contents.get(source) ?? "").split("\n");
      }
      mention.text = lines[mention.line] ?? "";
    }
    return mentions;
  }

  outgoing(path: string): Array<{ target: string; resolved: string | null }> {
    const seen = new Set<string>();
    const result: Array<{ target: string; resolved: string | null }> = [];
    for (const link of this.meta.get(path)?.links ?? []) {
      const resolved = this.resolve(link.target, path);
      const key = resolved ?? `?${link.target.split("#")[0].toLowerCase()}`;
      if (resolved === path || seen.has(key)) continue;
      seen.add(key);
      result.push({ target: link.target.split("#")[0], resolved });
    }
    return result;
  }

  /** Tag (without `#`) to the notes that use it. */
  tags(): Map<string, string[]> {
    if (!this.tagCache) {
      const tags = new Map<string, string[]>();
      for (const [path, meta] of this.meta)
        for (const tag of meta.tags) {
          const list = tags.get(tag);
          if (list) list.push(path);
          else tags.set(tag, [path]);
        }
      this.tagCache = tags;
    }
    return this.tagCache;
  }
}

export interface SearchMatch {
  line: number;
  /** Offset of the match inside `text`. */
  start: number;
  length: number;
  /** Offset of the match from the start of the note. */
  offset: number;
  text: string;
}

export interface SearchResult {
  path: string;
  nameMatch: boolean;
  matches: SearchMatch[];
}

export interface ParsedQuery {
  terms: string[];
  tags: string[];
  path: string[];
  file: string[];
  excludedTerms: string[];
  excludedTags: string[];
  excludedPath: string[];
  excludedFile: string[];
}

/** Supports plain terms, "quoted phrases", `-` exclusions and `tag:`, `path:` and `file:` operators. */
export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = {
    terms: [],
    tags: [],
    path: [],
    file: [],
    excludedTerms: [],
    excludedTags: [],
    excludedPath: [],
    excludedFile: [],
  };
  const pattern = /(-)?(?:(tag|path|file):)?(?:"([^"]*)"|(\S+))/gi;
  for (let m = pattern.exec(query); m; m = pattern.exec(query)) {
    const value = (m[3] ?? m[4]).toLowerCase();
    if (!value) continue;
    const operator = m[2]?.toLowerCase();
    if (m[1]) {
      if (operator === "tag") parsed.excludedTags.push(value.replace(/^#/, ""));
      else if (operator === "path") parsed.excludedPath.push(value);
      else if (operator === "file") parsed.excludedFile.push(value);
      else if (value.startsWith("#") && value.length > 1)
        parsed.excludedTags.push(value.slice(1));
      else parsed.excludedTerms.push(value);
      continue;
    }
    if (operator === "tag") parsed.tags.push(value.replace(/^#/, ""));
    else if (operator === "path") parsed.path.push(value);
    else if (operator === "file") parsed.file.push(value);
    else if (value.startsWith("#") && value.length > 1)
      parsed.tags.push(value.slice(1));
    else parsed.terms.push(value);
  }
  return parsed;
}

const MAX_MATCHES_PER_FILE = 30;

export function searchNote(
  index: VaultIndex,
  path: string,
  query: ParsedQuery,
): SearchResult | null {
  const lowerPath = path.toLowerCase();
  const name = lowerPath.slice(lowerPath.lastIndexOf("/") + 1);
  if (query.path.some((part) => !lowerPath.includes(part))) return null;
  if (query.file.some((part) => !name.includes(part))) return null;
  if (query.excludedPath.some((part) => lowerPath.includes(part))) return null;
  if (query.excludedFile.some((part) => name.includes(part))) return null;
  if (query.tags.length || query.excludedTags.length) {
    const tags = (index.metaOf(path)?.tags ?? []).map((tag) =>
      tag.toLowerCase(),
    );
    const matchesTag = (wanted: string) =>
      tags.some((tag) => tag === wanted || tag.startsWith(`${wanted}/`));
    if (!query.tags.every(matchesTag)) return null;
    if (query.excludedTags.some(matchesTag)) return null;
  }
  const lower = index.lower(path);
  let nameMatch = false;
  for (const term of query.terms) {
    const inName = lowerPath.includes(term);
    if (!inName && !lower.includes(term)) return null;
    nameMatch ||= inName;
  }
  for (const term of query.excludedTerms) {
    if (lowerPath.includes(term) || lower.includes(term)) return null;
  }
  const matches: SearchMatch[] = [];
  if (query.terms.length && lower) {
    const text = index.content(path) ?? "";
    for (const term of query.terms) {
      for (
        let at = lower.indexOf(term);
        at >= 0 && matches.length < MAX_MATCHES_PER_FILE;
        at = lower.indexOf(term, at + term.length)
      ) {
        const lineStart = lower.lastIndexOf("\n", at - 1) + 1;
        let lineEnd = lower.indexOf("\n", at);
        if (lineEnd < 0) lineEnd = lower.length;
        // Long lines are trimmed around the hit so rows stay cheap to render.
        const from = Math.max(lineStart, at - 60);
        const to = Math.min(lineEnd, at + term.length + 120);
        matches.push({
          line: 0,
          offset: at,
          start: at - from + (from > lineStart ? 1 : 0),
          length: term.length,
          text:
            (from > lineStart ? "…" : "") +
            text.slice(from, to) +
            (to < lineEnd ? "…" : ""),
        });
      }
    }
    matches.sort((a, b) => a.offset - b.offset);
  }
  if (
    !query.terms.length &&
    !query.tags.length &&
    !query.path.length &&
    !query.file.length &&
    !query.excludedTerms.length &&
    !query.excludedTags.length &&
    !query.excludedPath.length &&
    !query.excludedFile.length
  )
    return null;
  return { path, nameMatch, matches };
}
