import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it } from "vitest";
import {
  inlineTitle,
  livePreview,
  renderedFacet,
  setInlineTitle,
} from "../../src/editor/live-preview";

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  document.body.replaceChildren();
});

function mount(doc: string): EditorView {
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        markdown({ base: markdownLanguage }),
        renderedFacet.of(true),
        livePreview,
      ],
    }),
  });
  views.push(view);
  return view;
}

it("renders the callout marker as the reading view's icon and keeps the title", () => {
  const view = mount("Text\n\n> [!warning] Achtung\n> Inhalt\n> mehr\n\nEnde");
  const lines = [...view.dom.querySelectorAll(".HyperMD-callout")];
  expect(lines).toHaveLength(3);
  expect(lines[0].classList.contains("HyperMD-callout-title")).toBe(true);
  expect(lines[2].classList.contains("HyperMD-callout-last")).toBe(true);
  expect(lines[1].classList.contains("HyperMD-callout-last")).toBe(false);
  const marker = lines[0].querySelector(".cm-callout-marker");
  expect(marker?.querySelector(".callout-icon svg")).toBeTruthy();
  expect(lines[0].textContent).toBe("Achtung");
  expect(view.state.doc.toString()).toContain("> [!warning] Achtung");
});

it("names an untitled callout after its type next to the icon", () => {
  const view = mount("> [!tip]\n> Inhalt\n\nEnde");
  const title = view.dom.querySelector(".HyperMD-callout-title");
  expect(title?.querySelector(".callout-icon svg")).toBeTruthy();
  expect(title?.textContent).toBe("Tip");
});

it("hides the inline title while the note opens with the same heading", () => {
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({
      doc: "# Darstellung\n\nText",
      extensions: [markdown({ base: markdownLanguage }), inlineTitle],
    }),
  });
  views.push(view);
  view.dispatch({ effects: setInlineTitle.of("Darstellung") });
  expect(view.dom.querySelector(".inline-title")).toBeNull();
  view.dispatch({ changes: { from: 2, to: 13, insert: "Andere" } });
  expect(view.dom.querySelector(".inline-title")?.textContent).toBe(
    "Darstellung",
  );
  view.dispatch({ effects: setInlineTitle.of(null) });
  expect(view.dom.querySelector(".inline-title")).toBeNull();
});

it("shows the marker source while the cursor is on the title line", () => {
  const view = mount("> [!note] Titel\n> Inhalt");
  view.focus();
  view.dispatch({ selection: { anchor: 3 } });
  const title = view.dom.querySelector(".HyperMD-callout-title");
  expect(title?.querySelector(".cm-callout-marker")).toBeNull();
  expect(title?.textContent).toContain("[!note]");
});
