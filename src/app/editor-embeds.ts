import { TFile } from "../compat/files";
import { IMAGE_TYPES, MEDIA_TYPES } from "../attachments";
import type {
  EmbedDescription,
  EmbedPreviewHost,
  EmbedSource,
} from "../editor/embeds";
import { splitTarget } from "../subpath";
import { extension, h } from "../ui/dom";
import { RenderScope, type RenderHost } from "./embed-render";
import { enhanceMath, enhanceMermaid } from "./rich-content";

export interface EmbedPreviewApp extends RenderHost {
  readonly index: RenderHost["index"] & { has(path: string): boolean };
  readonly activePath: string | null;
  openLink(target: string, source: string, newTab?: boolean): void;
  openExternal(url: string): void;
  searchFor(query: string): void;
}

/**
 * Live preview embeds, rendered by the same `RenderScope` as the reading
 * view so both show images, media, notes and sections alike.
 */
export function createEmbedPreviewHost(app: EmbedPreviewApp): EmbedPreviewHost {
  const imageVersion = (path: string): string => {
    const file = app.compatibility?.vault.getAbstractFileByPath(path);
    return file instanceof TFile
      ? `${path}\0${file.stat.size}\0${file.stat.mtime}`
      : path;
  };
  return {
    describe(embed: EmbedSource): EmbedDescription | null {
      const source = app.activePath;
      if (!source) return null;
      if (embed.markdown) {
        const path = app.index.resolve(embed.target, source) ?? embed.target;
        if (!IMAGE_TYPES[extension(path)] || !app.index.has(path)) return null;
        return { kind: "image", version: imageVersion(path) };
      }
      const resolved = app.index.resolve(embed.target, source);
      if (!resolved) return null;
      const type = extension(resolved);
      if (IMAGE_TYPES[type])
        return { kind: "image", version: imageVersion(resolved) };
      if (MEDIA_TYPES[type])
        // Media need the binary bridge, which the browser demo lacks.
        return app.compatibility
          ? { kind: "media", version: imageVersion(resolved) }
          : null;
      if (type !== "md") return null;
      const { subpath } = splitTarget(embed.target);
      // A note cannot show itself whole inside itself.
      if (resolved === source && !subpath) return null;
      const text = app.index.content(resolved);
      return text === undefined ? null : { kind: "note", version: text };
    },

    render(embed: EmbedSource, el: HTMLElement, onResize: () => void) {
      const source = app.activePath ?? "";
      const scope = new RenderScope(app, onResize);
      el.append(
        embed.markdown
          ? h("img", { attrs: { alt: embed.alias, src: embed.target } })
          : h("a", {
              class: "internal-link is-embed",
              attrs: { href: "#" },
              data: { note: embed.target },
              text: `↗ ${embed.alias || embed.target}`,
            }),
      );
      scope.decorate(el, source);
      const alive = () => scope.alive;
      enhanceMath(el, alive, onResize);
      enhanceMermaid(el, alive, onResize);
      const click = (event: MouseEvent) => {
        const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(
          "a",
        );
        if (!link || !el.contains(link)) return;
        event.preventDefault();
        event.stopPropagation();
        // Footnote references only make sense inside the full note.
        if (link.dataset.footnoteRef || link.dataset.footnoteBack) return;
        const newTab = event.ctrlKey || event.metaKey || event.button === 1;
        if (link.dataset.tag) app.searchFor(`tag:#${link.dataset.tag}`);
        else if (link.dataset.note !== undefined)
          app.openLink(
            link.dataset.note,
            link.dataset.source ?? source,
            newTab,
          );
        else {
          const href = link.getAttribute("href") ?? "";
          if (href && !href.startsWith("#")) app.openExternal(href);
        }
      };
      el.addEventListener("click", click);
      return () => {
        el.removeEventListener("click", click);
        scope.dispose();
      };
    },
  };
}
