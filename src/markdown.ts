import { t } from "./i18n";
import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";
import { mathAt } from "./editor/math-source";

export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );
}

interface WikiToken extends Tokens.Generic {
  type: "wikilink";
  target: string;
  label: string;
  embed: boolean;
}

const parser = new Marked({ gfm: true, breaks: false });
parser.use({
  renderer: {
    checkbox({ checked }) {
      // Empty on purpose: text inside an inline-block moves its baseline and
      // drops a checked box below its line. The state lives in aria-checked.
      return `<span class="task-box${checked ? " checked" : ""}" role="checkbox" tabindex="0" aria-checked="${checked}"></span> `;
    },
  },
});
parser.use({
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start(source: string) {
        return source.search(/!?\[\[/);
      },
      tokenizer(source: string) {
        const match = /^(\!?)\[\[([^\]\n]+)\]\]/.exec(source);
        if (!match) return;
        const [target, ...alias] = match[2].split("|");
        return {
          type: "wikilink",
          raw: match[0],
          target: target.trim(),
          label: alias.join("|").trim() || target.trim(),
          embed: !!match[1],
        };
      },
      renderer(token) {
        const wiki = token as WikiToken;
        return `<a class="internal-link${wiki.embed ? " is-embed" : ""}" href="#" data-note="${escapeHtml(wiki.target)}">${wiki.embed ? "↗ " : ""}${escapeHtml(wiki.label)}</a>`;
      },
    },
  ],
});

parser.use({
  extensions: [
    {
      name: "highlight",
      level: "inline",
      start(source: string) {
        return source.indexOf("==");
      },
      tokenizer(source: string) {
        const match = /^==(?=\S)([^\n]*?\S)==(?!=)/.exec(source);
        if (!match) return;
        return {
          type: "highlight",
          raw: match[0],
          tokens: this.lexer.inlineTokens(match[1]),
        };
      },
      renderer(token) {
        return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`;
      },
    },
  ],
});

/**
 * TeX must reach KaTeX untouched: without these tokens Markdown would eat
 * escapes such as `\,` or `\{` and turn `a_1 * b_2` into emphasis. The source
 * stays plain text with its `$` delimiters for `enhanceMath` to render.
 */
const CLOSING_DISPLAY = /(?<!\\)\$\$\s*$/;
parser.use({
  extensions: [
    {
      name: "mathBlock",
      level: "block",
      start(source: string) {
        return /^\$\$/m.exec(source)?.index;
      },
      tokenizer(source: string) {
        if (!source.startsWith("$$")) return;
        const lines = source.split("\n");
        const first = lines[0].slice(2);
        if (first.includes("$$") && !CLOSING_DISPLAY.test(first)) return;
        let end = CLOSING_DISPLAY.test(first) ? 0 : -1;
        for (let i = 1; end < 0 && i < lines.length; i++)
          if (CLOSING_DISPLAY.test(lines[i])) end = i;
        // Like Obsidian's reading view, an unclosed formula stays text.
        if (end < 0) return;
        const text = lines.slice(0, end + 1).join("\n");
        return {
          type: "mathBlock",
          raw: end + 1 < lines.length ? `${text}\n` : text,
          text: text.trimEnd(),
        };
      },
      renderer(token) {
        return `<div class="math-block">${escapeHtml(token.text as string)}</div>\n`;
      },
    },
    {
      name: "math",
      level: "inline",
      start(source: string) {
        const at = source.indexOf("$");
        return at < 0 ? undefined : at;
      },
      tokenizer(source: string) {
        const math = mathAt(source, 0);
        if (!math) return;
        return { type: "math", raw: math.source, text: math.source };
      },
      renderer(token) {
        return `<span class="math-inline">${escapeHtml(token.text as string)}</span>`;
      },
    },
  ],
});

/**
 * Footnotes as Obsidian writes them: `[^id]` references, `[^id]: text`
 * definitions (continued by indented lines) and `^[inline]` notes. They are
 * numbered in the order they are first referenced and listed at the end.
 */
class Footnotes {
  /** Definition ids, known once the lexer has run. */
  readonly ids = new Set<string>();
  private readonly numbers = new Map<string, number>();
  private readonly html = new Map<number, string>();
  private count = 0;

  number(id: string | null): number {
    if (id === null) return ++this.count;
    let number = this.numbers.get(id);
    if (!number) this.numbers.set(id, (number = ++this.count));
    return number;
  }

  define(id: string, html: string): void {
    // A definition nobody references still gets listed, after the others.
    this.html.set(this.number(id), html);
  }

  defineInline(number: number, html: string): void {
    this.html.set(number, html);
  }

  section(): string {
    if (!this.html.size) return "";
    const items = [...this.html]
      .sort(([a], [b]) => a - b)
      .map(([number, html]) => {
        const back = ` <a href="#" class="footnote-backref" data-footnote-back="${number}" aria-label="${escapeHtml(t("Zurück zum Text"))}">↩︎</a>`;
        // The arrow ends the last paragraph instead of starting a line.
        const body = html.trimEnd();
        const content = body.endsWith("</p>")
          ? `${body.slice(0, -4)}${back}</p>`
          : body + back;
        return `<li data-footnote="${number}">${content}</li>`;
      })
      .join("");
    return `<section class="footnotes"><hr><ol>${items}</ol></section>`;
  }
}

let footnotes: Footnotes | null = null;

const FOOTNOTE_DEF =
  /^\[\^([^\]\s]+)\]:[ \t]?([^\n]*(?:\n(?:[ \t]{2,}|\t)[^\n]*)*)(?:\n|$)/;

parser.use({
  extensions: [
    {
      name: "footnoteDef",
      level: "block",
      start(source: string) {
        return /^\[\^[^\]\s]+\]:/m.exec(source)?.index;
      },
      tokenizer(source: string) {
        const match = FOOTNOTE_DEF.exec(source);
        if (!match) return;
        footnotes?.ids.add(match[1]);
        const text = match[2].replace(/\n(?:[ \t]{2,}|\t)/g, "\n").trim();
        const token = {
          type: "footnoteDef",
          raw: match[0],
          id: match[1],
          tokens: [],
        };
        this.lexer.blockTokens(text, token.tokens);
        return token;
      },
      renderer(token) {
        footnotes?.define(
          token.id as string,
          this.parser.parse(token.tokens ?? []),
        );
        return "";
      },
    },
    {
      name: "footnoteRef",
      level: "inline",
      start(source: string) {
        const at = source.search(/\[\^|\^\[/);
        return at < 0 ? undefined : at;
      },
      tokenizer(source: string) {
        const ref = /^\[\^([^\]\s]+)\]/.exec(source);
        if (ref)
          return { type: "footnoteRef", raw: ref[0], id: ref[1], tokens: [] };
        const inline = /^\^\[((?:[^[\]\n]|\[[^\]\n]*\])+)\]/.exec(source);
        if (!inline) return;
        return {
          type: "footnoteRef",
          raw: inline[0],
          id: null,
          tokens: this.lexer.inlineTokens(inline[1]),
        };
      },
      renderer(token) {
        const id = token.id as string | null;
        if (!footnotes || (id !== null && !footnotes.ids.has(id)))
          return escapeHtml(token.raw);
        const number = footnotes.number(id);
        if (id === null)
          footnotes.defineInline(
            number,
            `<p>${this.parser.parseInline(token.tokens ?? [])}</p>`,
          );
        return `<sup class="footnote-ref"><a href="#" class="footnote-link" data-footnote-ref="${number}">${number}</a></sup>`;
      },
    },
  ],
});

/** Markdown to HTML with footnotes collected at the end. */
function parseWithFootnotes(body: string): string {
  const outer = footnotes;
  footnotes = new Footnotes();
  try {
    return (parser.parse(body) as string) + footnotes.section();
  } finally {
    footnotes = outer;
  }
}

export interface Property {
  key: string;
  values: string[];
}

/** Splits a leading YAML frontmatter block from the note body. */
export function splitFrontmatter(source: string): {
  body: string;
  properties: Property[] | null;
} {
  const match =
    /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(
      source,
    );
  if (!match) return { body: source, properties: null };
  const properties: Property[] = [];
  let current: Property | null = null;
  const clean = (value: string) => value.trim().replace(/^(["'])(.*)\1$/, "$2");
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && current) {
      current.values.push(clean(item[1]));
      continue;
    }
    const pair = /^([^\s:#][^:]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const value = pair[2].trim();
    current = { key: pair[1].trim(), values: [] };
    if (/^\[.*\]$/.test(value))
      current.values = value.slice(1, -1).split(",").map(clean).filter(Boolean);
    else if (value) current.values = [clean(value)];
    properties.push(current);
  }
  return { body: source.slice(match[0].length), properties };
}

/**
 * Whether the note opens with a level-one heading equal to `title`; the inline
 * title would then show the same words twice.
 */
export function repeatsTitle(source: string, title: string): boolean {
  const { body } = splitFrontmatter(source);
  const first = /^\s*(.*)/.exec(body)?.[1] ?? "";
  const heading = /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(first);
  return (
    !!heading &&
    heading[1].trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase()
  );
}

function renderProperties(properties: Property[]): string {
  if (!properties.length) return "";
  const rows = properties
    .map((property) => {
      const isTags = /^tags?$/i.test(property.key);
      const values = property.values
        .map((value) =>
          isTags
            ? `<a class="tag" href="#" data-tag="${escapeHtml(value.replace(/^#/, ""))}">#${escapeHtml(value.replace(/^#/, ""))}</a>`
            : `<span>${escapeHtml(value)}</span>`,
        )
        .join("");
      return `<div class="metadata-property"><div class="metadata-property-key">${escapeHtml(property.key)}</div><div class="metadata-property-value">${values}</div></div>`;
    })
    .join("");
  return `<div class="metadata-container"><div class="metadata-properties-heading">${escapeHtml(t("Eigenschaften"))}</div>${rows}</div>`;
}

const CALLOUT = /^\[!([\w-]+)\]([+-]?)[ \t]*/;

/** Turns `> [!note] Title` block quotes into Obsidian-style callouts. */
function renderCallouts(root: DocumentFragment): void {
  // Innermost first, so nested callouts are already converted when moved.
  for (const quote of [...root.querySelectorAll("blockquote")].reverse()) {
    const first = quote.firstElementChild;
    if (!first || first.tagName !== "P") continue;
    const lead = first.firstChild;
    if (!lead || lead.nodeType !== Node.TEXT_NODE) continue;
    const match = CALLOUT.exec(lead.textContent ?? "");
    if (!match) continue;
    const type = match[1].toLowerCase();
    lead.textContent = (lead.textContent ?? "").slice(match[0].length);
    const title = document.createElement("div");
    title.className = "callout-title-inner";
    // Everything up to the first line break of the paragraph is the title.
    while (first.firstChild) {
      const node = first.firstChild;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        const newline = text.indexOf("\n");
        if (newline >= 0) {
          title.append(text.slice(0, newline));
          node.textContent = text.slice(newline + 1);
          break;
        }
      } else if ((node as Element).tagName === "BR") {
        node.remove();
        break;
      }
      title.append(node);
    }
    if (!title.textContent?.trim())
      title.textContent = type.charAt(0).toUpperCase() + type.slice(1);
    if (!first.textContent?.trim() && !first.querySelector("img"))
      first.remove();
    const callout = document.createElement("div");
    callout.className = "callout";
    callout.dataset.callout = type;
    if (match[2]) callout.dataset.calloutFold = match[2];
    const heading = document.createElement("div");
    heading.className = "callout-title";
    const iconEl = document.createElement("div");
    iconEl.className = "callout-icon";
    heading.append(iconEl, title);
    if (match[2]) {
      const collapsed = match[2] === "-";
      callout.classList.toggle("is-collapsed", collapsed);
      heading.setAttribute("role", "button");
      heading.tabIndex = 0;
      heading.setAttribute("aria-expanded", String(!collapsed));
    }
    callout.append(heading);
    if (quote.childNodes.length) {
      const content = document.createElement("div");
      content.className = "callout-content";
      content.append(...quote.childNodes);
      if (content.textContent?.trim() || content.querySelector("img, hr"))
        callout.append(content);
    }
    quote.replaceWith(callout);
  }
}

const TAG_PATTERN = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gu;

/** Wraps `#tags` in body text; code, links and headings' anchors are left alone. */
function renderTags(root: DocumentFragment): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    if (!text.includes("#")) continue;
    if (
      (node.parentElement as Element | null)?.closest(
        "a, code, pre, .math-inline, .math-block",
      )
    )
      continue;
    targets.push(node as Text);
  }
  for (const node of targets) {
    const text = node.textContent ?? "";
    TAG_PATTERN.lastIndex = 0;
    let last = 0;
    const parts: Array<string | Node> = [];
    for (let m = TAG_PATTERN.exec(text); m; m = TAG_PATTERN.exec(text)) {
      if (/^\d+$/.test(m[2])) continue;
      const start = m.index + m[1].length;
      parts.push(text.slice(last, start));
      const link = document.createElement("a");
      link.className = "tag";
      link.setAttribute("href", "#");
      link.dataset.tag = m[2];
      link.textContent = `#${m[2]}`;
      parts.push(link);
      last = start + m[2].length + 1;
    }
    if (!parts.length) continue;
    parts.push(text.slice(last));
    node.replaceWith(...parts);
  }
}

export function renderMarkdown(source: string): string {
  const { body, properties } = splitFrontmatter(source);
  const safe = DOMPurify.sanitize(parseWithFootnotes(body), {
    FORBID_TAGS: [
      "style",
      "iframe",
      "object",
      "form",
      "input",
      "video",
      "audio",
      "svg",
      "math",
    ],
    FORBID_ATTR: ["style", "srcset", "background", "poster", "xlink:href"],
    ALLOW_DATA_ATTR: true,
    // DOMPurify's default list plus `obsidian:`, whose links go to plugins.
    ALLOWED_URI_REGEXP:
      /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|obsidian):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });
  const template = document.createElement("template");
  template.innerHTML = safe;
  // Apply the native CSP's remote-image policy to the browser demo as well.
  for (const image of template.content.querySelectorAll("img")) {
    const source = image.getAttribute("src");
    if (!source) continue;
    try {
      const url = new URL(source, location.href);
      const inlineRaster = /^data:image\/(png|jpeg|gif|webp);/i.test(source);
      if (url.origin !== location.origin && !inlineRaster) {
        image.removeAttribute("src");
        image.title = t("Externes Bild aus Datenschutzgründen blockiert");
      }
    } catch {
      image.removeAttribute("src");
    }
  }
  renderCallouts(template.content);
  renderTags(template.content);
  // Hovering a footnote number shows its text.
  for (const link of template.content.querySelectorAll<HTMLElement>(
    "a[data-footnote-ref]",
  )) {
    const note = template.content.querySelector(
      `li[data-footnote="${link.dataset.footnoteRef}"]`,
    );
    if (note) link.title = (note.textContent ?? "").replace(/↩︎$/, "").trim();
  }
  for (const link of template.content.querySelectorAll("a[href]"))
    if (
      !link.classList.contains("internal-link") &&
      !link.classList.contains("tag") &&
      !link.classList.contains("footnote-link") &&
      !link.classList.contains("footnote-backref")
    )
      link.classList.add("external-link");
  return (properties ? renderProperties(properties) : "") + template.innerHTML;
}

export function wikiLinks(source: string): string[] {
  const links: string[] = [];
  parser.walkTokens(parser.lexer(source), (token) => {
    if (token.type === "wikilink") links.push((token as WikiToken).target);
  });
  return links;
}

export function resolveNote(
  target: string,
  sourcePath: string,
  files: string[],
): string | null {
  const name = target.split("#")[0];
  if (!name) return sourcePath;
  const requested = /\.md$/i.test(name) ? name : `${name}.md`;
  const folder = sourcePath.includes("/")
    ? sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1)
    : "";
  for (const candidate of [folder + requested, requested]) {
    if (files.includes(candidate)) return candidate;
  }
  const matches = files.filter((path) => path.split("/").pop() === requested);
  return matches.length === 1 ? matches[0] : null;
}

export function wordCount(source: string): number {
  return source.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export interface OutlineEntry {
  depth: number;
  text: string;
  offset: number;
}

/**
 * Characters that can change a heading's visible text: Markdown inline syntax,
 * HTML and entities, and the wiki link, highlight and math extensions above.
 */
const INLINE_SYNTAX = /[\\`*_~[\]<>&=$!]/;

/** Visible text of a heading. Plain headings skip the parser and sanitizer. */
export function headingText(text: string): string {
  if (!INLINE_SYNTAX.test(text)) return text;
  const template = document.createElement("template");
  template.innerHTML = DOMPurify.sanitize(parser.parseInline(text) as string);
  return template.content.textContent ?? text;
}

/** ATX headings, excluding fenced code and an initial YAML frontmatter block. */
export function documentOutline(source: string): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  let fence: { char: string; length: number } | null = null;
  let frontmatter = /^---\r?\n/.test(source);
  let offset = 0;
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (frontmatter) {
      if (offset > 0 && /^(---|\.\.\.)\s*$/.test(line)) frontmatter = false;
    } else {
      const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (delimiter) {
        if (!fence)
          fence = { char: delimiter[1][0], length: delimiter[1].length };
        else if (
          delimiter[1][0] === fence.char &&
          delimiter[1].length >= fence.length &&
          !delimiter[2].trim()
        )
          fence = null;
      } else if (!fence) {
        const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
        if (heading) {
          const text = heading[2].replace(/[ \t]+#+[ \t]*$/, "");
          entries.push({
            depth: heading[1].length,
            text: headingText(text),
            offset,
          });
        }
      }
    }
    offset += raw.length + 1;
  }
  return entries;
}
