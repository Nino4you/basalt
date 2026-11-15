import { documentOutline } from "../markdown";

/**
 * Search query syntax, modelled on Obsidian's search:
 *
 * - plain terms and `"quoted phrases"` must all occur (case-insensitive);
 * - `/regex/` is a JavaScript regular expression (case-insensitive, `^`
 *   and `$` match at line breaks);
 * - `tag:`, `path:` and `file:` narrow the files;
 * - `line:`, `section:` and `task:` / `task-todo:` / `task-done:` require
 *   their terms within one line, one heading section or one task, e.g.
 *   `line:(mehl zucker)`; `task:""` or `task:()` matches any task;
 * - a leading `-` excludes any of these.
 */

export type Scope = "line" | "section" | "task" | "task-todo" | "task-done";

export type Matcher = { text: string } | { regex: RegExp };

export interface ScopedClause {
  scope: Scope;
  matchers: Matcher[];
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
  regexes: RegExp[];
  excludedRegexes: RegExp[];
  scoped: ScopedClause[];
  excludedScoped: ScopedClause[];
}

const SCOPES = new Set<string>([
  "line",
  "section",
  "task",
  "task-todo",
  "task-done",
]);
const OPERATOR = /^(task-todo|task-done|tag|path|file|line|section|task):/i;

export interface QueryToken {
  negated: boolean;
  operator?: string;
  /** The value as typed, without quotes, slashes or parentheses. */
  value: string;
  quoted: boolean;
  regex?: RegExp;
  /** The terms inside `operator:(…)`. */
  group?: QueryToken[];
}

/**
 * A `/…/` regex starting at `start`, or null. The closing slash must end the
 * token, so paths such as `/notes` or `a/b/c` stay text.
 */
function readRegex(
  query: string,
  start: number,
  stop: (char: string) => boolean,
): { regex: RegExp; source: string; end: number } | null {
  for (let i = start + 1; i < query.length; i++) {
    const char = query[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char !== "/") continue;
    const next = query[i + 1];
    if (next !== undefined && !stop(next)) continue;
    const source = query.slice(start + 1, i);
    if (!source) return null;
    try {
      // `^` and `$` anchor lines, which is what a note search means.
      return { regex: new RegExp(source, "gim"), source, end: i + 1 };
    } catch {
      // An unfinished or invalid pattern is searched as text.
      return null;
    }
  }
  return null;
}

/** Splits a query into tokens; `nested` reads the inside of `op:(…)`. */
export function tokenizeQuery(query: string, nested = false): QueryToken[] {
  const tokens: QueryToken[] = [];
  const space = (char: string) => /\s/.test(char);
  const stop = (char: string) => space(char) || (nested && char === ")");
  let i = 0;
  while (i < query.length) {
    while (i < query.length && space(query[i])) i++;
    if (i >= query.length) break;
    let negated = false;
    if (!nested && query[i] === "-" && i + 1 < query.length && !space(query[i + 1])) {
      negated = true;
      i++;
    }
    let operator: string | undefined;
    const op = nested ? null : OPERATOR.exec(query.slice(i));
    if (op) {
      operator = op[1].toLowerCase();
      i += op[0].length;
    }
    const char = query[i];
    if (char === '"') {
      const close = query.indexOf('"', i + 1);
      const end = close < 0 ? query.length : close;
      tokens.push({ negated, operator, value: query.slice(i + 1, end), quoted: true });
      i = end + 1;
      continue;
    }
    if (char === "(" && operator && SCOPES.has(operator)) {
      let depth = 0;
      let end = i;
      let quoted = false;
      for (; end < query.length; end++) {
        const c = query[end];
        if (c === '"') quoted = !quoted;
        else if (!quoted && c === "(") depth++;
        else if (!quoted && c === ")" && --depth === 0) break;
      }
      const inner = query.slice(i + 1, end);
      tokens.push({
        negated,
        operator,
        value: inner,
        quoted: false,
        group: tokenizeQuery(inner, true),
      });
      i = end + 1;
      continue;
    }
    if (char === "/" && (!operator || SCOPES.has(operator))) {
      const regex = readRegex(query, i, stop);
      if (regex) {
        tokens.push({
          negated,
          operator,
          value: regex.source,
          quoted: false,
          regex: regex.regex,
        });
        i = regex.end;
        continue;
      }
    }
    let end = i;
    while (end < query.length && !stop(query[end])) end++;
    tokens.push({ negated, operator, value: query.slice(i, end), quoted: false });
    i = end;
    if (nested && query[i] === ")") i++;
  }
  return tokens;
}

function matcherOf(token: QueryToken): Matcher | null {
  if (token.regex) return { regex: token.regex };
  const text = token.value.toLowerCase();
  return text ? { text } : null;
}

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
    regexes: [],
    excludedRegexes: [],
    scoped: [],
    excludedScoped: [],
  };
  for (const token of tokenizeQuery(query)) {
    const { operator, negated } = token;
    if (operator && SCOPES.has(operator)) {
      const matchers = (token.group ?? [token])
        .map(matcherOf)
        .filter((matcher): matcher is Matcher => !!matcher);
      // `line:` without terms means nothing; a task clause without terms
      // still asks for a task.
      if (!matchers.length && !operator.startsWith("task")) continue;
      (negated ? parsed.excludedScoped : parsed.scoped).push({
        scope: operator as Scope,
        matchers,
      });
      continue;
    }
    if (token.regex) {
      (negated ? parsed.excludedRegexes : parsed.regexes).push(token.regex);
      continue;
    }
    const value = token.value.toLowerCase();
    if (!value) continue;
    if (operator === "tag")
      (negated ? parsed.excludedTags : parsed.tags).push(value.replace(/^#/, ""));
    else if (operator === "path")
      (negated ? parsed.excludedPath : parsed.path).push(value);
    else if (operator === "file")
      (negated ? parsed.excludedFile : parsed.file).push(value);
    else if (value.startsWith("#") && value.length > 1 && !token.quoted)
      (negated ? parsed.excludedTags : parsed.tags).push(value.slice(1));
    else (negated ? parsed.excludedTerms : parsed.terms).push(value);
  }
  return parsed;
}

/** Whether the query asks for anything at all. */
export function isEmptyQuery(query: ParsedQuery): boolean {
  return Object.values(query).every((list) => list.length === 0);
}

interface Range {
  from: number;
  to: number;
}

const TASK = /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+\[(.)\][ \t]?/;

/** The lines, heading sections or tasks of a note, as offsets into it. */
export function scopeUnits(text: string, scope: Scope): Range[] {
  if (scope === "section") {
    const starts = documentOutline(text)
      .map((entry) => entry.offset)
      .filter((offset) => offset > 0);
    const bounds = [0, ...starts, text.length];
    const units: Range[] = [];
    for (let i = 0; i < bounds.length - 1; i++)
      if (bounds[i + 1] > bounds[i])
        units.push({ from: bounds[i], to: bounds[i + 1] });
    return units;
  }
  const units: Range[] = [];
  let from = 0;
  for (const line of text.split("\n")) {
    const to = from + line.length;
    if (scope === "line") units.push({ from, to });
    else {
      const task = TASK.exec(line);
      if (task) {
        const done = task[1] !== " ";
        if (
          scope === "task" ||
          (scope === "task-done" && done) ||
          (scope === "task-todo" && !done)
        )
          units.push({ from: from + task[0].length, to });
      }
    }
    from = to + 1;
  }
  return units;
}

/** Every hit of `matcher` inside `range`. */
function hits(
  matcher: Matcher,
  text: string,
  lower: string,
  range: Range,
  limit: number,
): Range[] {
  const found: Range[] = [];
  if ("text" in matcher) {
    const needle = matcher.text;
    for (
      let at = lower.indexOf(needle, range.from);
      at >= 0 && at + needle.length <= range.to && found.length < limit;
      at = lower.indexOf(needle, at + needle.length)
    )
      found.push({ from: at, to: at + needle.length });
    return found;
  }
  const regex = matcher.regex;
  regex.lastIndex = range.from;
  for (let m = regex.exec(text); m && found.length < limit; m = regex.exec(text)) {
    if (m.index + m[0].length > range.to) break;
    if (!m[0].length) {
      // Empty matches (`/^/`) only prove presence; step past them.
      found.push({ from: m.index, to: m.index });
      regex.lastIndex = m.index + 1;
      if (regex.lastIndex > range.to) break;
      continue;
    }
    found.push({ from: m.index, to: m.index + m[0].length });
  }
  return found;
}

function contains(
  matcher: Matcher,
  text: string,
  lower: string,
  range: Range,
): boolean {
  return hits(matcher, text, lower, range, 1).length > 0;
}

/**
 * The hits of a scoped clause: for every unit that holds all its terms,
 * their positions (or the whole unit for a bare `task:`). Empty when no unit
 * qualifies.
 */
export function scopedHits(
  clause: ScopedClause,
  text: string,
  lower: string,
  limit: number,
): Range[] {
  const found: Range[] = [];
  for (const unit of scopeUnits(text, clause.scope)) {
    if (!clause.matchers.every((m) => contains(m, text, lower, unit))) continue;
    if (!clause.matchers.length) {
      // A bare task clause shows the task text itself.
      const line = text.slice(unit.from, unit.to);
      found.push({ from: unit.from, to: unit.from + line.trimEnd().length });
    }
    for (const matcher of clause.matchers)
      for (const hit of hits(matcher, text, lower, unit, limit))
        if (hit.to > hit.from) found.push(hit);
    if (found.length >= limit) break;
  }
  return found;
}

/** Whether `clause` is satisfied anywhere in the note. */
export function scopedMatches(
  clause: ScopedClause,
  text: string,
  lower: string,
): boolean {
  return scopeUnits(text, clause.scope).some((unit) =>
    clause.matchers.every((m) => contains(m, text, lower, unit)),
  );
}

export function regexMatches(regex: RegExp, text: string): boolean {
  regex.lastIndex = 0;
  return regex.exec(text) !== null;
}

export { hits as matcherHits };
