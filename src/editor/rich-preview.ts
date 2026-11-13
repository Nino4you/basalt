import { syntaxTree } from "@codemirror/language";
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { enhanceMath, enhanceMermaid } from "../app/rich-content";
import { renderedFacet } from "./live-preview";
import { codeBlockHost, refreshCodeBlocks } from "./plugin-blocks";
import { parseTableSource, type TableSource } from "./table-model";
import { TableWidget, tableCellEditing } from "./table-widget";

const sourceEditing = StateEffect.define<boolean>();
const alive = new WeakSet<HTMLElement>();
const frames = new WeakMap<HTMLElement, number>();

class RichWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly kind: "math" | "mermaid",
    readonly block: boolean,
  ) {
    super();
  }
  eq(other: RichWidget): boolean {
    return (
      this.source === other.source &&
      this.kind === other.kind &&
      this.block === other.block
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement(this.block ? "div" : "span");
    dom.className = `cm-rich-preview cm-rich-${this.kind} markdown-rendered`;
    dom.tabIndex = 0;
    dom.setAttribute("role", "button");
    dom.setAttribute(
      "aria-label",
      this.kind === "math" ? "Formel bearbeiten" : "Diagramm bearbeiten",
    );
    const edit = () => {
      const from = view.posAtDOM(dom);
      view.dispatch({
        selection: {
          anchor: Math.min(
            view.state.doc.length,
            from +
              (this.kind === "math"
                ? this.source.startsWith("$$")
                  ? 2
                  : 1
                : 11),
          ),
        },
        effects: sourceEditing.of(true),
      });
      view.focus();
    };
    dom.addEventListener("click", edit);
    dom.addEventListener("keydown", (event) => {
      if (
        event instanceof KeyboardEvent &&
        (event.key === "Enter" || event.key === " ")
      ) {
        event.preventDefault();
        event.stopPropagation();
        edit();
      }
    });
    if (this.kind === "math") dom.textContent = this.source;
    else {
      const pre = document.createElement("pre"),
        code = document.createElement("code");
      code.className = "language-mermaid";
      code.textContent = this.source
        .replace(/^\s*[`~]{3,}mermaid[^\n]*\n/, "")
        .replace(/\n[`~]{3,}\s*$/, "");
      pre.append(code);
      dom.append(pre);
    }
    alive.add(dom);
    frames.set(
      dom,
      requestAnimationFrame(() => {
        if (!alive.has(dom)) return;
        const current = () => alive.has(dom);
        const settled = () => view.requestMeasure();
        if (this.kind === "math") enhanceMath(dom, current, settled);
        else enhanceMermaid(dom, current, settled);
      }),
    );
    return dom;
  }
  destroy(dom: HTMLElement): void {
    alive.delete(dom);
    cancelAnimationFrame(frames.get(dom) ?? 0);
  }
  ignoreEvent(): boolean {
    return true;
  }
}

type RichItem =
  | { kind: "table"; from: number; to: number; table: TableSource }
  | {
      kind: "math" | "mermaid";
      from: number;
      to: number;
      source: string;
      block: boolean;
    };

/** Walks the whole tree, so it only runs when the document or its parse changes. */
function collect(state: EditorState): RichItem[] {
  if (!state.facet(renderedFacet)) return [];
  const items: RichItem[] = [];
  const host = state.facet(codeBlockHost);
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Table") {
        const table = parseTableSource(
          state.sliceDoc(node.from, node.to),
          node.from,
        );
        if (
          table &&
          state.doc.lineAt(node.from).from === node.from &&
          state.doc.lineAt(node.to).to === node.to
        )
          items.push({ kind: "table", from: node.from, to: node.to, table });
        return false;
      }
      const math = node.name === "InlineMath" || node.name === "BlockMath";
      const mermaid =
        node.name === "FencedCode" &&
        state.sliceDoc(node.from, node.to).match(/^\s*[`~]{3,}mermaid\s*\n/);
      if (!math && !mermaid) return;
      if (mermaid && host?.processor("mermaid")) return false;
      if (node.node.parent?.name === "TableCell") return false;
      const block =
        state.doc.lineAt(node.from).from === node.from &&
        state.doc.lineAt(node.to).to === node.to &&
        (node.name === "BlockMath" || !!mermaid);
      if (mermaid && !block) return;
      // shortcut: nested multiline display math stays source until container-aware rendering exists.
      if (
        node.name === "BlockMath" &&
        !block &&
        state.sliceDoc(node.from, node.to).includes("\n")
      )
        return false;
      items.push({
        kind: math ? "math" : "mermaid",
        from: node.from,
        to: node.to,
        source: state.sliceDoc(node.from, node.to),
        block,
      });
      return false;
    },
  });
  return items;
}

/** Cheap per selection change: widgets touched by an editing selection show source. */
function decorations(
  state: EditorState,
  items: readonly RichItem[],
  editing: boolean,
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const item of items) {
    if (item.kind === "table") {
      ranges.push(
        Decoration.replace({
          widget: new TableWidget(item.table),
          block: true,
        }).range(item.from, item.to),
      );
      continue;
    }
    if (
      editing &&
      state.selection.ranges.some((r) => r.from <= item.to && r.to >= item.from)
    )
      continue;
    ranges.push(
      Decoration.replace({
        widget: new RichWidget(item.source, item.kind, item.block),
        block: item.block,
      }).range(item.from, item.to),
    );
  }
  return Decoration.set(ranges, true);
}

const richState = StateField.define<{
  editing: boolean;
  items: readonly RichItem[];
  decorations: DecorationSet;
}>({
  create: (state) => {
    const items = collect(state);
    return {
      editing: false,
      items,
      decorations: decorations(state, items, false),
    };
  },
  update(value, tr) {
    let editing = tr.selection ? true : value.editing;
    for (const effect of tr.effects)
      if (effect.is(sourceEditing)) editing = effect.value;
    const items =
      tr.docChanged ||
      tr.reconfigured ||
      tr.effects.some((e) => e.is(refreshCodeBlocks)) ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
        ? collect(tr.state)
        : value.items;
    if (
      items !== value.items ||
      tr.selection ||
      tr.effects.some((e) => e.is(sourceEditing))
    )
      return {
        editing,
        items,
        decorations: decorations(tr.state, items, editing),
      };
    return value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});

export function finishRichSource(view: EditorView): boolean {
  const rich = view.state.field(richState, false);
  if (!rich?.editing) return false;
  let active = false;
  const rendered = decorations(view.state, rich.items, false);
  for (const range of view.state.selection.ranges)
    rendered.between(range.from, range.to, (_from, _to, decoration) => {
      if (decoration.spec.widget instanceof RichWidget) active = true;
    });
  if (!active) return false;
  view.dispatch({ effects: sourceEditing.of(false) });
  return true;
}

export const richPreview: Extension = [
  tableCellEditing,
  richState,
  EditorView.atomicRanges.of((view) =>
    view.state.field(richState).decorations.update({
      filter: (_from, _to, decoration) =>
        decoration.spec.widget instanceof TableWidget,
    }),
  ),
];
