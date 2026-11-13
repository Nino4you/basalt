import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  Prec,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { obsidianSyntax } from "../../src/editor/syntax";
import { renderedFacet } from "../../src/editor/live-preview";
import {
  codeBlockHost,
  pluginBlocks,
  refreshCodeBlocks,
} from "../../src/editor/plugin-blocks";
import { richPreview, finishRichSource } from "../../src/editor/rich-preview";
import { enhanceMath } from "../../src/app/rich-content";
import { parseTableSource } from "../../src/editor/table-model";

vi.mock("../../src/app/rich-content", () => ({
  enhanceMath: vi.fn(),
  enhanceMermaid: vi.fn(),
}));
vi.mock("../../src/editor/table-model", async (original) => {
  const actual =
    await original<typeof import("../../src/editor/table-model")>();
  return { ...actual, parseTableSource: vi.fn(actual.parseTableSource) };
});
const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  document.body.replaceChildren();
});
function mount(rendered = true, processor = false) {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "Text $x$\n\n$$x+y$$\n\n```mermaid\ngraph LR\nA-->B\n```\n\nEnde",
      extensions: [
        markdown({ base: markdownLanguage, extensions: [obsidianSyntax] }),
        renderedFacet.of(rendered),
        codeBlockHost.of({
          processor: () => (processor ? () => {} : undefined),
          context: () => null,
        }),
        richPreview,
      ],
    }),
  });
  views.push(view);
  return view;
}
it("renders inline/display math and Mermaid without changing source", () => {
  const view = mount();
  expect(view.dom.querySelectorAll(".cm-rich-math")).toHaveLength(2);
  expect(view.dom.querySelectorAll(".cm-rich-mermaid")).toHaveLength(1);
  const before = view.state.doc.toString();
  view.dom.querySelector<HTMLElement>(".cm-rich-math")!.click();
  expect(view.dom.querySelectorAll(".cm-rich-math")).toHaveLength(1);
  expect(finishRichSource(view)).toBe(true);
  expect(view.dom.querySelectorAll(".cm-rich-math")).toHaveLength(2);
  expect(view.state.doc.toString()).toBe(before);
});
it("invalidates pending renders on source changes, state swaps and destruction", async () => {
  const view = mount();
  await vi.waitFor(() => expect(enhanceMath).toHaveBeenCalled());
  const calls = vi.mocked(enhanceMath).mock.calls;
  const current = calls[calls.length - 1][1];
  expect(current()).toBe(true);
  view.setState(
    EditorState.create({ doc: "Anderes Dokument", extensions: [richPreview] }),
  );
  expect(current()).toBe(false);
  expect(view.dom.querySelector(".cm-rich-preview")).toBeNull();
});

it("hands Mermaid to plugins on activation and restores core rendering on disable", async () => {
  let enabled = false;
  const mode = new Compartment();
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "```mermaid\nA-->B\n```",
      extensions: [
        markdown({ base: markdownLanguage }),
        mode.of(renderedFacet.of(true)),
        codeBlockHost.of({
          processor: () =>
            enabled
              ? (_s, el) => {
                  el.textContent = "Plugin";
                }
              : undefined,
          context: () => null,
        }),
        pluginBlocks,
        richPreview,
      ],
    }),
  });
  views.push(view);
  expect(parent.querySelectorAll(".cm-rich-mermaid")).toHaveLength(1);
  enabled = true;
  view.dispatch({ effects: refreshCodeBlocks.of(null) });
  await vi.waitFor(() =>
    expect(parent.querySelector(".plugin-codeblock")?.textContent).toBe(
      "Plugin",
    ),
  );
  expect(parent.querySelector(".cm-rich-mermaid")).toBeNull();
  enabled = false;
  view.dispatch({ effects: refreshCodeBlocks.of(null) });
  expect(parent.querySelectorAll(".cm-rich-mermaid")).toHaveLength(1);
  expect(parent.querySelector(".plugin-codeblock")).toBeNull();
  view.dispatch({ effects: mode.reconfigure(renderedFacet.of(false)) });
  expect(parent.querySelector(".cm-rich-preview")).toBeNull();
  view.dispatch({ effects: mode.reconfigure(renderedFacet.of(true)) });
  expect(parent.querySelectorAll(".cm-rich-mermaid")).toHaveLength(1);
});

it("reveals every formula touched by a multi-range selection without changing Markdown", () => {
  const view = mount();
  const source = view.state.doc.toString();
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorState.allowMultipleSelections.of(true),
    ),
  });
  view.dispatch({
    selection: EditorSelection.create([
      EditorSelection.range(5, 7),
      EditorSelection.range(12, 14),
    ]),
  });
  expect(view.dom.querySelector(".cm-rich-math")).toBeNull();
  expect(view.state.doc.toString()).toBe(source);
});
it("retains source mode and gives registered Mermaid processors priority", () => {
  expect(mount(false).dom.querySelector(".cm-rich-preview")).toBeNull();
  expect(mount(true, true).dom.querySelector(".cm-rich-mermaid")).toBeNull();
});
it("reuses inactive widgets across unrelated selection changes", () => {
  const view = mount();
  const widget = view.dom.querySelector(".cm-rich-math");
  view.dispatch({ selection: { anchor: 2 } });
  expect(view.dom.querySelector(".cm-rich-math")).toBe(widget);
});

it("re-parses tables only when the document changes, not on cursor moves", () => {
  const doc = "| A | B |\n| --- | --- |\n| x | y |\n\nText $x$ Ende";
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage, extensions: [obsidianSyntax] }),
        richPreview,
      ],
    }),
  });
  views.push(view);
  const parses = vi.mocked(parseTableSource);
  parses.mockClear();
  const math = doc.indexOf("$x$");
  for (const anchor of [doc.length, math + 1, doc.length, math + 2])
    view.dispatch({ selection: { anchor } });
  expect(parses).not.toHaveBeenCalled();
  // Selection still decides which formula shows its source.
  expect(view.dom.querySelector(".cm-rich-math")).toBeNull();
  view.dispatch({ selection: { anchor: doc.length } });
  expect(view.dom.querySelector(".cm-rich-math")).not.toBeNull();
  expect(view.dom.querySelector("table")).not.toBeNull();
  view.dispatch({ changes: { from: doc.length, insert: "!" } });
  expect(parses).toHaveBeenCalled();
});

it("leaves Escape to existing commands outside active rich source", () => {
  const view = mount();
  const dismiss = vi.fn(() => true);
  view.dispatch({
    effects: StateEffect.appendConfig.of([
      Prec.highest(keymap.of([{ key: "Escape", run: finishRichSource }])),
      keymap.of([{ key: "Escape", run: dismiss }]),
    ]),
  });
  view.dispatch({ selection: { anchor: 2 } });
  expect(finishRichSource(view)).toBe(false);
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  expect(dismiss).toHaveBeenCalledOnce();
  view.dispatch({ selection: { anchor: 6 } });
  expect(finishRichSource(view)).toBe(true);
  expect(finishRichSource(view)).toBe(false);
  const sourceMode = mount(false);
  sourceMode.dispatch({ selection: { anchor: 6 } });
  expect(finishRichSource(sourceMode)).toBe(false);
});

it("keeps container-prefixed display math as source instead of rendering quote markers", () => {
  const doc = "> [!note]\n> $$\n> x\n> $$\n\n$$y$$";
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage, extensions: [obsidianSyntax] }),
        richPreview,
      ],
    }),
  });
  views.push(view);
  expect(parent.querySelectorAll(".cm-rich-math")).toHaveLength(1);
  expect(parent.querySelector(".cm-rich-math")?.textContent).toBe("$$y$$");
  expect(view.state.doc.toString()).toBe(doc);
  view.dispatch({ selection: { anchor: doc.indexOf("x") } });
  expect(finishRichSource(view)).toBe(false);
});
