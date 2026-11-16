import { syntaxTree } from "@codemirror/language";
import {
  Facet,
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
import { Component } from "../compat/component";
import { mountPluginEmbed, type PluginEmbed } from "../compat/embeds";
import { parseWikiLink, renderedFacet } from "./live-preview";
import { refreshCodeBlocks } from "./plugin-blocks";

type EmbedResolver = (target: string) => PluginEmbed | null;
export const embedHost = Facet.define<EmbedResolver, EmbedResolver>({
  combine: (values) => values[0] ?? (() => null),
});

class EmbedWidget extends WidgetType {
  private owner: Component | null = null;
  constructor(private readonly embed: PluginEmbed) {
    super();
  }
  eq(other: EmbedWidget): boolean {
    return (
      other.embed.factory === this.embed.factory &&
      other.embed.file === this.embed.file &&
      other.embed.subpath === this.embed.subpath
    );
  }
  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "internal-embed plugin-embed";
    const owner = (this.owner = new Component());
    owner.load();
    const frame = requestAnimationFrame(() => {
      void mountPluginEmbed(this.embed, container, owner).catch((error) => {
        if (this.owner !== owner) return;
        container.textContent = `Einbettung konnte nicht geladen werden: ${error instanceof Error ? error.message : String(error)}`;
      });
    });
    owner.register(() => cancelAnimationFrame(frame));
    return container;
  }
  destroy(): void {
    const owner = this.owner;
    this.owner = null;
    void owner
      ?.unloadAsync()
      .catch((error) => console.warn("Plugin embed cleanup failed", error));
  }
}

function build(state: EditorState): DecorationSet {
  if (!state.facet(renderedFacet)) return Decoration.none;
  const resolve = state.facet(embedHost);
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (
        node.name !== "WikiLink" ||
        node.node.parent?.name !== "Paragraph" ||
        node.node.parent.parent?.name !== "Document"
      )
        return;
      const line = state.doc.lineAt(node.from);
      if (line.from !== node.from || line.to !== node.to) return;
      const link = parseWikiLink(state.sliceDoc(node.from, node.to));
      if (!link?.embed) return;
      const embed = resolve(link.target);
      if (embed)
        ranges.push(
          Decoration.replace({
            widget: new EmbedWidget(embed),
            block: true,
          }).range(node.from, node.to),
        );
    },
  });
  return Decoration.set(ranges, true);
}

export const pluginEmbeds = StateField.define<DecorationSet>({
  create: build,
  update(decorations, tr) {
    return tr.docChanged ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state) ||
      tr.startState.facet(renderedFacet) !== tr.state.facet(renderedFacet) ||
      tr.effects.some((effect) => effect.is(refreshCodeBlocks))
      ? build(tr.state)
      : decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});
