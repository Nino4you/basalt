import { t } from "../i18n";
import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  Facet,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { repeatsTitle } from "../markdown";
import { calloutIcon } from "../ui/callouts";
import { icon } from "../ui/dom";

export interface LinkHost {
  /** Whether a `[[target]]` points at an existing note. */
  resolves(target: string): boolean;
  openLink(target: string, newTab: boolean): void;
  openExternal(url: string): void;
  openTag(tag: string): void;
  /** Show a page preview; `null` dismisses the pending or visible one. */
  previewLink?(target: string | null, anchor?: DOMRect): void;
}

export const linkHost = Facet.define<LinkHost, LinkHost | null>({
  combine: (values) => values[0] ?? null,
});

/** Dispatched when the vault's file list changes so link colours are recomputed. */
export const refreshLinks = StateEffect.define<null>();

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "list-bullet";
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-hr-widget";
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

/** The `[!type]` marker: the type's icon, plus its name when no title follows. */
class CalloutTitleWidget extends WidgetType {
  constructor(
    readonly type: string,
    readonly label: boolean,
  ) {
    super();
  }
  eq(other: CalloutTitleWidget) {
    return other.type === this.type && other.label === this.label;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-callout-marker";
    const holder = document.createElement("span");
    holder.className = "callout-icon";
    holder.append(icon(calloutIcon(this.type), 16));
    span.append(holder);
    if (this.label)
      span.append(this.type.charAt(0).toUpperCase() + this.type.slice(1));
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "task-list-label";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "task-list-item-checkbox";
    box.checked = this.checked;
    box.setAttribute("aria-label", t("Aufgabe umschalten"));
    box.addEventListener("mousedown", (event) => event.preventDefault());
    box.addEventListener("click", (event) => {
      event.preventDefault();
      const line = view.state.doc.lineAt(view.posAtDOM(wrap));
      const match = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)(.)\]/.exec(
        line.text,
      );
      if (!match) return;
      const at = line.from + match[1].length;
      view.dispatch({
        changes: { from: at, to: at + 1, insert: match[2] === " " ? "x" : " " },
        userEvent: "input.toggle",
      });
    });
    wrap.append(box);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });
const prefixMark = Decoration.mark({ class: "cm-list-prefix" });
const inlineCode = Decoration.mark({ class: "cm-inline-code" });
const linkText = Decoration.mark({ class: "cm-link-text" });
const internal = Decoration.mark({ class: "cm-internal-link" });
const unresolved = Decoration.mark({
  class: "cm-internal-link is-unresolved",
});
const lineDeco = new Map<string, Decoration>();
function lineClass(cls: string): Decoration {
  let deco = lineDeco.get(cls);
  if (!deco) lineDeco.set(cls, (deco = Decoration.line({ class: cls })));
  return deco;
}

const INLINE_MARKS = new Set([
  "EmphasisMark",
  "StrikethroughMark",
  "HighlightMark",
]);

function columns(text: string): number {
  let count = 0;
  for (const ch of text) count += ch === "\t" ? 4 : 1;
  return count;
}

/** Splits `[[target|alias]]` / `![[target]]` into its parts, relative to the node start. */
export function parseWikiLink(text: string): {
  target: string;
  embed: boolean;
  /** Range of the visible label inside `text`. */
  labelFrom: number;
  labelTo: number;
} {
  const embed = text.startsWith("!");
  const open = embed ? 3 : 2;
  const inner = text.slice(open, -2);
  const pipe = inner.indexOf("|");
  return {
    target: (pipe < 0 ? inner : inner.slice(0, pipe)).trim(),
    embed,
    labelFrom: pipe < 0 ? open : open + pipe + 1,
    labelTo: text.length - 2,
  };
}

function buildDecorations(view: EditorView, rendered: boolean): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const ranges: Range<Decoration>[] = [];
  const host = state.facet(linkHost);
  // An unfocused editor shows everything rendered, like a freshly opened note.
  const selection = view.hasFocus ? state.selection.ranges : [];
  const touches = (from: number, to: number) => {
    for (const range of selection)
      if (range.from <= to && range.to >= from) return true;
    return false;
  };
  const lineTouched = (pos: number) => {
    const line = doc.lineAt(pos);
    return touches(line.from, line.to);
  };
  const eachLine = (from: number, to: number, cls: string) => {
    let line = doc.lineAt(from);
    for (;;) {
      ranges.push(lineClass(cls).range(line.from));
      if (line.to >= to || line.number >= doc.lines) break;
      line = doc.line(line.number + 1);
    }
  };

  const tree = syntaxTree(state);
  for (const visible of view.visibleRanges) {
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter(ref) {
        const name = ref.name;
        const from = ref.from;
        const to = ref.to;
        if (name === "Frontmatter") {
          eachLine(from, to, "cm-frontmatter-line");
          return false;
        }
        if (name.startsWith("ATXHeading")) {
          const level = name.slice(10);
          ranges.push(
            lineClass(`HyperMD-header HyperMD-header-${level}`).range(
              doc.lineAt(from).from,
            ),
          );
          if (rendered && !lineTouched(from)) {
            const mark = ref.node.getChild("HeaderMark");
            if (mark && mark.from === from) {
              const end =
                doc.sliceString(mark.to, mark.to + 1) === " "
                  ? mark.to + 1
                  : mark.to;
              ranges.push(hide.range(mark.from, end));
            }
          }
          return;
        }
        if (name.startsWith("SetextHeading")) {
          eachLine(from, to, `HyperMD-header HyperMD-header-${name.slice(13)}`);
          return;
        }
        if (name === "FencedCode" || name === "CodeBlock") {
          const first = doc.lineAt(from);
          const last = doc.lineAt(to);
          for (let n = first.number; n <= last.number; n++) {
            let cls = "HyperMD-codeblock";
            if (n === first.number) cls += " HyperMD-codeblock-begin";
            if (n === last.number) cls += " HyperMD-codeblock-end";
            ranges.push(lineClass(cls).range(doc.line(n).from));
          }
          return;
        }
        if (name === "Blockquote") {
          const first = doc.lineAt(from);
          const callout = /^(\s*>\s*)\[!([\w-]+)\][+-]?[ \t]*/.exec(first.text);
          if (!callout) {
            eachLine(from, to, "HyperMD-quote");
            return;
          }
          const type = callout[2].toLowerCase();
          const last = doc.lineAt(Math.max(from, to - 1));
          for (let n = first.number; n <= last.number; n++) {
            let cls = "HyperMD-quote HyperMD-callout";
            if (n === first.number) cls += " HyperMD-callout-title";
            if (n === last.number) cls += " HyperMD-callout-last";
            ranges.push(
              Decoration.line({
                class: cls,
                attributes: { "data-callout": type },
              }).range(doc.line(n).from),
            );
          }
          if (rendered && !touches(first.from, first.to)) {
            const markerFrom = first.from + callout[1].length;
            const markerTo = first.from + callout[0].length;
            // Without an explicit title the type name stands in for it.
            ranges.push(
              Decoration.replace({
                widget: new CalloutTitleWidget(type, markerTo >= first.to),
              }).range(markerFrom, markerTo),
            );
          }
          return;
        }
        if (name === "QuoteMark") {
          if (rendered && !lineTouched(from)) {
            const end = doc.sliceString(to, to + 1) === " " ? to + 1 : to;
            ranges.push(hide.range(from, end));
          }
          return;
        }
        if (name === "Table") {
          eachLine(from, to, "HyperMD-table-row");
          return;
        }
        if (name === "HorizontalRule") {
          if (rendered && !lineTouched(from)) ranges.push(rule.range(from, to));
          return;
        }
        if (name === "ListItem") {
          const mark = ref.node.getChild("ListMark");
          if (!mark) return;
          const line = doc.lineAt(mark.from);
          const task = ref.node.getChild("Task")?.getChild("TaskMarker");
          const ordered = ref.node.parent?.name === "OrderedList";
          let contentStart = mark.to;
          if (doc.sliceString(contentStart, contentStart + 1) === " ")
            contentStart++;
          let cols = columns(doc.sliceString(line.from, contentStart));
          let cls = "HyperMD-list-line";
          if (task && task.from >= mark.to && task.to <= line.to) {
            const checked =
              doc.sliceString(task.from + 1, task.from + 2) !== " ";
            cls += checked
              ? " HyperMD-task-line is-checked"
              : " HyperMD-task-line";
            let afterTask = task.to;
            if (doc.sliceString(afterTask, afterTask + 1) === " ") afterTask++;
            if (rendered && !touches(mark.from, task.to)) {
              ranges.push(
                Decoration.replace({
                  widget: new CheckboxWidget(checked),
                }).range(mark.from, task.to),
              );
              // The checkbox widget is two columns wide.
              cols = columns(doc.sliceString(line.from, mark.from)) + 3;
            } else cols = columns(doc.sliceString(line.from, afterTask));
            contentStart = afterTask;
          } else if (!ordered && rendered && !touches(mark.from, mark.to)) {
            ranges.push(bullet.range(mark.from, mark.to));
          }
          if (contentStart > line.from)
            ranges.push(prefixMark.range(line.from, contentStart));
          ranges.push(
            Decoration.line({
              class: cls,
              attributes: { style: `--list-cols:${cols}` },
            }).range(line.from),
          );
          return;
        }
        if (name === "InlineCode") {
          ranges.push(inlineCode.range(from, to));
          if (rendered && !touches(from, to)) {
            const node = ref.node;
            const open = node.firstChild;
            const close = node.lastChild;
            if (
              open?.name === "CodeMark" &&
              close?.name === "CodeMark" &&
              open !== close
            ) {
              ranges.push(hide.range(open.from, open.to));
              ranges.push(hide.range(close.from, close.to));
            }
          }
          return false;
        }
        if (INLINE_MARKS.has(name)) {
          const parent = ref.node.parent;
          if (rendered && parent && !touches(parent.from, parent.to))
            ranges.push(hide.range(from, to));
          return;
        }
        if (name === "Escape") {
          // `\[` shows as `[` unless the cursor is right there.
          if (rendered && !touches(from, to))
            ranges.push(hide.range(from, from + 1));
          return;
        }
        if (name === "Link") {
          const node = ref.node;
          const url = node.getChild("URL");
          const marks = node.getChildren("LinkMark");
          if (!url || marks.length < 2) return;
          const open = marks[0];
          const close = marks[1];
          if (close.from > open.to)
            ranges.push(linkText.range(open.to, close.from));
          if (rendered && !touches(from, to)) {
            ranges.push(hide.range(open.from, open.to));
            ranges.push(hide.range(close.from, to));
          }
          return false;
        }
        if (name === "WikiLink") {
          const text = doc.sliceString(from, to);
          const link = parseWikiLink(text);
          const ok = !host || host.resolves(link.target);
          const deco = ok ? internal : unresolved;
          if (rendered && !touches(from, to)) {
            if (link.labelFrom > 0)
              ranges.push(hide.range(from, from + link.labelFrom));
            if (link.labelTo > link.labelFrom)
              ranges.push(
                deco.range(from + link.labelFrom, from + link.labelTo),
              );
            ranges.push(hide.range(from + link.labelTo, to));
          } else ranges.push(deco.range(from, to));
          return false;
        }
      },
    });
  }
  return Decoration.set(ranges, true);
}

/** Bumped by the mode compartment: live preview hides syntax, source mode keeps it. */
export const renderedFacet = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? true,
});

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(
        view,
        view.state.facet(renderedFacet),
      );
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        update.startState.facet(renderedFacet) !==
          update.state.facet(renderedFacet) ||
        update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(refreshLinks)),
        )
      )
        this.decorations = buildDecorations(
          update.view,
          update.state.facet(renderedFacet),
        );
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export interface LinkAt {
  kind: "internal" | "external" | "tag";
  value: string;
  from: number;
  to: number;
}

export function linkAt(state: EditorState, pos: number): LinkAt | null {
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
    for (; node; node = node.parent) {
      if (node.name === "WikiLink")
        return {
          kind: "internal",
          value: parseWikiLink(state.doc.sliceString(node.from, node.to))
            .target,
          from: node.from,
          to: node.to,
        };
      if (node.name === "Hashtag")
        return {
          kind: "tag",
          value: state.doc.sliceString(node.from + 1, node.to),
          from: node.from,
          to: node.to,
        };
      if (node.name === "Link" || node.name === "Autolink") {
        const url = node.getChild("URL");
        if (!url) continue;
        const value = state.doc.sliceString(url.from, url.to);
        return {
          kind: /^[a-z][a-z0-9+.-]*:/i.test(value) ? "external" : "internal",
          value: /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : safeDecode(value),
          from: node.from,
          to: node.to,
        };
      }
      if (node.name === "URL" && node.parent?.name !== "Link") {
        const value = state.doc.sliceString(node.from, node.to);
        if (/^https?:/i.test(value))
          return { kind: "external", value, from: node.from, to: node.to };
      }
    }
  }
  return null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function follow(view: EditorView, link: LinkAt, newTab: boolean): void {
  const host = view.state.facet(linkHost);
  if (!host) return;
  if (link.kind === "internal") host.openLink(link.value, newTab);
  else if (link.kind === "tag") host.openTag(link.value);
  else host.openExternal(link.value);
}

/**
 * Rendered links follow on a plain click; a link under the cursor (shown as
 * source) needs Ctrl/Cmd, exactly like Obsidian's live preview.
 */
const LINK_SELECTOR =
  ".cm-internal-link, .cm-link-text, .cm-url, .cm-hashtag, .cm-hmd-internal-link";

/** Hover previews stay in the host so reading view and editor share one card. */
export const linkPreviews = EditorView.domEventHandlers({
  mouseover(event, view) {
    const host = view.state.facet(linkHost);
    const element = event.target as HTMLElement | null;
    if (!host?.previewLink || !element?.closest?.(LINK_SELECTOR)) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const link = linkAt(view.state, pos);
    if (link?.kind === "internal")
      host.previewLink(link.value, element.getBoundingClientRect());
    return false;
  },
  mouseout(event, view) {
    const host = view.state.facet(linkHost);
    const element = event.target as HTMLElement | null;
    if (!host?.previewLink || !element?.closest?.(LINK_SELECTOR)) return false;
    const next = event.relatedTarget as Node | null;
    if (!next || !element.closest(LINK_SELECTOR)?.contains(next))
      host.previewLink(null);
    return false;
  },
  mouseleave(_event, view) {
    view.state.facet(linkHost)?.previewLink?.(null);
    return false;
  },
});

export const linkClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 && event.button !== 1) return false;
    const target = event.target as HTMLElement;
    if (
      !target.closest?.(
        ".cm-internal-link, .cm-link-text, .cm-url, .cm-hashtag, .cm-hmd-internal-link",
      )
    )
      return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const link = linkAt(view.state, pos);
    if (!link) return false;
    const mod = event.ctrlKey || event.metaKey;
    const editing =
      view.hasFocus &&
      view.state.selection.ranges.some(
        (range) => range.from <= link.to && range.to >= link.from,
      );
    const sourceMode = !view.state.facet(renderedFacet);
    if ((editing || sourceMode) && !mod && event.button === 0) return false;
    event.preventDefault();
    follow(view, link, mod || event.button === 1);
    return true;
  },
});

/** Read-only note title shown above the first line, like Obsidian's inline title. */
class TitleWidget extends WidgetType {
  constructor(readonly title: string) {
    super();
  }
  eq(other: TitleWidget) {
    return other.title === this.title;
  }
  toDOM() {
    const node = document.createElement("div");
    node.className = "inline-title";
    node.textContent = this.title;
    return node;
  }
  ignoreEvent() {
    return true;
  }
}

export const setInlineTitle = StateEffect.define<string | null>();

/** The note head that can hold frontmatter plus the first heading. */
const TITLE_HEAD = 4096;

function titleDecorations(
  state: EditorState,
  title: string | null,
): DecorationSet {
  if (title === null || repeatsTitle(state.sliceDoc(0, TITLE_HEAD), title))
    return Decoration.none;
  return Decoration.set([
    Decoration.widget({
      widget: new TitleWidget(title),
      side: -1,
      block: true,
    }).range(0),
  ]);
}

export const inlineTitle = StateField.define<{
  title: string | null;
  decorations: DecorationSet;
}>({
  create: () => ({ title: null, decorations: Decoration.none }),
  update(value, tr) {
    let title = value.title;
    for (const effect of tr.effects)
      if (effect.is(setInlineTitle)) title = effect.value;
    if (title === value.title && !tr.docChanged) return value;
    // An opening `# Title` already names the note; do not show it twice.
    return { title, decorations: titleDecorations(tr.state, title) };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});
