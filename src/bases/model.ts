import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { ExpressionError, parseExpression, type Node } from "./expr";

/**
 * `.base` files: YAML with global filters, formulas, property settings and a
 * list of views (see the public Bases syntax documentation). Parsing keeps
 * the YAML document, so edits made from the view (sorting) touch only the
 * keys they change and leave comments and unknown keys alone.
 */

export type Filter =
  | { kind: "expr"; source: string; node: Node }
  | { kind: "and" | "or" | "not"; items: Filter[] };

export interface SortSpec {
  property: string;
  direction: "ASC" | "DESC";
}

export interface ViewConfig {
  type: string;
  name: string;
  filters: Filter | null;
  /** Property ids in column order (`file.name`, `note.status`, `formula.x`). */
  order: string[];
  sort: SortSpec[];
  groupBy: SortSpec | null;
  limit: number | null;
  /** Cards: property whose value is the cover image or colour. */
  image: string | null;
}

export interface BaseConfig {
  filters: Filter | null;
  formulas: Map<string, { source: string; node: Node | null; error: string | null }>;
  /** Display names by property id. */
  displayNames: Map<string, string>;
  views: ViewConfig[];
  /** Problems found while reading; the view still renders what it can. */
  errors: string[];
}

/** `status` and `note.status` are the same column; `file.*` and `formula.*` stay. */
export function normalizeProperty(id: string): string {
  const trimmed = id.trim();
  if (/^(file|formula|note|this)\./.test(trimmed)) return trimmed;
  return `note.${trimmed}`;
}

function parseFilter(raw: unknown, errors: string[]): Filter | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    const source = String(raw);
    try {
      return { kind: "expr", source, node: parseExpression(source) };
    } catch (error) {
      errors.push(`${source}: ${(error as Error).message}`);
      return null;
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const entries = Object.entries(raw as Record<string, unknown>);
    const [key, value] = entries[0] ?? [];
    if (entries.length === 1 && (key === "and" || key === "or" || key === "not")) {
      const list = Array.isArray(value) ? value : [value];
      return {
        kind: key,
        items: list
          .map((item) => parseFilter(item, errors))
          .filter((item): item is Filter => item !== null),
      };
    }
  }
  errors.push(`Unbekannter Filter: ${JSON.stringify(raw)}`);
  return null;
}

function parseSort(raw: unknown): SortSpec | null {
  if (typeof raw === "string") return { property: normalizeProperty(raw), direction: "ASC" };
  if (raw && typeof raw === "object") {
    const entry = raw as { property?: unknown; direction?: unknown };
    if (typeof entry.property !== "string") return null;
    return {
      property: normalizeProperty(entry.property),
      direction: String(entry.direction ?? "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC",
    };
  }
  return null;
}

export function parseBase(text: string): BaseConfig {
  const errors: string[] = [];
  const config: BaseConfig = {
    filters: null,
    formulas: new Map(),
    displayNames: new Map(),
    views: [],
    errors,
  };
  const doc = parseDocument(text);
  if (doc.errors.length) {
    errors.push(...doc.errors.map((error) => error.message));
    return config;
  }
  const data: unknown = doc.toJS();
  if (data === null || data === undefined) return config;
  if (typeof data !== "object" || Array.isArray(data)) {
    errors.push("Eine Base muss ein YAML-Objekt sein.");
    return config;
  }
  const root = data as Record<string, unknown>;
  config.filters = parseFilter(root.filters, errors);
  if (root.formulas && typeof root.formulas === "object")
    for (const [name, raw] of Object.entries(root.formulas as Record<string, unknown>)) {
      const source = String(raw ?? "");
      try {
        config.formulas.set(name, { source, node: parseExpression(source), error: null });
      } catch (error) {
        const message = error instanceof ExpressionError ? error.message : String(error);
        config.formulas.set(name, { source, node: null, error: message });
        errors.push(`formula.${name}: ${message}`);
      }
    }
  if (root.properties && typeof root.properties === "object")
    for (const [id, raw] of Object.entries(root.properties as Record<string, unknown>)) {
      const name = (raw as { displayName?: unknown } | null)?.displayName;
      if (typeof name === "string" && name.trim())
        config.displayNames.set(normalizeProperty(id), name);
    }
  const views = Array.isArray(root.views) ? root.views : [];
  views.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const view = raw as Record<string, unknown>;
    const sort = Array.isArray(view.sort) ? view.sort : view.sort ? [view.sort] : [];
    const limit = Number(view.limit);
    config.views.push({
      type: typeof view.type === "string" ? view.type : "table",
      name: typeof view.name === "string" && view.name.trim() ? view.name : `View ${index + 1}`,
      filters: parseFilter(view.filters, errors),
      order: Array.isArray(view.order)
        ? view.order.filter((id): id is string => typeof id === "string").map(normalizeProperty)
        : [],
      sort: sort.map(parseSort).filter((entry): entry is SortSpec => entry !== null),
      groupBy: parseSort(view.groupBy),
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null,
      image: typeof view.image === "string" ? normalizeProperty(view.image) : null,
    });
  });
  return config;
}

/** The written form of a property id: `note.` is dropped like Obsidian does. */
function writtenProperty(id: string): string {
  return id.startsWith("note.") ? id.slice(5) : id;
}

function writtenKey(id: string): string {
  const name = writtenProperty(id);
  return /^[\p{L}\p{N}_.-]+$/u.test(name) ? name : JSON.stringify(name);
}

/**
 * The base text with the sort of view `index` replaced. Only the `sort`
 * lines change; the rest of the file stays byte for byte as it was. Null
 * when the YAML cannot be edited safely.
 */
export function setViewSort(text: string, index: number, sort: SortSpec[]): string | null {
  const doc = parseDocument(text);
  if (doc.errors.length) return null;
  const views = doc.get("views", true);
  if (!isSeq(views) || !isMap(views.items[index])) return null;
  const view = views.items[index];
  if (view.flow || !view.items.length) return null;
  const first = view.items[0].key as { range?: [number, number, number] } | null;
  const firstStart = first?.range?.[0];
  if (firstStart === undefined) return null;
  const indent = " ".repeat(firstStart - (text.lastIndexOf("\n", firstStart - 1) + 1));
  const block = sort.length
    ? `sort:\n${sort
        .map(
          (entry) =>
            `${indent}  - property: ${writtenKey(entry.property)}\n${indent}    direction: ${entry.direction}`,
        )
        .join("\n")}`
    : "";
  const pair = view.items.find((item) => isScalar(item.key) && item.key.value === "sort");
  if (pair) {
    const start = (pair.key as { range?: [number, number, number] }).range?.[0];
    let end = (pair.value as { range?: [number, number, number] } | null)?.range?.[1];
    if (start === undefined || end === undefined) return null;
    // Block collections end after their line break; keep it.
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (block) return text.slice(0, start) + block + text.slice(end);
    // Remove the whole lines, including the line break after them.
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = text.indexOf("\n", end);
    return text.slice(0, lineStart) + text.slice(lineEnd < 0 ? text.length : lineEnd + 1);
  }
  if (!block) return text;
  const last = view.items[view.items.length - 1];
  let end =
    (last.value as { range?: [number, number, number] } | null)?.range?.[1] ??
    (last.key as { range?: [number, number, number] }).range?.[1];
  if (end === undefined) return null;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  // Continue after the rest of that line (a trailing comment, for example).
  const lineEnd = text.indexOf("\n", end);
  const at = lineEnd < 0 ? text.length : lineEnd;
  return `${text.slice(0, at)}\n${indent}${block}${text.slice(at)}`;
}

/** A new base with one table view of all notes. */
export function emptyBase(viewName: string): string {
  return `views:\n  - type: table\n    name: ${JSON.stringify(viewName)}\n    order:\n      - file.name\n`;
}
