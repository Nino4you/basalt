import { Component } from "./component";
import { mountPluginEmbed, type EmbedRegistry } from "./embeds";
import type { PluginServices } from "./plugin-services";

export interface PluginRenderContext {
  sourcePath: string;
  app: unknown;
  embeds?: EmbedRegistry;
  addChild(child: Component): void;
}

/**
 * Run registered Markdown post processors and code-block processors against an
 * already rendered preview. `isCurrent` is checked after every asynchronous
 * step so a stale render cannot replace elements from a newer note.
 */
export async function renderPluginMarkdown(
  preview: HTMLElement,
  services: PluginServices,
  context: PluginRenderContext,
  isCurrent: () => boolean,
): Promise<void> {
  const registerChild = (child: Component): void => {
    if (isCurrent()) context.addChild(child);
    else
      void child
        .unloadAsync()
        .catch((error) => console.warn("Stale render cleanup failed", error));
  };
  for (const link of preview.querySelectorAll<HTMLAnchorElement>(
    "a.internal-link.is-embed[data-note]",
  )) {
    if (!isCurrent()) return;
    const embed = context.embeds?.resolve(
      link.dataset.note!,
      link.dataset.source ?? context.sourcePath,
    );
    if (!embed) continue;
    const container = document.createElement("div");
    container.className = "internal-embed plugin-embed";
    const paragraph = link.parentElement;
    if (paragraph?.tagName === "P" && paragraph.childNodes.length === 1)
      paragraph.replaceWith(container);
    else link.replaceWith(container);
    const owner = new Component();
    registerChild(owner);
    try {
      await mountPluginEmbed(embed, container, owner);
    } catch (error) {
      if (!isCurrent()) return;
      container.textContent = `Einbettung konnte nicht geladen werden: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  for (const handler of services.getMarkdownPostProcessors()) {
    if (!isCurrent()) return;
    if (typeof handler !== "function") continue;
    try {
      await (
        handler as (el: HTMLElement, ctx: Record<string, unknown>) => unknown
      )(preview, {
        containerEl: preview,
        sourcePath: context.sourcePath,
        frontmatter: {},
        getSectionInfo: () => null,
        addChild: registerChild,
      });
    } catch (error) {
      console.warn("Plugin post processor failed", error);
    }
    if (!isCurrent()) return;
  }

  for (const code of [...preview.querySelectorAll("pre code")]) {
    if (!isCurrent()) return;
    const language = [...code.classList]
      .find((name) => name.startsWith("language-"))
      ?.slice("language-".length);
    if (!language) continue;
    const processor = services.getCodeBlockProcessor(language);
    if (!processor) continue;
    const pre = code.parentElement;
    if (!pre) continue;
    const container = document.createElement("div");
    container.className = `plugin-codeblock language-${language}`;
    // Plugin children may measure their canvas/layout during load(). Mount
    // first, not after onload has already measured a detached element.
    pre.replaceWith(container);
    const children: Component[] = [];
    try {
      await processor(code.textContent ?? "", container, {
        sourcePath: context.sourcePath,
        app: context.app,
        getSectionInfo: () => null,
        addChild: (child: Component) => {
          children.push(child);
          registerChild(child);
        },
      });
    } catch (error) {
      for (const child of children)
        void child
          .unloadAsync()
          .catch((cleanupError) =>
            console.warn("Failed block cleanup", cleanupError),
          );
      if (!isCurrent()) return;
      container.classList.add("plugin-codeblock-error");
      container.textContent = `Plugin-Codeblock „${language}“ konnte nicht gerendert werden: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    if (!isCurrent()) return;
  }
}
