import { describe, expect, it, vi } from "vitest";
import { Component } from "../../src/compat/component";
import { renderPluginMarkdown } from "../../src/compat/plugin-markdown";
import type { PluginServices } from "../../src/compat/plugin-services";

function services(options: {
  posts?: unknown[];
  blocks?: Record<string, (...args: unknown[]) => unknown>;
}): PluginServices {
  return {
    getMarkdownPostProcessors: () => options.posts ?? [],
    getCodeBlockProcessor: (language: string) => options.blocks?.[language],
  } as unknown as PluginServices;
}

describe("plugin Markdown rendering", () => {
  it("exposes the render container so reading-view controls can share its lifecycle", async () => {
    const preview = document.createElement("article");
    const child = new Component();
    const addChild = vi.fn();
    let container: unknown;
    await renderPluginMarkdown(
      preview,
      services({ posts: [(_el: HTMLElement, ctx: {
        containerEl: HTMLElement;
        addChild(child: Component): void;
      }) => {
        container = ctx.containerEl;
        ctx.addChild(child);
      }] }),
      { sourcePath: "Embed.md", app: {}, addChild },
      () => true,
    );
    expect(container).toBe(preview);
    expect(addChild).toHaveBeenCalledWith(child);
  });

  it("runs post processors and replaces supported code blocks", async () => {
    const preview = document.createElement("article");
    preview.innerHTML =
      '<p class="post">Text</p><pre><code class="language-ink">{"v":1}</code></pre><pre><code class="language-js">x</code></pre>';
    const addChild = vi.fn((value: Component) => value.load());
    const processor = vi.fn(
      async (source: string, el: HTMLElement, ctx: { sourcePath: string }) => {
        el.textContent = `ink:${source}:${ctx.sourcePath}`;
      },
    );
    await renderPluginMarkdown(
      preview,
      services({
        posts: [
          (el: HTMLElement) => {
            el.querySelector(".post")!.textContent = "processed";
          },
        ],
        blocks: {
          ink: processor as unknown as (...args: unknown[]) => unknown,
        },
      }),
      { sourcePath: "Notes/Test.md", app: {}, addChild },
      () => true,
    );

    expect(preview.querySelector(".post")?.textContent).toBe("processed");
    const block = preview.querySelector(".plugin-codeblock.language-ink");
    expect(block?.textContent).toBe('ink:{"v":1}:Notes/Test.md');
    expect(processor).toHaveBeenCalledTimes(1);
    expect(preview.querySelector("code.language-js")).not.toBeNull();
    expect(addChild).not.toHaveBeenCalled();
  });

  it("does not publish a block when the render became stale", async () => {
    const preview = document.createElement("article");
    preview.innerHTML = '<pre><code class="language-ink">old</code></pre>';
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current = true;
    const rendering = renderPluginMarkdown(
      preview,
      services({
        blocks: {
          ink: async () => {
            await pending;
          },
        },
      }),
      { sourcePath: "A.md", app: {}, addChild: () => {} },
      () => current,
    );
    current = false;
    preview.innerHTML = "<h1>New note</h1>";
    release();
    await rendering;
    expect(preview.querySelector("h1")?.textContent).toBe("New note");
    expect(preview.querySelector(".plugin-codeblock")).toBeNull();
  });

  it("mounts before a child loads and rejects late child registrations", async () => {
    const preview = document.createElement("article");
    preview.innerHTML = '<pre><code class="language-ink">ink</code></pre>';
    document.body.append(preview);
    let current = true;
    const cleanup = vi.fn();
    const addChild = vi.fn((child: Component) => child.load());
    try {
      await renderPluginMarkdown(
        preview,
        services({
          blocks: {
            ink: (_source, element, ctx) => {
              expect((element as HTMLElement).isConnected).toBe(true);
              current = false;
              const late = new Component();
              late.register(cleanup);
              (ctx as { addChild(child: Component): void }).addChild(late);
            },
          },
        }),
        { sourcePath: "A.md", app: {}, addChild },
        () => current,
      );
      expect(addChild).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      preview.remove();
    }
  });

  it("shows a processor error in place of the code block", async () => {
    const preview = document.createElement("article");
    preview.innerHTML = '<pre><code class="language-ink">bad</code></pre>';
    await renderPluginMarkdown(
      preview,
      services({
        blocks: {
          ink: () => {
            throw new Error("boom");
          },
        },
      }),
      { sourcePath: "A.md", app: {}, addChild: () => {} },
      () => true,
    );
    expect(
      preview.querySelector(".plugin-codeblock-error")?.textContent,
    ).toMatch(/boom/);
  });
});
