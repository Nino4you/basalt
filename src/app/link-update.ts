import { parseCanvas, serializeCanvas } from "../canvas/model";
import { linkName, LinkResolver, scanNote, type LinkRef } from "./vault-index";

/**
 * Keeps links pointing at their file when files move or are renamed.
 *
 * A link needs a rewrite exactly when the file it resolved to before the
 * move is not the file it resolves to afterwards: links to the moved file,
 * relative links inside the moved note, and links that a new name would make
 * ambiguous. Every other link stays byte for byte as it was.
 */
export class LinkUpdate {
  readonly before: LinkResolver;
  readonly after: LinkResolver;

  constructor(
    files: readonly string[],
    /** Old path to new path. */
    private readonly moves: ReadonlyMap<string, string>,
  ) {
    this.before = new LinkResolver(files);
    this.after = new LinkResolver(files.map((path) => this.moved(path)));
  }

  /** Where a file is after the move. */
  moved(path: string): string {
    return this.moves.get(path) ?? path;
  }

  /** Whether any of `links` (in the note at `source`) would change target. */
  affects(source: string, links: readonly LinkRef[]): boolean {
    return links.some((link) => this.needsRewrite(link.target, source));
  }

  private needsRewrite(target: string, source: string): boolean {
    const old = this.before.resolve(target, source);
    // A link to the note itself (`[[#Heading]]`) moves with it.
    if (!old || !linkName(target)) return false;
    return this.after.resolve(target, this.moved(source)) !== this.moved(old);
  }

  /**
   * The note's text with every affected link rewritten, or `null` when
   * nothing changes. `source` is the note's path before the move.
   */
  rewriteNote(text: string, source: string): string | null {
    const lines = text.split("\n");
    let changed = false;
    // Right to left, so earlier columns stay valid after a replacement.
    const links = scanNote(text).links.sort(
      (a, b) => b.line - a.line || b.col - a.col,
    );
    for (const link of links) {
      if (!this.needsRewrite(link.target, source)) continue;
      const line = lines[link.line];
      const raw = line.slice(link.col, link.col + link.length);
      const next = this.rewriteLink(raw, link.target, source);
      if (next === null || next === raw) continue;
      lines[link.line] =
        line.slice(0, link.col) + next + line.slice(link.col + link.length);
      changed = true;
    }
    return changed ? lines.join("\n") : null;
  }

  /** Canvas file cards point at exact paths; card text holds Markdown. */
  rewriteCanvas(text: string, source: string): string | null {
    let data;
    try {
      data = parseCanvas(text);
    } catch {
      return null;
    }
    let changed = false;
    for (const node of data.nodes) {
      if (node.type === "file" && node.file) {
        const next = this.moved(node.file);
        if (next !== node.file) {
          node.file = next;
          changed = true;
        }
      } else if (node.type === "text") {
        const next = this.rewriteNote(node.text, source);
        if (next !== null) {
          node.text = next;
          changed = true;
        }
      }
    }
    return changed ? serializeCanvas(data) : null;
  }

  rewrite(text: string, source: string): string | null {
    return /\.canvas$/i.test(source)
      ? this.rewriteCanvas(text, source)
      : this.rewriteNote(text, source);
  }

  /** Replacement for one link as written, or `null` if no form works. */
  private rewriteLink(
    raw: string,
    target: string,
    source: string,
  ): string | null {
    const wiki = /^(!?)\[\[([^\]\n]+?)\]\]$/.exec(raw);
    if (wiki) {
      const inner = wiki[2];
      const pipe = inner.indexOf("|");
      const written = pipe < 0 ? inner : inner.slice(0, pipe);
      const name = this.newName(target, source, false);
      if (name === null) return null;
      const subpath = written.slice(subpathStart(written)).trimEnd();
      return `${wiki[1]}[[${name}${subpath}${pipe < 0 ? "" : inner.slice(pipe)}]]`;
    }
    const markdown = /^(!?\[[^\]\n]*\]\()([^)\s]+)(.*)$/.exec(raw);
    if (markdown) {
      const url = markdown[2];
      const hash = url.indexOf("#");
      const rawPath = hash < 0 ? url : url.slice(0, hash);
      const name = this.newName(target, source, true);
      if (name === null) return null;
      let decoded = rawPath;
      try {
        decoded = decodeURIComponent(rawPath);
      } catch {
        // Keep literal, as scanNote does.
      }
      // Markdown link destinations cannot hold spaces or parentheses as is.
      const encode = decoded !== rawPath || /[\s()<>]/.test(name);
      const path = encode
        ? encodeURI(name).replace(/\(/g, "%28").replace(/\)/g, "%29")
        : name;
      return `${markdown[1]}${path}${hash < 0 ? "" : url.slice(hash)}${markdown[3]}`;
    }
    return null;
  }

  /**
   * The shortest name for the link's new target that resolves to it from the
   * note's new place: the bare name when the link had no folder, otherwise
   * (or when the bare name is ambiguous) the full vault path.
   */
  private newName(
    target: string,
    source: string,
    markdown: boolean,
  ): string | null {
    const old = this.before.resolve(target, source);
    if (!old) return null;
    const destination = this.moved(old);
    const written = linkName(target);
    const note = /\.md$/i.test(destination);
    // Notes keep the extension only if the link wrote it (Markdown links usually do).
    const keepExtension =
      !note || /\.md$/i.test(written) || (markdown && /\.[^/]+$/.test(written));
    const strip = (path: string) =>
      keepExtension ? path : path.replace(/\.md$/i, "");
    const base = destination.slice(destination.lastIndexOf("/") + 1);
    const candidates = written.includes("/")
      ? [strip(destination)]
      : [strip(base), strip(destination)];
    const from = this.moved(source);
    return (
      candidates.find(
        (name) => this.after.resolve(name, from) === destination,
      ) ?? null
    );
  }
}

/** Index of the `#heading` or `^block` part of a written link target. */
function subpathStart(written: string): number {
  const match = /[#^]/.exec(written);
  return match ? match.index : written.length;
}
