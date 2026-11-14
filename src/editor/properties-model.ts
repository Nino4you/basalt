import { Document, isMap, isScalar, isSeq, parseDocument } from "yaml";

/** Where the leading `---` block sits in a note. */
export interface FrontmatterRange {
  /** Start of the opening `---` (always 0). */
  from: number;
  /** End of the closing `---` line, before its line break. */
  to: number;
  /** The YAML between the fences. */
  yamlFrom: number;
  yamlTo: number;
}

/** Same shape the Markdown parser and the reading view accept. */
export function frontmatterRange(text: string): FrontmatterRange | null {
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return null;
  const close = /(^|\r?\n)(---|\.\.\.)[ \t]*(?=\r?\n|$)/m;
  const rest = text.slice(open[0].length);
  const match = close.exec(rest);
  if (!match) return null;
  const yamlFrom = open[0].length;
  const yamlTo = yamlFrom + match.index;
  return {
    from: 0,
    to: yamlFrom + match.index + match[0].length,
    yamlFrom,
    yamlTo,
  };
}

export type PropertyType =
  | "text"
  | "list"
  | "number"
  | "checkbox"
  | "date"
  | "datetime"
  /** Nested maps and other YAML the editor cannot show as a field. */
  | "complex";

export interface PropertyEntry {
  key: string;
  type: PropertyType;
  /** Strings for text/date/number, string[] for lists, boolean for checkboxes. */
  value: string | string[] | boolean;
}

/** Keys Obsidian always treats as lists. */
const LIST_KEYS = new Set(["tags", "aliases", "cssclasses"]);

function typeOf(key: string, value: unknown): PropertyType {
  if (LIST_KEYS.has(key.toLowerCase())) {
    if (Array.isArray(value) || value === null || typeof value === "string")
      return "list";
  }
  if (Array.isArray(value))
    return value.every(
      (item) =>
        item === null || ["string", "number", "boolean"].includes(typeof item),
    )
      ? "list"
      : "complex";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (value === null || value === undefined) return "text";
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value))
      return "datetime";
    return "text";
  }
  return "complex";
}

export class Properties {
  private constructor(private readonly doc: Document) {}

  /** Null when the YAML has errors or is not a mapping (it stays source). */
  static parse(yaml: string): Properties | null {
    const doc = parseDocument(yaml);
    if (doc.errors.length) return null;
    if (doc.contents !== null && !isMap(doc.contents)) return null;
    return new Properties(doc);
  }

  entries(): PropertyEntry[] {
    const contents = this.doc.contents;
    if (!isMap(contents)) return [];
    return contents.items.map((pair) => {
      const key = isScalar(pair.key)
        ? String(pair.key.value)
        : String(pair.key);
      const raw: unknown =
        pair.value &&
        typeof (pair.value as { toJSON?: unknown }).toJSON === "function"
          ? (pair.value as { toJSON(): unknown }).toJSON()
          : pair.value;
      const type = typeOf(key, raw);
      let value: PropertyEntry["value"];
      if (type === "list")
        value = (
          Array.isArray(raw) ? raw : raw === null || raw === "" ? [] : [raw]
        )
          .filter((item) => item !== null)
          .map(String);
      else if (type === "checkbox") value = raw === true;
      else if (type === "complex")
        value = new Document(pair.value).toString({ lineWidth: 0 });
      else value = raw === null || raw === undefined ? "" : String(raw);
      return { key, type, value };
    });
  }

  has(key: string): boolean {
    return this.entries().some((entry) => entry.key === key);
  }

  /** Sets a value, keeping the property's position, comments and list style. */
  set(key: string, value: PropertyEntry["value"], type: PropertyType): void {
    let next: unknown = value;
    if (type === "number") {
      const number = Number(value);
      next = value === "" ? null : Number.isFinite(number) ? number : value;
    } else if (type === "list") {
      next = (value as string[]).map((item) => item.trim()).filter(Boolean);
    } else if (typeof value === "string" && value === "") next = null;
    const previous = this.doc.get(key, true);
    // A scalar keeps its node, and with it the comment after the value.
    if (isScalar(previous) && (next === null || typeof next !== "object")) {
      previous.value = next;
      return;
    }
    const node = this.doc.createNode(next);
    if (isSeq(previous) && isSeq(node)) {
      // `[]` is always written flow-style; a list that grows from it should
      // look like Obsidian's block list.
      node.flow = previous.flow && previous.items.length > 0;
      node.comment = previous.comment;
    }
    if (!isMap(this.doc.contents)) this.doc.contents = this.doc.createNode({});
    this.doc.set(key, node);
  }

  /** Renames a property in place; false when the new name is empty or taken. */
  rename(from: string, to: string): boolean {
    const name = to.trim();
    const contents = this.doc.contents;
    if (!name || !isMap(contents)) return false;
    if (name === from) return true;
    if (this.has(name)) return false;
    const pair = contents.items.find(
      (item) =>
        (isScalar(item.key) ? String(item.key.value) : String(item.key)) ===
        from,
    );
    if (!pair) return false;
    pair.key = this.doc.createNode(name);
    return true;
  }

  remove(key: string): void {
    this.doc.delete(key);
  }

  /** Adds an empty property at the end; false when the name is empty or taken. */
  add(key: string): boolean {
    const name = key.trim();
    if (!name || this.has(name)) return false;
    if (!isMap(this.doc.contents)) this.doc.contents = this.doc.createNode({});
    this.doc.set(
      name,
      this.doc.createNode(LIST_KEYS.has(name.toLowerCase()) ? [] : null),
    );
    return true;
  }

  get empty(): boolean {
    return this.entries().length === 0;
  }

  /** The YAML without a trailing line break, ready to go between the fences. */
  toString(): string {
    if (this.empty) return "";
    // Empty values are written as `key:` like Obsidian does, not `key: null`.
    return this.doc.toString({ lineWidth: 0, nullStr: "" }).replace(/\n$/, "");
  }
}

/**
 * The note text after replacing its frontmatter YAML: the block goes when no
 * property is left, and a note without frontmatter gets one.
 */
export function replaceFrontmatter(
  text: string,
  yaml: string,
): { from: number; to: number; insert: string } {
  const range = frontmatterRange(text);
  if (!range) {
    return yaml
      ? { from: 0, to: 0, insert: `---\n${yaml}\n---\n` }
      : { from: 0, to: 0, insert: "" };
  }
  if (!yaml) {
    const after = /^\r?\n/.exec(text.slice(range.to))?.[0].length ?? 0;
    return { from: 0, to: range.to + after, insert: "" };
  }
  // An empty block (`---` right after `---`) needs a line break of its own.
  const insert = range.yamlFrom === range.yamlTo ? `${yaml}\n` : yaml;
  return { from: range.yamlFrom, to: range.yamlTo, insert };
}
