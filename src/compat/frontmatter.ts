import { parse, stringify } from "yaml";

const FRONTMATTER =
  /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export interface FrontMatterInfo {
  exists: boolean;
  /** YAML text between the delimiters, including its trailing newline. */
  frontmatter: string;
  /** Offset of the first content character. */
  from: number;
  /** Offset of the closing delimiter. */
  to: number;
  /** Offset just past the closing delimiter line. */
  contentStart: number;
}

/** One definition of what Obsidian treats as a frontmatter block. */
export function getFrontMatterInfo(text: string): FrontMatterInfo {
  const match = FRONTMATTER.exec(text);
  if (!match)
    return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  const from = match[0].indexOf("\n") + 1;
  const content = match[1];
  const end = content === undefined ? from : from + content.length;
  // CRLF keeps its \r out of the capture group, so the terminator is two chars.
  const to =
    content === undefined ? from : end + (match[0][end] === "\r" ? 2 : 1);
  return {
    exists: true,
    frontmatter: text.slice(from, to),
    from,
    to,
    contentStart: match[0].length,
  };
}

export function parseYaml(text: string): unknown {
  return parse(text);
}

export function stringifyYaml(value: unknown): string {
  return stringify(value);
}

export function parseFrontMatterEntry(
  frontmatter: unknown,
  key: string | RegExp,
): unknown {
  if (!frontmatter || typeof frontmatter !== "object") return null;
  const entries = Object.entries(frontmatter as Record<string, unknown>);
  const match =
    typeof key === "string"
      ? entries.find(([name]) => name === key)
      : entries.find(([name]) => key.test(name));
  return match?.[1] ?? null;
}

export function parseFrontMatterStringArray(
  frontmatter: unknown,
  key: string | RegExp,
): string[] | null {
  const value = parseFrontMatterEntry(frontmatter, key);
  if (value === null || value === undefined) return null;
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => String(item).trim());
}

export function parseFrontMatterTags(frontmatter: unknown): string[] | null {
  const tags = parseFrontMatterStringArray(frontmatter, /^tags?$/);
  if (!tags) return null;
  const normalised = tags
    .filter((tag) => tag.length > 0)
    .map((tag) => `#${tag.replace(/^#+/, "")}`);
  return normalised.length ? normalised : null;
}

export function parseFrontMatterAliases(frontmatter: unknown): string[] | null {
  return parseFrontMatterStringArray(frontmatter, "aliases");
}
