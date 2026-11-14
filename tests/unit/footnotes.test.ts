import { afterEach, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { renderMarkdown } from "../../src/markdown";
import {
  footnoteDefinitions,
  footnoteMarks,
  insertFootnote,
} from "../../src/editor/footnotes";

afterEach(() => document.body.replaceChildren());

function render(source: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(source);
  return root;
}

it("numbers footnotes by first reference and lists them at the end", () => {
  const root = render(
    "Text[^b] und ^[inline *kursiv*] und [^a] und wieder [^b] und [^fehlt].\n\n" +
      "[^a]: Erste.\n    Weiter.\n[^b]: Zweite **fett**.\n\n```\n[^a]\n```\n",
  );
  const refs = [...root.querySelectorAll<HTMLElement>("a[data-footnote-ref]")];
  expect(refs.map((ref) => ref.textContent)).toEqual(["1", "2", "3", "1"]);
  expect(refs[0].title).toBe("Zweite fett.");
  expect(root.textContent).toContain("[^fehlt]");
  expect(root.querySelector("code")?.textContent).toBe("[^a]\n");
  const items = [...root.querySelectorAll(".footnotes li")];
  expect(
    items.map((item) => item.textContent?.replace(/\s+/g, " ").trim()),
  ).toEqual(["Zweite fett. ↩︎", "inline kursiv ↩︎", "Erste. Weiter. ↩︎"]);
  // Footnote links are not treated as external links.
  expect(root.querySelector(".footnote-link.external-link")).toBeNull();
});

it("leaves notes without footnotes alone", () => {
  expect(
    render("Nur [Text](https://example.org).").querySelector(".footnotes"),
  ).toBeNull();
});

it("collects definitions for editor tooltips", () => {
  expect([
    ...footnoteDefinitions("A[^1]\n\n[^1]: Eins\n[^x]: Zwei").entries(),
  ]).toEqual([
    ["1", "Eins"],
    ["x", "Zwei"],
  ]);
});

function editor(text: string, anchor = text.length) {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text,
      selection: { anchor },
      extensions: [markdown(), footnoteMarks],
    }),
  });
}

it("marks references and definitions in the editor", () => {
  const view = editor("Satz[^1] und [^2].\n\n[^1]: Die Notiz.");
  const refs = [...view.dom.querySelectorAll<HTMLElement>(".cm-footnote-ref")];
  expect(refs.map((ref) => ref.textContent)).toEqual(["[^1]"]);
  expect(refs[0].title).toBe("Die Notiz.");
  expect(view.dom.querySelector(".cm-footnote-def")?.textContent).toBe("[^1]:");
  view.destroy();
});

it("inserts the next free footnote and moves to its definition", () => {
  const view = editor("Eins[^1] zwei\n\n[^1]: A", 13);
  insertFootnote(view);
  expect(view.state.doc.toString()).toBe(
    "Eins[^1] zwei[^2]\n\n[^1]: A\n\n[^2]: ",
  );
  expect(view.state.selection.main.head).toBe(view.state.doc.length);
  view.destroy();
  const empty = editor("");
  insertFootnote(empty);
  expect(empty.state.doc.toString()).toBe("[^1]\n\n[^1]: ");
  empty.destroy();
});
