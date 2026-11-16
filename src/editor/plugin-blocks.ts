import { syntaxTree } from "@codemirror/language";
import {
  Facet,
  type EditorState,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  type DecorationSet,
  Decoration,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { Component } from "../compat/component";
import { renderedFacet } from "./live-preview";

export type CodeBlockProcessor = (
  source: string,
  el: HTMLElement,
  info: Record<string, unknown>,
) => unknown;

export interface CodeBlockHost {
  processor(language: string): CodeBlockProcessor | undefined;
  context(): { sourcePath: string; app: unknown } | null;
}

export const codeBlockHost = Facet.define<CodeBlockHost, CodeBlockHost | null>({
  combine: (values) => values[0] ?? null,
});

/** Plugins can be enabled while a note is open; ask the view to re-read them. */
export const refreshCodeBlocks = StateEffect.define<null>();

class PluginBlockWidget extends WidgetType {
  private owner: Component | null = null;
  constructor(
    private readonly language: string,
    private readonly source: string,
    private readonly processor: CodeBlockProcessor,
    private readonly context: { sourcePath: string; app: unknown },
  ) {
    super();
  }

  eq(other: PluginBlockWidget): boolean {
    return (
      other.language === this.language &&
      other.source === this.source &&
      other.processor === this.processor &&
      other.context.sourcePath === this.context.sourcePath &&
      other.context.app === this.context.app
    );
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = `plugin-codeblock language-${this.language}`;
    const owner = new Component();
    this.owner = owner;
    owner.load();
    // Mount before the processor runs: plugins measure their canvas in load().
    const frame = requestAnimationFrame(() => {
      void this.paint(container, owner);
    });
    owner.register(() => cancelAnimationFrame(frame));
    return container;
  }

  private async paint(container: HTMLElement, owner: Component): Promise<void> {
    try {
      await this.processor(this.source, container, {
        sourcePath: this.context.sourcePath,
        app: this.context.app,
        getSectionInfo: () => null,
        addChild: (child: Component) => {
          if (this.owner === owner) owner.addChild(child);
          else
            void child
              .unloadAsync()
              .catch((error) =>
                console.warn("Stale plugin code block cleanup failed", error),
              );
        },
      });
    } catch (error) {
      if (this.owner === null) return;
      container.classList.add("plugin-codeblock-error");
      container.textContent = `Plugin-Codeblock „${this.language}“ konnte nicht gerendert werden: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  destroy(): void {
    const owner = this.owner;
    this.owner = null;
    void owner
      ?.unloadAsync()
      .catch((error) =>
        console.warn("Plugin code block cleanup failed", error),
      );
  }
}

/** A block widget must cover whole lines; indented fences keep their source. */
function lineAligned(state: EditorState, from: number, to: number): boolean {
  return state.doc.lineAt(from).from === from && state.doc.lineAt(to).to === to;
}

function buildDecorations(state: EditorState): DecorationSet {
  const host = state.facet(codeBlockHost);
  if (!host || !state.facet(renderedFacet)) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "FencedCode") return;
      if (node.node.parent?.name !== "Document") return;
      if (!lineAligned(state, node.from, node.to)) return;
      const info = node.node.getChild("CodeInfo");
      const language = info
        ? state.sliceDoc(info.from, info.to).trim().split(/\s+/)[0]
        : "";
      const processor = language ? host.processor(language) : undefined;
      if (!processor) return;
      const text = node.node.getChild("CodeText");
      const widget = new PluginBlockWidget(
        language,
        text ? state.sliceDoc(text.from, text.to) : "",
        processor,
        host.context() ?? { sourcePath: "", app: undefined },
      );
      ranges.push(
        Decoration.replace({ widget, block: true }).range(node.from, node.to),
      );
    },
  });
  return Decoration.set(ranges, true);
}

export const pluginBlocks = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update(decorations, tr) {
    if (
      tr.docChanged ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state) ||
      tr.startState.facet(renderedFacet) !== tr.state.facet(renderedFacet) ||
      tr.startState.facet(codeBlockHost) !== tr.state.facet(codeBlockHost) ||
      tr.effects.some((effect) => effect.is(refreshCodeBlocks))
    )
      return buildDecorations(tr.state);
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});
