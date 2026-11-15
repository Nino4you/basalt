import {
  compareValues,
  evaluate,
  ExpressionError,
  FileValue,
  isTruthy,
  parseExpression,
  type EvalContext,
  type EvalHost,
  type FileRecord,
  type Node,
  type Value,
} from "./expr";
import type { BaseConfig, Filter, SortSpec, ViewConfig } from "./model";

/** One result: the file and a getter for any property id. */
export interface Row {
  file: FileRecord;
  value(property: string): Value;
}

export interface Group {
  /** Null for the files without a value (and for an ungrouped view). */
  key: Value;
  rows: Row[];
}

export interface ViewResult {
  columns: string[];
  groups: Group[];
  /** Matches before the view's limit. */
  total: number;
  /** Formula or filter errors met while evaluating (each reported once). */
  errors: string[];
}

class Evaluator {
  private readonly cache = new Map<string, Value>();
  private readonly evaluating = new Set<string>();
  readonly ctx: EvalContext;

  constructor(
    private readonly config: BaseConfig,
    host: EvalHost,
    file: FileRecord,
    self: FileRecord | null,
    private readonly errors: Set<string>,
  ) {
    this.ctx = { host, file, self, formula: (name) => this.formula(name) };
  }

  formula(name: string): Value {
    if (this.cache.has(name)) return this.cache.get(name)!;
    const formula = this.config.formulas.get(name);
    if (!formula?.node || this.evaluating.has(name)) {
      if (this.evaluating.has(name)) this.errors.add(`formula.${name}: Zirkelbezug`);
      return null;
    }
    this.evaluating.add(name);
    const value = this.run(formula.node, `formula.${name}`);
    this.evaluating.delete(name);
    this.cache.set(name, value);
    return value;
  }

  run(node: Node, label: string): Value {
    try {
      return evaluate(node, this.ctx);
    } catch (error) {
      this.errors.add(
        `${label}: ${error instanceof ExpressionError ? error.message : String(error)}`,
      );
      return null;
    }
  }

  matches(filter: Filter | null): boolean {
    if (!filter) return true;
    switch (filter.kind) {
      case "expr":
        return isTruthy(this.run(filter.node, filter.source));
      case "and":
        return filter.items.every((item) => this.matches(item));
      case "or":
        return filter.items.some((item) => this.matches(item));
      case "not":
        return !filter.items.some((item) => this.matches(item));
    }
  }

  value(property: string): Value {
    const dot = property.indexOf(".");
    const scope = property.slice(0, dot);
    const name = property.slice(dot + 1);
    if (scope === "formula") return this.formula(name);
    const source =
      scope === "file"
        ? `file.${name}`
        : scope === "this"
          ? `this.${name}`
          : `note[${JSON.stringify(name)}]`;
    const node = parseCached(source);
    return node ? this.run(node, property) : null;
  }
}

const parsed = new Map<string, Node | null>();

function parseCached(source: string): Node | null {
  if (!parsed.has(source)) {
    try {
      parsed.set(source, parseExpression(source));
    } catch {
      parsed.set(source, null);
    }
  }
  return parsed.get(source)!;
}

function compareRows(a: Row, b: Row, sort: SortSpec[], locale: string): number {
  for (const { property, direction } of sort) {
    const x = a.value(property);
    const y = b.value(property);
    // Empty values go last in either direction.
    if (x === null || y === null) {
      if (x === y) continue;
      return x === null ? 1 : -1;
    }
    const order = compareValues(x, y, locale) ?? 0;
    if (order) return direction === "DESC" ? -order : order;
  }
  return a.file.path.localeCompare(b.file.path, locale, { numeric: true });
}

/** Default columns: the file name and every note property the results use. */
function defaultColumns(rows: Row[]): string[] {
  const seen = new Set<string>();
  for (const row of rows.slice(0, 200))
    for (const key of Object.keys(row.file.properties)) seen.add(`note.${key}`);
  return ["file.name", ...[...seen].slice(0, 8)];
}

/**
 * Runs one view over `files`: global and view filters, sort, groups, limit.
 * `self` is what `this` refers to (the base file or the embedding note).
 */
export function runView(
  config: BaseConfig,
  view: ViewConfig,
  files: readonly FileRecord[],
  host: EvalHost,
  self: FileRecord | null,
): ViewResult {
  const errors = new Set<string>();
  const rows: Row[] = [];
  for (const file of files) {
    const evaluator = new Evaluator(config, host, file, self, errors);
    if (!evaluator.matches(config.filters) || !evaluator.matches(view.filters)) continue;
    const values = new Map<string, Value>();
    rows.push({
      file,
      value(property) {
        if (!values.has(property)) values.set(property, evaluator.value(property));
        return values.get(property)!;
      },
    });
  }
  const sort = view.sort.length ? view.sort : [{ property: "file.name", direction: "ASC" as const }];
  rows.sort((a, b) => compareRows(a, b, sort, host.locale));
  const total = rows.length;
  const limited = view.limit ? rows.slice(0, view.limit) : rows;
  let groups: Group[];
  if (view.groupBy) {
    const { property, direction } = view.groupBy;
    const byKey: Group[] = [];
    for (const row of limited) {
      const key = row.value(property);
      const keyText = groupKey(key);
      let group = byKey.find((entry) => groupKey(entry.key) === keyText);
      if (!group) byKey.push((group = { key, rows: [] }));
      group.rows.push(row);
    }
    byKey.sort((a, b) => {
      if (a.key === null || b.key === null) return a.key === b.key ? 0 : a.key === null ? 1 : -1;
      const order = compareValues(a.key, b.key, host.locale) ?? 0;
      return direction === "DESC" ? -order : order;
    });
    groups = byKey;
  } else groups = [{ key: null, rows: limited }];
  const columns = view.order.length ? view.order : defaultColumns(limited);
  // Evaluate what the view shows now, so its errors are known up front.
  for (const row of limited) for (const column of columns) row.value(column);
  return {
    columns,
    groups,
    total,
    errors: [...errors],
  };
}

function groupKey(value: Value): string {
  if (value === null) return "\0null";
  if (value instanceof FileValue) return `file:${value.path}`;
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (Array.isArray(value)) return `list:${value.map(groupKey).join("\u0001")}`;
  return `${typeof value}:${typeof value === "object" ? JSON.stringify(value) : String(value)}`;
}
