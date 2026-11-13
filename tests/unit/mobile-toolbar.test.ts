import { history } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it } from "vitest";
import { buildMobileToolbar } from "../../src/app/mobile-toolbar";
import { insertWikiLink, toggleBulletList } from "../../src/editor/commands";

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  document.body.replaceChildren();
});

function editor(doc: string, anchor = 0, head = anchor): EditorView {
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
      extensions: [history()],
    }),
  });
  views.push(view);
  return view;
}

it("toggles bullets over every selected line and keeps indentation", () => {
  const view = editor("eins\n  zwei", 0, 10);
  toggleBulletList(view);
  expect(view.state.doc.toString()).toBe("- eins\n  - zwei");
  toggleBulletList(view);
  expect(view.state.doc.toString()).toBe("eins\n  zwei");
});

it("removes numbered and task markers when switching a list off", () => {
  const view = editor("1. eins\n- [x] zwei", 0, 17);
  toggleBulletList(view);
  expect(view.state.doc.toString()).toBe("eins\nzwei");
});

it("wraps the selection in a wiki link, or opens an empty one at the cursor", () => {
  const view = editor("Ziel", 0, 4);
  insertWikiLink(view);
  expect(view.state.doc.toString()).toBe("[[Ziel]]");
  expect(
    view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    ),
  ).toBe("Ziel");
  const empty = editor("a ", 2);
  insertWikiLink(empty);
  expect(empty.state.doc.toString()).toBe("a [[]]");
  expect(empty.state.selection.main.head).toBe(4);
});

it("runs editor actions without taking focus from the editor", () => {
  const view = editor("Text", 4);
  const toolbar = document.body.appendChild(buildMobileToolbar(() => view));
  const press = (label: string) => {
    const button = toolbar.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    )!;
    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    button.click();
  };
  press("Aufgabe umschalten");
  expect(view.state.doc.toString()).toBe("- [ ] Text");
  press("Rückgängig");
  expect(view.state.doc.toString()).toBe("Text");
  press("Wiederholen");
  expect(view.state.doc.toString()).toBe("- [ ] Text");
  expect(toolbar.getAttribute("role")).toBe("toolbar");
});
