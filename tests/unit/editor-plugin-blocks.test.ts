import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component } from "../../src/compat/component";
import { renderedFacet } from "../../src/editor/live-preview";
import {
  codeBlockHost,
  pluginBlocks,
  refreshCodeBlocks,
  type CodeBlockHost,
} from "../../src/editor/plugin-blocks";

const mounted: EditorView[] = [];
afterEach(() => {
  for (const view of mounted.splice(0)) {
    view.destroy();
    view.dom.parentElement?.remove();
  }
});

const DOC = "Text\n\n```ink\nfile: _ink/a.ink\n```\n";

function inkHost(seen: string[]): CodeBlockHost {
  return {
    processor: (language) =>
      language === "ink"
        ? (source, el) => {
            seen.push(source);
            el.textContent = `ink:${source}`;
          }
        : undefined,
    context: () => ({ sourcePath: "Notiz.md", app: {} }),
  };
}

function mount(cursor: number, rendered = true, host = inkHost([])) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: DOC,
      selection: { anchor: cursor },
      extensions: [
        markdown({ base: markdownLanguage }),
        renderedFacet.of(rendered),
        codeBlockHost.of(host),
        pluginBlocks,
      ],
    }),
  });
  mounted.push(view);
  return { view, parent, host };
}

describe("plugin code blocks in live preview", () => {
  it("replaces a fence outside the selection with the plugin element", async () => {
    const seen: string[] = [];
    const { parent } = mount(0, true, inkHost(seen));
    await vi.waitFor(() =>
      expect(
        parent.querySelector(".plugin-codeblock.language-ink")?.textContent,
      ).toBe("ink:file: _ink/a.ink"),
    );
    expect(seen).toEqual(["file: _ink/a.ink"]);
    expect(parent.textContent).not.toContain("```ink");
  });

  it("keeps the plugin surface when the focused selection is inside it", () => {
    const { view, parent } = mount(DOC.indexOf("file: _ink"));
    view.focus();
    expect(parent.querySelector(".plugin-codeblock")).not.toBeNull();
    expect(parent.textContent).not.toContain("```ink");
  });

  it("preserves the mounted surface through real focus and cursor changes", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const seen: string[] = [];
      const { view, parent } = mount(
        DOC.indexOf("file: _ink"),
        true,
        inkHost(seen),
      );
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      const surface = parent.querySelector(".plugin-codeblock");
      view.focus();
      await vi.waitFor(() => expect(view.hasFocus).toBe(true));
      view.dispatch({ selection: { anchor: DOC.indexOf("a.ink") } });
      expect(parent.querySelector(".plugin-codeblock")).toBe(surface);
      expect(parent.textContent).not.toContain("```ink");
      view.contentDOM.blur();
      await vi.waitFor(() => expect(view.hasFocus).toBe(false));
      expect(seen).toHaveLength(1);
      expect(errors).not.toHaveBeenCalled();
      expect(view.state.doc.toString()).toBe(DOC);
    } finally {
      errors.mockRestore();
    }
  });

  it("renders a block the cursor merely rests in on load", () => {
    const { parent } = mount(DOC.indexOf("file: _ink"));
    expect(parent.querySelector(".plugin-codeblock")).not.toBeNull();
  });

  it("keeps the raw fence in source mode", () => {
    const { parent } = mount(0, false);
    expect(parent.querySelector(".plugin-codeblock")).toBeNull();
    expect(parent.textContent).toContain("```ink");
  });

  it("rebuilds when the host refreshes after a plugin change", async () => {
    let active = false;
    const processor = inkHost([]).processor;
    const { view, parent } = mount(0, true, {
      processor: (language) => (active ? processor(language) : undefined),
      context: () => ({ sourcePath: "Notiz.md", app: {} }),
    });
    expect(parent.querySelector(".plugin-codeblock")).toBeNull();
    active = true;
    view.dispatch({ effects: refreshCodeBlocks.of(null) });
    await vi.waitFor(() =>
      expect(
        parent.querySelector(".plugin-codeblock.language-ink"),
      ).not.toBeNull(),
    );
  });

  it("replaces an existing surface after the processor is reloaded", async () => {
    let processor = (_source: string, el: HTMLElement) => {
      el.textContent = "old";
    };
    const { view, parent } = mount(0, true, {
      processor: () => processor,
      context: () => ({ sourcePath: "Notiz.md", app: null }),
    });
    await vi.waitFor(() => expect(parent.textContent).toContain("old"));
    processor = (_source, el) => {
      el.textContent = "new";
    };
    view.dispatch({ effects: refreshCodeBlocks.of(null) });
    await vi.waitFor(() => expect(parent.textContent).toContain("new"));
  });

  it("does not reuse a surface belonging to another note", async () => {
    let sourcePath = "First.md";
    const processor = (
      _source: string,
      el: HTMLElement,
      info: Record<string, unknown>,
    ) => {
      el.textContent = String(info.sourcePath);
    };
    const { view, parent } = mount(0, true, {
      processor: () => processor,
      context: () => ({ sourcePath, app: null }),
    });
    await vi.waitFor(() => expect(parent.textContent).toContain("First.md"));
    sourcePath = "Second.md";
    view.dispatch({ effects: refreshCodeBlocks.of(null) });
    await vi.waitFor(() => expect(parent.textContent).toContain("Second.md"));
  });

  it("cancels deferred rendering when the block is removed before mounting", async () => {
    const seen: string[] = [];
    const { view } = mount(0, true, inkHost(seen));
    view.dispatch({ changes: { from: 0, to: DOC.length, insert: "gone" } });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    expect(seen).toEqual([]);
  });

  it("unloads a child returned after its surface was removed", async () => {
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const child = new Component();
    const unload = vi.spyOn(child, "unload");
    let started = false;
    const { view } = mount(0, true, {
      processor: () => async (_source, _el, info) => {
        started = true;
        await ready;
        (info.addChild as (child: Component) => void)(child);
      },
      context: () => ({ sourcePath: "Notiz.md", app: null }),
    });
    await vi.waitFor(() => expect(started).toBe(true));
    view.dispatch({ changes: { from: 0, to: DOC.length, insert: "gone" } });
    finish();
    await vi.waitFor(() => expect(unload).toHaveBeenCalledOnce());
  });
});
