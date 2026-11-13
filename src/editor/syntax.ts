import {
  HighlightStyle,
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
} from "@codemirror/language";
import { Tag, tags as t } from "@lezer/highlight";
import { NodeProp } from "@lezer/common";
import { mathAt } from "./math-source";
import type {
  BlockContext,
  DelimiterType,
  InlineContext,
  Line,
  MarkdownConfig,
} from "@lezer/markdown";

export const wikiTag = Tag.define();
export const hashtagTag = Tag.define();
export const highlightTag = Tag.define();
export const frontmatterTag = Tag.define();
// shortcut: Obsidian's patched token property covers internal links only, extend for other plugin tokens.
export const tokenClassNodeProp = new NodeProp<string>();

const HighlightDelimiter: DelimiterType = {
  resolve: "Highlight",
  mark: "HighlightMark",
};

const isSpace = (code: number) =>
  code === 32 || code === 9 || code === 10 || code === 13 || code < 0;

/** Obsidian flavoured additions on top of GFM: properties, [[links]], #tags and ==marks==. */
export const obsidianSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "Frontmatter", block: true, style: frontmatterTag },
    { name: "WikiLink", style: wikiTag },
    { name: "WikiLinkText" },
    { name: "Hashtag", style: hashtagTag },
    { name: "Highlight", style: { "Highlight/...": highlightTag } },
    { name: "HighlightMark", style: t.processingInstruction },
    { name: "InlineMath", style: t.special(t.string) },
    { name: "BlockMath", block: true, style: t.special(t.string) },
    { name: "UnclosedMath", block: true },
  ],
  props: [tokenClassNodeProp.add({ WikiLinkText: "hmd-internal-link" })],
  parseBlock: [
    {
      name: "BlockMath",
      before: "FencedCode",
      parse(cx: BlockContext, line: Line) {
        // Like a fence, an unfinished display formula remains editable source.
        if (line.pos !== 0 || !line.text.startsWith("$$")) return false;
        const start = cx.lineStart;
        const first = line.text.slice(2);
        if (first.includes("$$") && !/\$\$\s*$/.test(first)) return false;
        let closed = /(?<!\\)\$\$\s*$/.test(first);
        let end = cx.lineStart + line.text.length;
        while (!closed && cx.nextLine()) {
          end = cx.lineStart + line.text.length;
          closed = /(?<!\\)\$\$\s*$/.test(line.text);
        }
        if (closed) cx.nextLine();
        cx.addElement(cx.elt(closed ? "BlockMath" : "UnclosedMath", start, end));
        return true;
      },
    },
    {
      name: "Frontmatter",
      before: "HorizontalRule",
      parse(cx: BlockContext, line: Line) {
        if (cx.lineStart !== 0 || !/^---\s*$/.test(line.text)) return false;
        // Only a closed block counts, so a lone `---` stays a horizontal rule.
        let end = -1;
        while (cx.nextLine()) {
          if (/^(---|\.\.\.)\s*$/.test(line.text)) {
            end = cx.lineStart + line.text.length;
            break;
          }
        }
        if (end < 0) end = cx.prevLineEnd();
        else cx.nextLine();
        cx.addElement(cx.elt("Frontmatter", 0, end));
        return true;
      },
    },
  ],
  parseInline: [
    {
      name: "Math",
      after: "InlineCode",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== 36 || cx.char(pos - 1) === 36) return -1;
        const found = mathAt(cx.slice(pos, cx.end), 0);
        return found
          ? cx.addElement(cx.elt(found.display ? "BlockMath" : "InlineMath", pos, pos + found.to))
          : -1;
      },
    },
    {
      name: "WikiLink",
      before: "Link",
      parse(cx: InlineContext, next: number, pos: number) {
        let start = pos;
        if (next === 33 /* ! */ && cx.char(pos + 1) === 91) start = pos + 1;
        else if (next !== 91 /* [ */) return -1;
        if (cx.char(start + 1) !== 91) return -1;
        const rest = cx.slice(start + 2, cx.end);
        const close = rest.indexOf("]]");
        if (close <= 0) return -1;
        const inner = rest.slice(0, close);
        if (inner.includes("\n") || inner.includes("[[")) return -1;
        const target = inner.split("|", 1)[0];
        return cx.addElement(
          cx.elt("WikiLink", pos, start + 2 + close + 2, [
            cx.elt("WikiLinkText", start + 2, start + 2 + target.length),
          ]),
        );
      },
    },
    {
      name: "Hashtag",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== 35 /* # */) return -1;
        const before = pos > cx.offset ? cx.char(pos - 1) : -1;
        if (!isSpace(before) && before !== 40 /* ( */) return -1;
        const match = /^#[\p{L}\p{N}_/-]+/u.exec(cx.slice(pos, cx.end));
        if (!match || /^#\d+$/.test(match[0])) return -1;
        return cx.addElement(cx.elt("Hashtag", pos, pos + match[0].length));
      },
    },
    {
      name: "Highlight",
      after: "Emphasis",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== 61 /* = */ || cx.char(pos + 1) !== 61) return -1;
        if (cx.char(pos + 2) === 61) return -1;
        const before = pos > cx.offset ? cx.char(pos - 1) : -1;
        const after = cx.char(pos + 2);
        return cx.addDelimiter(
          HighlightDelimiter,
          pos,
          pos + 2,
          !isSpace(after),
          !isSpace(before),
        );
      },
    },
  ],
};

/** Class-based highlighting so the stylesheet owns every colour and size. */
export const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, class: "cm-header cm-header-1" },
  { tag: t.heading2, class: "cm-header cm-header-2" },
  { tag: t.heading3, class: "cm-header cm-header-3" },
  { tag: t.heading4, class: "cm-header cm-header-4" },
  { tag: t.heading5, class: "cm-header cm-header-5" },
  { tag: t.heading6, class: "cm-header cm-header-6" },
  { tag: t.strong, class: "cm-strong" },
  { tag: t.emphasis, class: "cm-em" },
  { tag: t.strikethrough, class: "cm-strikethrough" },
  { tag: t.monospace, class: "cm-code" },
  { tag: t.link, class: "cm-link" },
  { tag: t.url, class: "cm-url" },
  { tag: t.quote, class: "cm-quote" },
  { tag: t.processingInstruction, class: "cm-formatting" },
  { tag: t.labelName, class: "cm-meta" },
  { tag: t.contentSeparator, class: "cm-hr" },
  { tag: t.escape, class: "cm-formatting" },
  { tag: wikiTag, class: "cm-hmd-internal-link" },
  { tag: hashtagTag, class: "cm-hashtag" },
  { tag: highlightTag, class: "cm-highlight" },
  { tag: frontmatterTag, class: "cm-frontmatter" },
  // Embedded code languages.
  { tag: [t.comment, t.lineComment, t.blockComment], class: "cm-comment" },
  { tag: [t.keyword, t.modifier, t.operatorKeyword], class: "cm-keyword" },
  { tag: [t.string, t.special(t.string), t.regexp], class: "cm-string" },
  { tag: [t.number, t.bool, t.null, t.atom], class: "cm-number" },
  { tag: [t.typeName, t.className, t.namespace], class: "cm-type" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName)],
    class: "cm-function",
  },
  { tag: [t.propertyName, t.attributeName], class: "cm-property" },
  { tag: [t.tagName, t.angleBracket], class: "cm-tag" },
  { tag: [t.operator, t.punctuation], class: "cm-operator" },
  { tag: t.definition(t.variableName), class: "cm-def" },
]);

/** Languages already shipped with the Markdown package; loaded on first use. */
export const codeLanguages = [
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js", "jsx", "mjs", "cjs", "node"],
    load: () =>
      import("@codemirror/lang-javascript").then((m) =>
        m.javascript({ jsx: true }),
      ),
  }),
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["ts", "tsx"],
    load: () =>
      import("@codemirror/lang-javascript").then((m) =>
        m.javascript({ jsx: true, typescript: true }),
      ),
  }),
  LanguageDescription.of({
    name: "JSON",
    alias: ["json5"],
    load: () =>
      import("@codemirror/lang-javascript").then((m) => m.javascript()),
  }),
  LanguageDescription.of({
    name: "CSS",
    alias: ["scss", "less"],
    load: () => import("@codemirror/lang-css").then((m) => m.css()),
  }),
  LanguageDescription.of({
    name: "HTML",
    alias: ["xml", "svg", "vue"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  }),
  LanguageDescription.of({
    name: "Java",
    alias: ["jsp"],
    load: () => import("@codemirror/lang-java").then((m) => m.java()),
  }),
  LanguageDescription.of({
    name: "Python",
    alias: ["py"],
    load: () => import("@codemirror/lang-python").then((m) => m.python()),
  }),
  LanguageDescription.of({
    name: "SQL",
    alias: ["mysql", "postgres", "postgresql", "sqlite"],
    load: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  }),
  LanguageDescription.of({
    name: "Shell",
    alias: ["bash", "sh", "zsh", "shell"],
    load: () =>
      import("@codemirror/legacy-modes/mode/shell").then(
        (m) => new LanguageSupport(StreamLanguage.define(m.shell)),
      ),
  }),
  LanguageDescription.of({
    name: "PowerShell",
    alias: ["pwsh", "ps1"],
    load: () =>
      import("@codemirror/legacy-modes/mode/powershell").then(
        (m) => new LanguageSupport(StreamLanguage.define(m.powerShell)),
      ),
  }),
];
