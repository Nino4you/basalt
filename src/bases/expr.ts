/**
 * Expression language of `.base` files (filters and formulas), implemented
 * after the public Bases syntax documentation: JavaScript-like operators,
 * property access, method calls and a set of global functions.
 *
 * Expressions are parsed once into an AST and evaluated against a context
 * that knows the current file. Evaluation never throws for missing data:
 * unknown properties are null, like empty properties in a note. Syntax
 * errors and unknown functions do throw, so the view can show them.
 */

import { formatDate } from "../dates";

// ── values ─────────────────────────────────────────────────────────────────

/** A span of time in milliseconds (`duration("1d")`, date differences). */
export class Duration {
  constructor(readonly ms: number) {}
}

/** A link written in a property (`"[[Note]]"`) or made with `link()`. */
export class LinkValue {
  constructor(
    /** Link target as written, without alias. */
    readonly target: string,
    readonly display: string | null = null,
  ) {}
}

/** A vault file as seen by expressions (`file`, `this`, `link.asFile()`). */
export interface FileRecord {
  path: string;
  /** Frontmatter properties; empty for non-Markdown files. */
  properties: Record<string, unknown>;
  tags: string[];
  /** Raw link targets (body and frontmatter). */
  links: string[];
  embeds: string[];
  size: number | null;
  ctime: Date | null;
  mtime: Date | null;
}

export class FileValue {
  constructor(readonly record: FileRecord) {}
  get path(): string {
    return this.record.path;
  }
}

export type Value =
  | null
  | boolean
  | number
  | string
  | Date
  | Duration
  | LinkValue
  | FileValue
  | RegExp
  | Value[]
  | { [key: string]: Value };

/** What evaluation needs from the vault. */
export interface EvalHost {
  /** Resolves a link target from `source` to a vault path. */
  resolve(target: string, source: string): string | null;
  /** A file record by vault path, or null. */
  file(path: string): FileRecord | null;
  /** Paths of files linking to `path` (for `file.backlinks`). */
  backlinks(path: string): string[];
  now(): Date;
  locale: string;
}

export interface EvalContext {
  host: EvalHost;
  file: FileRecord;
  /** The base file itself, or the note it is embedded in. */
  self: FileRecord | null;
  /** Formula name to evaluator; cycles are cut by `evaluating`. */
  formula(name: string): Value;
  locals?: Record<string, Value>;
}

// ── tokens ─────────────────────────────────────────────────────────────────

type Token =
  | { kind: "num"; value: number; pos: number }
  | { kind: "str"; value: string; pos: number }
  | { kind: "regex"; value: RegExp; pos: number }
  | { kind: "id"; value: string; pos: number }
  | { kind: "op"; value: string; pos: number }
  | { kind: "end"; pos: number };

const OPERATORS = [
  "&&", "||", "==", "!=", "<=", ">=",
  "(", ")", "[", "]", ",", ".", "!", "<", ">", "+", "-", "*", "/", "%",
];

export class ExpressionError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const regexAllowed = () => {
    const last = tokens[tokens.length - 1];
    if (!last) return true;
    if (last.kind === "op") return ![")", "]"].includes(last.value);
    return false;
  };
  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(source.slice(i))!;
      tokens.push({ kind: "num", value: Number(match[0]), pos: i });
      i += match[0].length;
      continue;
    }
    if (char === '"' || char === "'") {
      let value = "";
      let j = i + 1;
      for (; j < source.length && source[j] !== char; j++) {
        if (source[j] === "\\" && j + 1 < source.length) {
          const next = source[++j];
          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
        } else value += source[j];
      }
      if (j >= source.length) throw new ExpressionError(`Unterminated string at ${i}`);
      tokens.push({ kind: "str", value, pos: i });
      i = j + 1;
      continue;
    }
    if (char === "/" && regexAllowed()) {
      const match = /^\/((?:\\.|[^/\\\n])+)\/([a-z]*)/.exec(source.slice(i));
      if (match) {
        let value: RegExp;
        try {
          value = new RegExp(match[1], match[2]);
        } catch (error) {
          throw new ExpressionError(String((error as Error).message));
        }
        tokens.push({ kind: "regex", value, pos: i });
        i += match[0].length;
        continue;
      }
    }
    if (/[\p{L}_$]/u.test(char)) {
      const match = /^[\p{L}\p{N}_$]+/u.exec(source.slice(i))!;
      tokens.push({ kind: "id", value: match[0], pos: i });
      i += match[0].length;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (!op) throw new ExpressionError(`Unexpected “${char}” at ${i}`);
    tokens.push({ kind: "op", value: op, pos: i });
    i += op.length;
  }
  tokens.push({ kind: "end", pos: source.length });
  return tokens;
}

// ── syntax tree ────────────────────────────────────────────────────────────

export type Node =
  | { type: "lit"; value: Value }
  | { type: "list"; items: Node[] }
  | { type: "id"; name: string }
  | { type: "member"; object: Node; name: string }
  | { type: "index"; object: Node; index: Node }
  | { type: "call"; callee: Node; args: Node[] }
  | { type: "unary"; op: string; arg: Node }
  | { type: "binary"; op: string; left: Node; right: Node };

const PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  ">": 4,
  "<=": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

export function parseExpression(source: string): Node {
  const tokens = tokenize(source);
  let at = 0;
  const peek = () => tokens[at];
  const isOp = (value: string) => {
    const token = tokens[at];
    return token.kind === "op" && token.value === value;
  };
  const expect = (value: string) => {
    if (!isOp(value))
      throw new ExpressionError(`Expected “${value}” at ${tokens[at].pos}`);
    at++;
  };

  const primary = (): Node => {
    const token = tokens[at++];
    switch (token.kind) {
      case "num":
      case "str":
      case "regex":
        return { type: "lit", value: token.value };
      case "id":
        if (token.value === "true") return { type: "lit", value: true };
        if (token.value === "false") return { type: "lit", value: false };
        if (token.value === "null") return { type: "lit", value: null };
        return { type: "id", name: token.value };
      case "op":
        if (token.value === "(") {
          const inner = expression(0);
          expect(")");
          return inner;
        }
        if (token.value === "[") {
          const items: Node[] = [];
          while (!isOp("]")) {
            items.push(expression(0));
            if (!isOp("]")) expect(",");
          }
          at++;
          return { type: "list", items };
        }
        if (token.value === "!" || token.value === "-")
          return { type: "unary", op: token.value, arg: postfix(primary()) };
        break;
    }
    throw new ExpressionError(`Unexpected token at ${token.pos}`);
  };

  const postfix = (node: Node): Node => {
    for (;;) {
      if (isOp(".")) {
        at++;
        const name = tokens[at++];
        if (name.kind !== "id")
          throw new ExpressionError(`Expected a name at ${name.pos}`);
        node = { type: "member", object: node, name: name.value };
      } else if (isOp("[")) {
        at++;
        const index = expression(0);
        expect("]");
        node = { type: "index", object: node, index };
      } else if (isOp("(")) {
        at++;
        const args: Node[] = [];
        while (!isOp(")")) {
          args.push(expression(0));
          if (!isOp(")")) expect(",");
        }
        at++;
        node = { type: "call", callee: node, args };
      } else return node;
    }
  };

  const expression = (min: number): Node => {
    let left = postfix(primary());
    for (;;) {
      const token = peek();
      if (token.kind !== "op") break;
      const precedence = PRECEDENCE[token.value];
      if (precedence === undefined || precedence <= min) break;
      at++;
      const right = expression(precedence);
      left = { type: "binary", op: token.value, left, right };
    }
    return left;
  };

  const node = expression(0);
  if (peek().kind !== "end")
    throw new ExpressionError(`Unexpected input at ${peek().pos}`);
  return node;
}

// ── helpers ────────────────────────────────────────────────────────────────

const UNITS: Record<string, number> = {
  y: 365 * 864e5, year: 365 * 864e5, years: 365 * 864e5,
  M: 30 * 864e5, month: 30 * 864e5, months: 30 * 864e5,
  w: 7 * 864e5, week: 7 * 864e5, weeks: 7 * 864e5,
  d: 864e5, day: 864e5, days: 864e5,
  h: 36e5, hour: 36e5, hours: 36e5,
  m: 6e4, minute: 6e4, minutes: 6e4,
  s: 1e3, second: 1e3, seconds: 1e3,
};

interface DurationParts {
  ms: number;
  /** Calendar parts, applied to dates as calendar steps. */
  years: number;
  months: number;
}

/** Parses "1d", "2 weeks", "1M 4h" and "-3 days"; null if it is not one. */
function parseDurationParts(text: string): DurationParts | null {
  const source = text.trim();
  if (!source) return null;
  const sign = source.startsWith("-") ? -1 : 1;
  const body = source.replace(/^[-+]\s*/, "");
  const parts: DurationParts = { ms: 0, years: 0, months: 0 };
  const re = /(\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s*,?\s*/y;
  let index = 0;
  while (index < body.length) {
    re.lastIndex = index;
    const match = re.exec(body);
    if (!match) return null;
    const amount = Number(match[1]) * sign;
    const unit = UNITS[match[2]] !== undefined ? match[2] : match[2].toLowerCase();
    if (unit === "y" || unit === "year" || unit === "years") parts.years += amount;
    else if (unit === "M" || unit === "month" || unit === "months") parts.months += amount;
    else if (UNITS[unit] !== undefined) parts.ms += amount * UNITS[unit];
    else return null;
    index = re.lastIndex;
  }
  return parts;
}

function addParts(date: Date, parts: DurationParts, sign: 1 | -1): Date {
  const next = new Date(date.getTime());
  if (parts.years || parts.months)
    next.setMonth(next.getMonth() + sign * (parts.years * 12 + parts.months));
  next.setTime(next.getTime() + sign * parts.ms);
  return next;
}

/** Parses `YYYY-MM-DD`, `YYYY-MM-DD HH:mm(:ss)` and ISO strings as local time. */
export function parseDateValue(text: string): Date | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/.exec(
      text.trim(),
    );
  if (!match) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
    Number((match[7] ?? "0").slice(0, 3).padEnd(3, "0")),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

const WIKI = /^\[\[([^\]|#^]*)([#^][^\]|]*)?(?:\|([^\]]*))?\]\]$/;

/** Turns raw YAML property values into expression values: links, dates. */
export function fromYaml(value: unknown): Value {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const link = WIKI.exec(value.trim());
    if (link) return new LinkValue(link[1].trim() + (link[2] ?? ""), link[3] ?? null);
    const date = parseDateValue(value);
    if (date && /^\d{4}-\d{2}-\d{2}/.test(value.trim())) return date;
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(fromYaml);
  if (typeof value === "object") {
    const out: Record<string, Value> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = fromYaml(entry);
    return out;
  }
  return String(value);
}

export function isTruthy(value: Value): boolean {
  if (value === null || value === false || value === 0 || value === "") return false;
  if (typeof value === "number") return !Number.isNaN(value);
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function isPlainObject(value: Value): value is { [key: string]: Value } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Duration) &&
    !(value instanceof LinkValue) &&
    !(value instanceof FileValue) &&
    !(value instanceof RegExp)
  );
}

function linkName(target: string): string {
  return target.split("#")[0].split("^")[0].trim();
}

/** The vault path a link, file or path string points at, if any. */
function pathOf(value: Value, ctx: EvalContext): string | null {
  if (value instanceof FileValue) return value.path;
  if (value instanceof LinkValue)
    return ctx.host.resolve(linkName(value.target), ctx.file.path);
  if (typeof value === "string") {
    const link = WIKI.exec(value.trim());
    const target = link ? link[1] : value;
    return ctx.host.resolve(linkName(target), ctx.file.path) ?? (ctx.host.file(target) ? target : null);
  }
  return null;
}

export function toText(value: Value, locale = "en"): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number")
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) {
    const midnight =
      !value.getHours() && !value.getMinutes() && !value.getSeconds();
    return formatDate(value, midnight ? "YYYY-MM-DD" : "YYYY-MM-DD HH:mm", locale);
  }
  if (value instanceof Duration) return formatDuration(value.ms);
  if (value instanceof LinkValue)
    return value.display ?? linkName(value.target).replace(/^.*\//, "").replace(/\.md$/i, "");
  if (value instanceof FileValue)
    return value.path.replace(/^.*\//, "").replace(/\.md$/i, "");
  if (value instanceof RegExp) return String(value);
  if (Array.isArray(value)) return value.map((item) => toText(item, locale)).join(", ");
  return JSON.stringify(value);
}

function formatDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  let rest = Math.abs(ms);
  const parts: string[] = [];
  for (const [unit, size] of [["d", 864e5], ["h", 36e5], ["m", 6e4], ["s", 1e3]] as const) {
    const amount = Math.floor(rest / size);
    if (amount) parts.push(`${amount}${unit}`);
    rest -= amount * size;
  }
  return sign + (parts.slice(0, 2).join(" ") || "0s");
}

/** Equality across types: links equal the files they resolve to. */
function equals(a: Value, b: Value, ctx: EvalContext): boolean {
  if (a === null || b === null) return a === b || (a === null && b === "") || (b === null && a === "");
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Duration && b instanceof Duration) return a.ms === b.ms;
  const linkish = (v: Value) => v instanceof LinkValue || v instanceof FileValue;
  if (linkish(a) || linkish(b)) {
    const left = pathOf(a, ctx);
    const right = pathOf(b, ctx);
    return left !== null && left === right;
  }
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => equals(item, b[i], ctx));
  if (typeof a === "number" && typeof b === "string") return a === Number(b) && b.trim() !== "";
  if (typeof a === "string" && typeof b === "number") return equals(b, a, ctx);
  if (isPlainObject(a) && isPlainObject(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

/** Ordering for comparisons and sorting; null when the values do not compare. */
export function compareValues(a: Value, b: Value, locale = "en"): number | null {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (a instanceof Duration && b instanceof Duration) return a.ms - b.ms;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (a instanceof Date && typeof b === "string") {
    const date = parseDateValue(b);
    return date ? a.getTime() - date.getTime() : null;
  }
  if (typeof a === "string" && b instanceof Date) {
    const date = parseDateValue(a);
    return date ? date.getTime() - b.getTime() : null;
  }
  if (typeof a === "number" && typeof b === "string" && b.trim() && !Number.isNaN(Number(b)))
    return a - Number(b);
  if (typeof a === "string" && typeof b === "number" && a.trim() && !Number.isNaN(Number(a)))
    return Number(a) - b;
  if (a === null || b === null) return null;
  return toText(a, locale).localeCompare(toText(b, locale), locale, {
    numeric: true,
    sensitivity: "base",
  });
}

function asNumber(value: Value): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" && value.trim()) return Number(value);
  if (value instanceof Date) return value.getTime();
  if (value instanceof Duration) return value.ms;
  return Number.NaN;
}

function asDuration(value: Value): DurationParts | null {
  if (value instanceof Duration) return { ms: value.ms, years: 0, months: 0 };
  if (typeof value === "string") return parseDurationParts(value);
  return null;
}

function asDate(value: Value): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string") return parseDateValue(value);
  if (typeof value === "number") return new Date(value);
  return null;
}

function binary(op: string, a: Value, b: Value, ctx: EvalContext): Value {
  switch (op) {
    case "==":
      return equals(a, b, ctx);
    case "!=":
      return !equals(a, b, ctx);
    case "<":
    case ">":
    case "<=":
    case ">=": {
      const order = compareValues(a, b, ctx.host.locale);
      if (order === null || Number.isNaN(order)) return false;
      return op === "<" ? order < 0 : op === ">" ? order > 0 : op === "<=" ? order <= 0 : order >= 0;
    }
    case "+":
    case "-": {
      const sign = op === "+" ? 1 : -1;
      if (a instanceof Date) {
        if (op === "-" && (b instanceof Date || (typeof b === "string" && parseDateValue(b))))
          return new Duration(a.getTime() - asDate(b)!.getTime());
        const parts = asDuration(b);
        if (parts) return addParts(a, parts, sign);
        if (typeof b === "number") return new Date(a.getTime() + sign * b);
        return null;
      }
      if (a instanceof Duration) {
        const parts = asDuration(b);
        if (parts && !parts.years && !parts.months) return new Duration(a.ms + sign * parts.ms);
        if (b instanceof Date && op === "+") return new Date(b.getTime() + a.ms);
        return null;
      }
      if (op === "+") {
        if (Array.isArray(a)) return [...a, ...(Array.isArray(b) ? b : [b])];
        if (typeof a === "string" || typeof b === "string")
          return toText(a, ctx.host.locale) + toText(b, ctx.host.locale);
      }
      if (a === null || b === null) return null;
      return asNumber(a) + sign * asNumber(b);
    }
    case "*":
    case "/":
    case "%": {
      if (a instanceof Duration && typeof b === "number")
        return new Duration(op === "*" ? a.ms * b : op === "/" ? a.ms / b : a.ms % b);
      if (a === null || b === null) return null;
      const x = asNumber(a);
      const y = asNumber(b);
      return op === "*" ? x * y : op === "/" ? x / y : x % y;
    }
  }
  throw new ExpressionError(`Unknown operator ${op}`);
}

// ── evaluation ─────────────────────────────────────────────────────────────

function fileValue(path: string | null, ctx: EvalContext): FileValue | null {
  if (!path) return null;
  const record = ctx.host.file(path);
  return record ? new FileValue(record) : null;
}

/** Object view of a note's properties for `note` and `file.properties`. */
function propertiesOf(record: FileRecord): { [key: string]: Value } {
  const out: { [key: string]: Value } = {};
  for (const [key, value] of Object.entries(record.properties)) out[key] = fromYaml(value);
  return out;
}

function property(record: FileRecord, name: string): Value {
  if (Object.prototype.hasOwnProperty.call(record.properties, name))
    return fromYaml(record.properties[name]);
  return null;
}

function fileField(file: FileValue, name: string, ctx: EvalContext): Value | undefined {
  const record = file.record;
  const path = record.path;
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  switch (name) {
    case "name":
      return base;
    case "basename":
      return dot > 0 ? base.slice(0, dot) : base;
    case "path":
      return path;
    case "folder":
      return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    case "ext":
      return dot > 0 ? base.slice(dot + 1) : "";
    case "size":
      return record.size;
    case "ctime":
      return record.ctime;
    case "mtime":
      return record.mtime;
    case "tags":
      return record.tags.map((tag) => `#${tag}`);
    case "links":
      return record.links.map((target) => new LinkValue(target));
    case "embeds":
      return record.embeds.map((target) => new LinkValue(target));
    case "backlinks":
      return ctx.host.backlinks(path).map((source) => new LinkValue(source.replace(/\.md$/i, "")));
    case "properties":
      return propertiesOf(record);
    case "file":
      return file;
  }
  return undefined;
}

/** Field access (`x.length`, `date.year`, `obj.key`). */
function member(object: Value, name: string, ctx: EvalContext): Value {
  if (object instanceof FileValue) {
    const field = fileField(object, name, ctx);
    if (field !== undefined) return field;
    // `this.status`: a property of the base's own or embedding note.
    return property(object.record, name);
  }
  if (typeof object === "string" || Array.isArray(object))
    return name === "length" ? object.length : null;
  if (object instanceof Date) {
    switch (name) {
      case "year":
        return object.getFullYear();
      case "month":
        return object.getMonth() + 1;
      case "day":
        return object.getDate();
      case "hour":
        return object.getHours();
      case "minute":
        return object.getMinutes();
      case "second":
        return object.getSeconds();
      case "millisecond":
        return object.getMilliseconds();
    }
    return null;
  }
  if (object instanceof Duration) {
    const units: Record<string, number> = { days: 864e5, hours: 36e5, minutes: 6e4, seconds: 1e3, milliseconds: 1 };
    return units[name] ? object.ms / units[name] : null;
  }
  if (isPlainObject(object))
    return Object.prototype.hasOwnProperty.call(object, name) ? object[name] : null;
  return null;
}

type Lazy = (locals?: Record<string, Value>) => Value;

function evalNode(node: Node, ctx: EvalContext): Value {
  switch (node.type) {
    case "lit":
      return node.value;
    case "list":
      return node.items.map((item) => evalNode(item, ctx));
    case "id":
      return identifier(node.name, ctx);
    case "member": {
      const root = node.object.type === "id" ? node.object.name : null;
      if (root === "note" && !ctx.locals?.note) return property(ctx.file, node.name);
      if (root === "formula" && !ctx.locals?.formula) return ctx.formula(node.name);
      return member(evalNode(node.object, ctx), node.name, ctx);
    }
    case "index": {
      const object = evalNode(node.object, ctx);
      const index = evalNode(node.index, ctx);
      if (node.object.type === "id" && node.object.name === "note" && typeof index === "string")
        return property(ctx.file, index);
      if (node.object.type === "id" && node.object.name === "formula" && typeof index === "string")
        return ctx.formula(index);
      if ((Array.isArray(object) || typeof object === "string") && typeof index === "number") {
        const at = index < 0 ? object.length + index : index;
        return (Array.isArray(object) ? object[at] : object[at]) ?? null;
      }
      if (typeof index === "string") return member(object, index, ctx);
      return null;
    }
    case "unary": {
      const value = evalNode(node.arg, ctx);
      if (node.op === "!") return !isTruthy(value);
      if (value instanceof Duration) return new Duration(-value.ms);
      return value === null ? null : -asNumber(value);
    }
    case "binary": {
      if (node.op === "&&") {
        const left = evalNode(node.left, ctx);
        return isTruthy(left) ? isTruthy(evalNode(node.right, ctx)) : false;
      }
      if (node.op === "||") {
        const left = evalNode(node.left, ctx);
        return isTruthy(left) ? true : isTruthy(evalNode(node.right, ctx));
      }
      return binary(node.op, evalNode(node.left, ctx), evalNode(node.right, ctx), ctx);
    }
    case "call": {
      const lazy: Lazy[] = node.args.map(
        (arg) => (locals) =>
          evalNode(arg, locals ? { ...ctx, locals: { ...ctx.locals, ...locals } } : ctx),
      );
      if (node.callee.type === "id") return callGlobal(node.callee.name, lazy, ctx);
      if (node.callee.type === "member") {
        const target = node.callee.object;
        // `file.hasTag()` and friends: the current file is the receiver.
        const object = evalNode(target, ctx);
        return callMethod(object, node.callee.name, lazy, ctx);
      }
      throw new ExpressionError("Only functions and methods can be called");
    }
  }
}

function identifier(name: string, ctx: EvalContext): Value {
  if (ctx.locals && Object.prototype.hasOwnProperty.call(ctx.locals, name))
    return ctx.locals[name];
  switch (name) {
    case "file":
      return new FileValue(ctx.file);
    case "this":
      return ctx.self ? new FileValue(ctx.self) : null;
    case "note":
      return propertiesOf(ctx.file);
    case "formula":
      return null;
  }
  return property(ctx.file, name);
}

function args(lazy: Lazy[]): Value[] {
  return lazy.map((arg) => arg());
}

function callGlobal(name: string, lazy: Lazy[], ctx: EvalContext): Value {
  switch (name) {
    case "if": {
      const [condition, yes, no] = lazy;
      if (!condition) return null;
      return isTruthy(condition()) ? (yes?.() ?? null) : (no?.() ?? null);
    }
    case "now":
      return ctx.host.now();
    case "today": {
      const now = ctx.host.now();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
    case "date": {
      const [value] = args(lazy);
      return asDate(value ?? null);
    }
    case "duration": {
      const [value] = args(lazy);
      if (value instanceof Duration) return value;
      const parts = typeof value === "string" ? parseDurationParts(value) : null;
      return parts ? new Duration(parts.ms + parts.months * UNITS.M + parts.years * UNITS.y) : null;
    }
    case "number": {
      const [value] = args(lazy);
      const number = asNumber(value ?? null);
      return Number.isNaN(number) ? null : number;
    }
    case "list": {
      const [value] = args(lazy);
      return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
    }
    case "max":
    case "min": {
      const numbers = args(lazy).flat().map(asNumber).filter((n) => !Number.isNaN(n));
      if (!numbers.length) return null;
      return name === "max" ? Math.max(...numbers) : Math.min(...numbers);
    }
    case "link": {
      const [target, display] = args(lazy);
      const path = target instanceof FileValue ? target.path.replace(/\.md$/i, "") : toText(target ?? null);
      return new LinkValue(path, display === undefined || display === null ? null : toText(display));
    }
    case "file": {
      const [value] = args(lazy);
      return fileValue(pathOf(value ?? null, ctx), ctx);
    }
    case "random":
      return Math.random();
    case "escapeHTML":
    case "html":
    case "image":
    case "icon": {
      const [value] = args(lazy);
      return value instanceof FileValue ? value : toText(value ?? null);
    }
  }
  throw new ExpressionError(`Unknown function ${name}()`);
}

function callMethod(object: Value, name: string, lazy: Lazy[], ctx: EvalContext): Value {
  // Methods every value has.
  switch (name) {
    case "isTruthy":
      return isTruthy(object);
    case "toString":
      return toText(object, ctx.host.locale);
    case "isType": {
      const [type] = args(lazy);
      return typeName(object) === toText(type ?? null).toLowerCase();
    }
    case "isEmpty":
      if (object === null) return true;
      if (typeof object === "string" || Array.isArray(object)) return object.length === 0;
      if (isPlainObject(object)) return Object.keys(object).length === 0;
      return false;
  }
  if (object === null) return null;
  if (object instanceof FileValue) return fileMethod(object, name, lazy, ctx);
  if (object instanceof LinkValue) {
    if (name === "asFile") return fileValue(pathOf(object, ctx), ctx);
    if (name === "linksTo") {
      const [other] = args(lazy);
      const from = fileValue(pathOf(object, ctx), ctx);
      return from ? fileMethod(from, "hasLink", [() => other ?? null], ctx) : false;
    }
    return callMethod(toText(object), name, lazy, ctx);
  }
  if (object instanceof Date) return dateMethod(object, name, lazy, ctx);
  if (object instanceof RegExp) {
    if (name === "matches") {
      const [value] = args(lazy);
      object.lastIndex = 0;
      return object.test(toText(value ?? null));
    }
    throw new ExpressionError(`Unknown method ${name}()`);
  }
  if (typeof object === "string") return stringMethod(object, name, lazy, ctx);
  if (typeof object === "number") return numberMethod(object, name, lazy);
  if (Array.isArray(object)) return listMethod(object, name, lazy, ctx);
  if (isPlainObject(object)) {
    if (name === "keys") return Object.keys(object);
    if (name === "values") return Object.values(object);
  }
  throw new ExpressionError(`Unknown method ${name}()`);
}

function typeName(value: Value): string {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "date";
  if (value instanceof Duration) return "duration";
  if (value instanceof LinkValue) return "link";
  if (value instanceof FileValue) return "file";
  if (value instanceof RegExp) return "regexp";
  if (Array.isArray(value)) return "list";
  return "object";
}

function fileMethod(file: FileValue, name: string, lazy: Lazy[], ctx: EvalContext): Value {
  const record = file.record;
  switch (name) {
    case "hasTag": {
      const wanted = args(lazy).map((tag) => toText(tag).replace(/^#/, "").toLowerCase());
      return record.tags.some((tag) => {
        const lower = tag.toLowerCase();
        return wanted.some((want) => lower === want || lower.startsWith(`${want}/`));
      });
    }
    case "inFolder": {
      const [folder] = args(lazy);
      const prefix = toText(folder ?? null).replace(/^\/+|\/+$/g, "");
      return !prefix || record.path.startsWith(`${prefix}/`);
    }
    case "hasProperty": {
      const [key] = args(lazy);
      return Object.prototype.hasOwnProperty.call(record.properties, toText(key ?? null));
    }
    case "hasLink": {
      const [other] = args(lazy);
      const target = pathOf(other ?? null, ctx);
      if (!target) return false;
      return record.links.some(
        (link) => ctx.host.resolve(linkName(link), record.path) === target,
      );
    }
    case "asLink": {
      const [display] = args(lazy);
      return new LinkValue(
        record.path.replace(/\.md$/i, ""),
        display === undefined || display === null ? null : toText(display),
      );
    }
  }
  throw new ExpressionError(`Unknown method ${name}()`);
}

function dateMethod(date: Date, name: string, lazy: Lazy[], ctx: EvalContext): Value {
  switch (name) {
    case "format": {
      const [pattern] = args(lazy);
      return formatDate(date, toText(pattern ?? "YYYY-MM-DD") || "YYYY-MM-DD", ctx.host.locale);
    }
    case "date":
      return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    case "time":
      return formatDate(date, "HH:mm:ss", ctx.host.locale);
    case "relative": {
      const diff = date.getTime() - ctx.host.now().getTime();
      const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
        ["year", 365 * 864e5], ["month", 30 * 864e5], ["week", 7 * 864e5],
        ["day", 864e5], ["hour", 36e5], ["minute", 6e4],
      ];
      const format = new Intl.RelativeTimeFormat(ctx.host.locale, { numeric: "auto" });
      for (const [unit, size] of units)
        if (Math.abs(diff) >= size) return format.format(Math.round(diff / size), unit);
      return format.format(Math.round(diff / 1e3), "second");
    }
  }
  throw new ExpressionError(`Unknown method ${name}()`);
}

function stringMethod(text: string, name: string, lazy: Lazy[], ctx: EvalContext): Value {
  const values = () => args(lazy).map((value) => toText(value, ctx.host.locale));
  switch (name) {
    case "contains":
      return text.includes(values()[0] ?? "");
    case "containsAll":
      return values().every((value) => text.includes(value));
    case "containsAny":
      return values().some((value) => text.includes(value));
    case "startsWith":
      return text.startsWith(values()[0] ?? "");
    case "endsWith":
      return text.endsWith(values()[0] ?? "");
    case "lower":
      return text.toLowerCase();
    case "upper":
      return text.toUpperCase();
    case "title":
      return text.replace(/(^|\s)(\p{L})/gu, (_, space, letter) => space + letter.toUpperCase());
    case "trim":
      return text.trim();
    case "reverse":
      return [...text].reverse().join("");
    case "repeat": {
      const [count] = args(lazy);
      return text.repeat(Math.max(0, Math.min(1000, asNumber(count ?? 0) || 0)));
    }
    case "slice": {
      const [start, end] = args(lazy);
      return text.slice(asNumber(start ?? 0) || 0, end === undefined || end === null ? undefined : asNumber(end));
    }
    case "split": {
      const [separator, n] = args(lazy);
      const parts = text.split(separator instanceof RegExp ? separator : toText(separator ?? ""));
      return n === undefined || n === null ? parts : parts.slice(0, asNumber(n));
    }
    case "replace": {
      const [pattern, replacement] = args(lazy);
      const insert = toText(replacement ?? "");
      return pattern instanceof RegExp
        ? text.replace(pattern, insert)
        : text.split(toText(pattern ?? "")).join(insert);
    }
  }
  throw new ExpressionError(`Unknown method ${name}()`);
}

function numberMethod(value: number, name: string, lazy: Lazy[]): Value {
  switch (name) {
    case "abs":
      return Math.abs(value);
    case "ceil":
      return Math.ceil(value);
    case "floor":
      return Math.floor(value);
    case "round": {
      const [digits] = lazy.map((arg) => arg());
      const factor = 10 ** (digits === undefined || digits === null ? 0 : asNumber(digits));
      return Math.round(value * factor) / factor;
    }
    case "toFixed": {
      const [digits] = lazy.map((arg) => arg());
      return value.toFixed(Math.max(0, Math.min(20, asNumber(digits ?? 0) || 0)));
    }
  }
  throw new ExpressionError(`Unknown method ${name}()`);
}

function listMethod(list: Value[], name: string, lazy: Lazy[], ctx: EvalContext): Value {
  const has = (value: Value) => list.some((item) => equals(item, value, ctx));
  switch (name) {
    case "contains":
      return has(lazy[0]?.() ?? null);
    case "containsAll":
      return args(lazy).every(has);
    case "containsAny":
      return args(lazy).some(has);
    case "join": {
      const [separator] = args(lazy);
      return list.map((item) => toText(item, ctx.host.locale)).join(separator === undefined ? ", " : toText(separator));
    }
    case "reverse":
      return [...list].reverse();
    case "flat":
      return list.flat() as Value[];
    case "unique":
      return list.filter((item, i) => list.findIndex((other) => equals(other, item, ctx)) === i);
    case "sort":
      return [...list].sort((a, b) => compareValues(a, b, ctx.host.locale) ?? 0);
    case "slice": {
      const [start, end] = args(lazy);
      return list.slice(asNumber(start ?? 0) || 0, end === undefined || end === null ? undefined : asNumber(end));
    }
    case "filter":
      return list.filter((value, index) => isTruthy(lazy[0]?.({ value, index }) ?? null));
    case "map":
      return list.map((value, index) => lazy[0]?.({ value, index }) ?? null);
    case "reduce": {
      let acc = lazy[1]?.() ?? null;
      list.forEach((value, index) => {
        acc = lazy[0]?.({ value, index, acc }) ?? null;
      });
      return acc;
    }
  }
  throw new ExpressionError(`Unknown method ${name}()`);
}

/** Evaluates a parsed expression for one file. */
export function evaluate(node: Node, ctx: EvalContext): Value {
  return evalNode(node, ctx);
}
