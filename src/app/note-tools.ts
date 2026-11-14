import { isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";
import { formatDate } from "../dates";
import { frontmatterRange } from "../editor/properties-model";
import { LinkResolver } from "./vault-index";

/**
 * Logic behind the small core plugins: random note, unique (Zettelkasten)
 * notes and the note composer (merge notes, extract a selection). The App
 * wires these into commands; everything here is pure and tested on its own.
 */

/** A random Markdown note other than `current`, or null when there is none. */
export function pickRandomNote(
  files: readonly string[],
  current: string | null,
  random: () => number = Math.random,
): string | null {
  const notes = files.filter((path) => /\.md$/i.test(path) && path !== current);
  if (!notes.length) return null;
  return notes[Math.min(notes.length - 1, Math.floor(random() * notes.length))];
}

/**
 * Path for a new unique note named after `date` in `format`. A taken name
 * moves on minute by minute, like a Zettelkasten ID; formats without minutes
 * fall back to a counter.
 */
export function uniqueNotePath(
  folder: string,
  format: string,
  date: Date,
  exists: (path: string) => boolean,
  locale = "en",
): string {
  const prefix = folder.replace(/^\/+|\/+$/g, "");
  const path = (name: string) =>
    `${prefix ? `${prefix}/` : ""}${name.replace(/[\\/:*?"<>|]/g, "-").trim()}.md`;
  const pattern = format.trim() || "YYYYMMDDHHmm";
  const first = formatDate(date, pattern, locale);
  for (let minute = 0; minute < 60; minute++) {
    const name = formatDate(
      new Date(date.getTime() + minute * 60_000),
      pattern,
      locale,
    );
    if (minute > 0 && name === first) break;
    if (!exists(path(name))) return path(name);
  }
  for (let n = 1; ; n++) {
    const candidate = path(`${first} ${n}`);
    if (!exists(candidate)) return candidate;
  }
}

/** Splits a note into its frontmatter YAML (null without one) and its body. */
function splitNote(text: string): { yaml: string | null; body: string } {
  const range = frontmatterRange(text);
  if (!range) return { yaml: null, body: text };
  return {
    yaml: text.slice(range.yamlFrom, range.yamlTo),
    body: text.slice(range.to).replace(/^\r?\n/, ""),
  };
}

function keyOf(node: unknown): string {
  return isScalar(node) ? String(node.value) : String(node);
}

/**
 * Merges the properties of `source` into `target`: missing keys are added,
 * lists (tags, aliases …) get the source's new items, and on any other
 * conflict the target's value stays. Null when either YAML does not parse
 * as a mapping.
 */
function mergeYaml(target: string, source: string): string | null {
  const into = parseDocument(target);
  const from = parseDocument(source);
  if (into.errors.length || from.errors.length) return null;
  if (into.contents !== null && !isMap(into.contents)) return null;
  if (from.contents === null) return target;
  if (!isMap(from.contents)) return null;
  if (into.contents === null) (into as Document).contents = into.createNode({});
  for (const pair of from.contents.items) {
    const key = keyOf(pair.key);
    const value = (pair.value as { toJSON?: () => unknown } | null)?.toJSON
      ? (pair.value as { toJSON(): unknown }).toJSON()
      : pair.value;
    const existing = into.get(key, true);
    if (existing === undefined) {
      into.set(key, into.createNode(value));
      continue;
    }
    const additions = Array.isArray(value)
      ? value
      : typeof value === "string" && isListKey(key)
        ? [value]
        : null;
    if (!additions) continue;
    if (isSeq(existing)) {
      const have = new Set(existing.items.map((item) => keyOf(item)));
      for (const item of additions)
        if (!have.has(String(item))) {
          existing.items.push(into.createNode(item));
          have.add(String(item));
          // A growing list is written as a block list, like the properties editor does.
          existing.flow = false;
        }
    } else if (
      isScalar(existing) &&
      (existing.value === null || existing.value === "")
    ) {
      into.set(key, into.createNode(additions));
    } else if (isScalar(existing) && isListKey(key)) {
      const items = [existing.value, ...additions].filter(
        (item, index, all) => all.findIndex((x) => String(x) === String(item)) === index,
      );
      into.set(key, into.createNode(items));
    }
  }
  return toYaml(into);
}

function isListKey(key: string): boolean {
  return ["tags", "aliases", "cssclasses"].includes(key.toLowerCase());
}

function toYaml(doc: Document): string {
  return doc.toString({ lineWidth: 0, nullStr: "" }).replace(/\n$/, "");
}

/**
 * The target note with the source appended. Properties are merged into the
 * target's frontmatter; source YAML that cannot be merged is kept as a code
 * block instead of being dropped.
 */
export function mergeNoteText(target: string, source: string): string {
  const into = splitNote(target);
  const from = splitNote(source);
  let yaml = into.yaml;
  let extra = "";
  if (from.yaml !== null && from.yaml.trim()) {
    const merged = mergeYaml(into.yaml ?? "", from.yaml);
    if (merged === null) extra = "```yaml\n" + from.yaml.replace(/\n?$/, "\n") + "```\n\n";
    else yaml = merged;
  }
  const head = yaml === null ? "" : yaml ? `---\n${yaml}\n---\n` : "---\n---\n";
  const body = into.body.replace(/\s+$/, "");
  const appended = (extra + from.body).replace(/\s+$/, "");
  const joined = body && appended ? `${body}\n\n${appended}` : body || appended;
  return `${head}${joined}\n`;
}

/** A file name proposed for a selection: its first heading or line. */
export function suggestNoteName(selection: string): string {
  const line =
    selection
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry && entry !== "---") ?? "";
  const name = line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/, "")
    .replace(/^>\s*/, "")
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/[*_`=~]/g, "")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name.length > 60 ? name.slice(0, 60).trimEnd() : name;
}

/**
 * Wiki link from `source` to `target` (both vault paths): the bare name when
 * it resolves unambiguously, otherwise the full path without `.md`.
 */
export function wikiLinkTo(
  files: readonly string[],
  target: string,
  source: string,
): string {
  const resolver = new LinkResolver(files.includes(target) ? files : [...files, target]);
  const full = target.replace(/\.md$/i, "");
  const name = full.slice(full.lastIndexOf("/") + 1);
  return `[[${resolver.resolve(name, source) === target ? name : full}]]`;
}
