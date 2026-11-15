import { documentOutline, splitFrontmatter } from "./markdown";

/**
 * Splits an embed or link target into the file part and its subpath:
 * `Note#Heading` → `{ name: "Note", subpath: "Heading" }`.
 */
export function splitTarget(target: string): { name: string; subpath: string } {
  const hash = target.indexOf("#");
  return hash < 0
    ? { name: target, subpath: "" }
    : { name: target.slice(0, hash), subpath: target.slice(hash + 1) };
}

/**
 * Link subpaths drop characters a heading may contain but a link cannot
 * (`#`, `^`, `|`, `:`, brackets); compare both sides without them.
 */
function headingKey(text: string): string {
  return text
    .replace(/[#^|:[\]\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const BLOCK_ID = /^[A-Za-z0-9-]+$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])(?:\s|$)/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;

/**
 * The part of a note that a subpath names, like Obsidian's embeds:
 * `Heading` (or nested `Heading#Sub`) is that heading with everything up to
 * the next heading of the same or a higher level; `^id` is the paragraph,
 * list item (with its children) or preceding block that carries the id.
 * Returns null when the note has no such heading or block.
 */
export function extractSubpath(text: string, subpath: string): string | null {
  const wanted = subpath.trim();
  if (!wanted) return text;
  if (wanted.startsWith("^")) return extractBlock(text, wanted.slice(1));
  return extractSection(text, wanted);
}

function extractSection(text: string, subpath: string): string | null {
  const outline = documentOutline(text);
  const parts = subpath
    .split("#")
    .map(headingKey)
    .filter((part) => part);
  if (!parts.length) return null;
  let start = -1;
  let end = text.length;
  let level = 0;
  // Each further part must be a deeper heading inside the previous section.
  let from = 0;
  for (const part of parts) {
    const index = outline.findIndex(
      (entry, i) =>
        i >= from &&
        entry.offset < end &&
        entry.depth > level &&
        headingKey(entry.text) === part,
    );
    if (index < 0) return null;
    const entry = outline[index];
    start = entry.offset;
    level = entry.depth;
    const next = outline.find(
      (other, i) => i > index && other.depth <= entry.depth,
    );
    if (next && next.offset < end) end = next.offset;
    from = index + 1;
  }
  return text.slice(start, end).replace(/\s+$/, "");
}

function extractBlock(text: string, id: string): string | null {
  if (!BLOCK_ID.test(id)) return null;
  const { body } = splitFrontmatter(text);
  const lines = body.split("\n").map((line) => line.replace(/\r$/, ""));
  const marker = new RegExp(`(^|\\s)\\^${id}\\s*$`);
  let fence: string | null = null;
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (
        delimiter[1][0] === fence[0] &&
        delimiter[1].length >= fence.length
      )
        fence = null;
      continue;
    }
    if (!fence && marker.test(lines[i])) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const strip = (line: string) => line.replace(marker, "").replace(/\s+$/, "");
  const blank = (i: number) => !lines[i]?.trim();

  // An id on its own line names the block right above it (tables, quotes, lists).
  if (lines[at].trim() === `^${id}`) {
    let last = at - 1;
    if (last >= 0 && blank(last)) last--;
    if (last < 0 || blank(last)) return null;
    let first = last;
    while (first > 0 && !blank(first - 1)) first--;
    return lines.slice(first, last + 1).join("\n");
  }

  const item = LIST_ITEM.exec(lines[at]);
  if (item) {
    const indent = item[1].length;
    const block = [strip(lines[at])];
    for (let i = at + 1; i < lines.length; i++) {
      if (blank(i)) break;
      const lead = /^\s*/.exec(lines[i])![0].length;
      if (lead <= indent) break;
      block.push(lines[i]);
    }
    return block.map((line) => line.slice(indent)).join("\n");
  }

  if (HEADING.test(lines[at])) return strip(lines[at]);
  let first = at;
  while (first > 0 && !blank(first - 1) && !HEADING.test(lines[first - 1]))
    first--;
  return [...lines.slice(first, at), strip(lines[at])].join("\n");
}

/**
 * Image size from an embed alias: `300` sets the width, `300x200` both.
 * Other text before it (`Alt|300`) stays the alt text.
 */
export function parseImageSize(label: string): {
  alt: string;
  width?: number;
  height?: number;
} {
  const parts = label.split("|");
  const size = /^\s*(\d+)(?:\s*x\s*(\d+))?\s*$/.exec(parts[parts.length - 1]);
  if (!size) return { alt: label.trim() };
  parts.pop();
  return {
    alt: parts.join("|").trim(),
    width: Number(size[1]),
    ...(size[2] ? { height: Number(size[2]) } : {}),
  };
}
