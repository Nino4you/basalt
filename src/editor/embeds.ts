import { t } from "../i18n";
import { syntaxTree } from "@codemirror/language";
import {
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { icon } from "../ui/dom";
import { parseWikiLink, refreshLinks, renderedFacet } from "./live-preview";
import { embedHost } from "./plugin-embeds";
import { refreshCodeBlocks } from "./plugin-blocks";

/** One `![[target|alias]]` or `![alt](src)` in the note. */
export interface EmbedSource {
  target: string;
  alias: string;
  /** A Markdown image (`![alt](src)`) rather than a wiki embed. */
  markdown: boolean;
}

export interface EmbedDescription {
  kind: "image" | "media" | "note";
  /**
   * Changes whenever the rendered result would: compared with `===`, so
   * passing the embedded note's text is cheap when it did not change.
   */
  version: string;
}

export interface EmbedPreviewHost {
  /** What an embed shows, or null to leave it a link (unresolved, unsupported). */
  describe(embed: EmbedSource): EmbedDescription | null;
  /**
   * Renders the embed into `el` and returns its cleanup. `onResize` tells
   * the editor that the content changed its height after loading.
   */
  render(embed: EmbedSource, el: HTMLElement, onResize: () => void): () => void;
}

export const embedPreviewHost = Facet.define<
  EmbedPreviewHost,
  EmbedPreviewHost | null
>({
  combine: (values) => values[0] ?? null,
});

/** Lets the next selection reveal sources again after a widget was clicked. */
const setEditing = StateEffect.define<boolean>();

interface Item extends EmbedSource {
  from: number;
  to: number;
  /** The embed is alone on its line and replaces the whole line. */
  block: boolean;
  lineFrom: number;
  lineTo: number;
  description: EmbedDescription;
}

class EmbedPreviewWidget extends WidgetType {
  private cleanup: (() => void) | null = null;

  constructor(
    readonly item: Item,
    readonly host: EmbedPreviewHost,
  ) {
    super();
  }

  eq(other: EmbedPreviewWidget): boolean {
    const a = this.item;
    const b = other.item;
    return (
      a.target === b.target &&
      a.alias === b.alias &&
      a.markdown === b.markdown &&
      a.block === b.block &&
      a.description.kind === b.description.kind &&
      a.description.version === b.description.version &&
      this.host === other.host
    );
  }

  get estimatedHeight(): number {
    return this.item.block ? 120 : -1;
  }

  toDOM(view: EditorView): HTMLElement {
    const { item } = this;
    const dom = document.createElement(item.block ? "div" : "span");
    dom.className = `cm-embed-preview cm-embed-${item.description.kind}${
      item.block ? " is-block" : " is-inline"
    } markdown-rendered`;
    dom.contentEditable = "false";
    const reveal = () => {
      const at = view.posAtDOM(dom);
      // Put the cursor before the closing `]]` / `)` of the embed source.
      const end = Math.min(
        view.state.doc.length,
        at + (item.to - item.from) - (item.markdown ? 1 : 2),
      );
      view.dispatch({
        selection: { anchor: end },
        effects: setEditing.of(true),
      });
      view.focus();
    };
    if (item.block) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "cm-embed-edit clickable-icon";
      edit.setAttribute("aria-label", t("Einbettung bearbeiten"));
      edit.title = t("Einbettung bearbeiten");
      edit.append(icon("code-xml", 14));
      edit.addEventListener("mousedown", (event) => event.preventDefault());
      edit.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        reveal();
      });
      dom.append(edit);
    }
    // Images reveal their source on a click, like Obsidian; note embeds keep
    // clicks for their links and text selection.
    if (item.description.kind === "image")
      dom.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest("a, button")) return;
        event.preventDefault();
        reveal();
      });
    const body = document.createElement(item.block ? "div" : "span");
    body.className = "cm-embed-body";
    dom.append(body);
    this.cleanup = this.host.render(
      { target: item.target, alias: item.alias, markdown: item.markdown },
      body,
      () => view.requestMeasure(),
    );
    return dom;
  }

  destroy(): void {
    const cleanup = this.cleanup;
    this.cleanup = null;
    cleanup?.();
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** Walks the whole tree, so it only runs when the document or its parse changes. */
function collect(state: EditorState): Item[] {
  if (!state.facet(renderedFacet)) return [];
  const host = state.facet(embedPreviewHost);
  if (!host) return [];
  const plugin = state.facet(embedHost);
  const items: Item[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      // Tables render their cells themselves.
      if (node.name === "Table" || node.name === "FencedCode") return false;
      let source: EmbedSource | null = null;
      if (node.name === "WikiLink") {
        const text = state.sliceDoc(node.from, node.to);
        if (!text.startsWith("!")) return false;
        const link = parseWikiLink(text);
        source = {
          target: link.target,
          alias:
            link.labelFrom > 3 ? text.slice(link.labelFrom, link.labelTo) : "",
          markdown: false,
        };
        // Embeds that a plugin renders stay with the plugin.
        if (plugin(link.target)) return false;
      } else if (node.name === "Image") {
        const url = node.node.getChild("URL");
        const marks = node.node.getChildren("LinkMark");
        if (!url || marks.length < 2) return false;
        let target = state.sliceDoc(url.from, url.to);
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
        try {
          target = decodeURIComponent(target);
        } catch {
          // Keep the literal path.
        }
        source = {
          target,
          alias: state.sliceDoc(marks[0].to, marks[1].from),
          markdown: true,
        };
      } else return;
      const description = host.describe(source);
      if (!description) return false;
      const line = state.doc.lineAt(node.from);
      const parent = node.node.parent;
      const block =
        line.from === node.from &&
        line.to === node.to &&
        parent?.name === "Paragraph" &&
        parent.parent?.name === "Document";
      // Only images flow inside text; notes and media need a line of their own.
      if (!block && description.kind !== "image") return false;
      items.push({
        ...source,
        from: node.from,
        to: node.to,
        block,
        lineFrom: line.from,
        lineTo: line.to,
        description,
      });
      return false;
    },
  });
  return items;
}

function decorations(
  state: EditorState,
  items: readonly Item[],
  editing: boolean,
): DecorationSet {
  const host = state.facet(embedPreviewHost);
  if (!host) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (const item of items) {
    const from = item.block ? item.lineFrom : item.from;
    const to = item.block ? item.lineTo : item.to;
    const touched =
      editing &&
      state.selection.ranges.some((r) => r.from <= to && r.to >= from);
    const widget = new EmbedPreviewWidget(item, host);
    if (!touched)
      ranges.push(
        Decoration.replace({ widget, block: item.block }).range(from, to),
      );
    // While its line is edited, a block embed stays visible below the source.
    else if (item.block)
      ranges.push(
        Decoration.widget({ widget, block: true, side: 1 }).range(to),
      );
  }
  return Decoration.set(ranges, true);
}

interface EmbedState {
  editing: boolean;
  items: readonly Item[];
  decorations: DecorationSet;
}

const embedState = StateField.define<EmbedState>({
  create(state) {
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
      if (effect.is(setEditing)) editing = effect.value;
    const items =
      tr.docChanged ||
      tr.reconfigured ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState) ||
      tr.effects.some(
        (effect) => effect.is(refreshLinks) || effect.is(refreshCodeBlocks),
      )
        ? collect(tr.state)
        : value.items;
    if (items === value.items && editing === value.editing && !tr.selection)
      return value;
    return {
      editing,
      items,
      decorations: decorations(tr.state, items, editing),
    };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});

/** Image, media and note embeds rendered inside live preview. */
export const embedPreviews = embedState;
