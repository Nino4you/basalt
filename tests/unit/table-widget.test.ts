import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { cursorCharForward, history, undo, redo } from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { TableWidget } from "../../src/editor/table-widget";
import { parseTableSource } from "../../src/editor/table-model";
import { richPreview } from "../../src/editor/rich-preview";
vi.mock("../../src/app/rich-content", () => ({
  enhanceMath: vi.fn(),
  enhanceMermaid: vi.fn(),
}));
const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  document.body.replaceChildren();
});
it("renders safe cells and edits only the clicked cell without moving neighbors", () => {
  const text = "| A | B |\n| :--- | ---: |\n| **alt** | neben |\n\nEnde";
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [markdown({ base: markdownLanguage }), richPreview],
    }),
  });
  views.push(view);
  const cell = parent.querySelector<HTMLTableCellElement>("td")!;
  expect(cell.querySelector("strong")?.textContent).toBe("alt");
  expect(cell.nextElementSibling?.getAttribute("style")).toContain("right");
  cell.click();
  const input = parent.querySelector("input")!;
  input.value = "neu";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(view.state.doc.toString()).toBe(text.replace("**alt**", "neu"));
  expect(parent.querySelector("input")).toBe(input);
  expect(parent.querySelectorAll("input")).toHaveLength(1);
});
it.each([0, 1])(
  "keeps an empty edge cell editable without optional outer pipes (%s)",
  (col) => {
    const text = "A | B\n--- | ---\nx | y";
    const parent = document.body.appendChild(document.createElement("div"));
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: text,
        extensions: [markdown({ base: markdownLanguage }), richPreview],
      }),
    });
    views.push(view);
    parent.querySelectorAll<HTMLTableCellElement>("td")[col].click();
    const input = parent.querySelector("input")!;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(parent.querySelector("input")).toBe(input);
    expect(input.value).toBe("");
    input.value = "neu";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(parent.querySelector("input")).toBe(input);
    expect(view.state.doc.toString()).toBe(
      col === 0 ? "A | B\n--- | ---\n| neu | y" : "A | B\n--- | ---\nx | neu |",
    );
  },
);

it("does not render executable HTML in table cells", () => {
  const model = parseTableSource(
    "| A |\n|---|\n| <img src=x onerror=alert(1)> |",
  )!;
  const view = new EditorView();
  views.push(view);
  const dom = new TableWidget(model).toDOM(view);
  expect(dom.querySelector("[onerror]")).toBeNull();
});

it("drops a cell input when another document replaces the same source", () => {
  const doc = "| A | B |\n|---|---|\n| x | y |";
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), richPreview],
    }),
  });
  views.push(view);
  parent.querySelector<HTMLElement>("td")!.click();
  expect(parent.querySelector("input")).not.toBeNull();
  view.dispatch({ changes: { from: 0, to: doc.length, insert: doc } });
  expect(parent.querySelector("input")).toBeNull();
});

it("moves the document cursor across a rendered table rather than into hidden source", () => {
  const table = "| A | B |\n|---|---|\n| x | y |";
  const view = new EditorView({
    state: EditorState.create({
      doc: table + "\n\nEnde",
      extensions: [markdown({ base: markdownLanguage }), richPreview],
    }),
  });
  views.push(view);
  cursorCharForward(view);
  expect(view.state.selection.main.head).toBe(table.length);
});

it("refreshes alignment when the delimiter row changes", () => {
  const parent = document.body.appendChild(document.createElement("div"));
  const text = "| A | B |\n| :--- | ---: |\n| alt | neben |";
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [markdown({ base: markdownLanguage }), richPreview],
    }),
  });
  views.push(view);
  view.dispatch({
    changes: {
      from: 0,
      to: text.length,
      insert: text.replace(":--- | ---:", "---: | :---"),
    },
  });
  expect(parent.querySelector("td")?.style.textAlign).toBe("right");
});

it.each(["editable", "readOnly"])(
  "respects the %s lock before and during cell editing",
  (kind) => {
    const lock = new Compartment();
    const doc = "| A | B |\n|---|---|\n| x | y |";
    const parent = document.body.appendChild(document.createElement("div"));
    const locked =
      kind === "editable"
        ? EditorView.editable.of(false)
        : EditorState.readOnly.of(true);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          markdown({ base: markdownLanguage }),
          lock.of(locked),
          richPreview,
        ],
      }),
    });
    views.push(view);
    parent.querySelector<HTMLElement>("td")!.click();
    expect(parent.querySelector("input")).toBeNull();
    view.dispatch({ effects: lock.reconfigure([]) });
    parent.querySelector<HTMLElement>("td")!.click();
    const input = parent.querySelector("input")!;
    expect(input).not.toBeNull();
    view.dispatch({ effects: lock.reconfigure(locked) });
    expect(parent.querySelector("input")).toBeNull();
    input.value = "nicht gespeichert";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("blur"));
    expect(view.state.doc.toString()).toBe(doc);
  },
);

it("preserves untouched backslashes and character-by-character TeX entry", () => {
  const doc = "| A | B |\n|---|---|\n| a\\ | y |";
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), richPreview],
    }),
  });
  views.push(view);
  parent.querySelector<HTMLElement>("td")!.click();
  parent
    .querySelector("input")!
    .dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  expect(view.state.doc.toString()).toBe(doc);
  parent.querySelector<HTMLElement>("td")!.click();
  const input = parent.querySelector("input")!;
  input.value = "";
  for (const char of "\\frac{1}{2}") {
    input.value += char;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(parent.querySelector("input")).toBe(input);
  }
  expect(input.value).toBe("\\frac{1}{2}");
  expect(view.state.doc.toString()).toBe(doc.replace("a\\", "\\frac{1}{2}"));
});

it("protects a delimiter-adjacent backslash with padding, not an extra user backslash", () => {
  const doc = "|A|B|\n|---|---|\n|x|y|";
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), richPreview],
    }),
  });
  views.push(view);
  parent.querySelector<HTMLElement>("td")!.click();
  const input = parent.querySelector("input")!;
  input.value = "\\";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(parent.querySelector("input")).toBe(input);
  expect(input.value).toBe("\\");
  expect(view.state.doc.toString()).toBe(doc.replace("|x|", "|\\ |"));
});

it("keeps the first header input stable without a leading pipe and maps later edits", () => {
  const doc = "A | B\n--- | ---\nx | y";
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), richPreview],
    }),
  });
  views.push(view);
  parent.querySelector<HTMLElement>("th")!.click();
  const input = parent.querySelector("input")!;
  input.value = "Neuer Titel";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(parent.querySelector("input")).toBe(input);
  expect(document.activeElement).toBe(input);
  view.dispatch({ changes: { from: 0, insert: "Vorwort\n\n" } });
  expect(parent.querySelector("input")).toBe(input);
  input.value += "!";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(view.state.doc.toString()).toBe(
    "Vorwort\n\n" + doc.replace(/^A/, "Neuer Titel!"),
  );
});

it.each([
  ["td", "-5", "A | B\n--- | ---\n| -5 | y\n\nEnde"],
  ["td", "+ x", "A | B\n--- | ---\n| + x | y\n\nEnde"],
  ["td", "* x", "A | B\n--- | ---\n| * x | y\n\nEnde"],
  ["td", "> q", "A | B\n--- | ---\n| > q | y\n\nEnde"],
  ["td", "1. x", "A | B\n--- | ---\n| 1. x | y\n\nEnde"],
  ["td", "```", "A | B\n--- | ---\n| ``` | y\n\nEnde"],
  ["th", "# T", "| # T | B\n--- | ---\nx | y\n\nEnde"],
])(
  "keeps a first-column %s input when typing block syntax %j without a leading pipe",
  (tag, typed, expected) => {
    const doc = "A | B\n--- | ---\nx | y\n\nEnde";
    const parent = document.body.appendChild(document.createElement("div"));
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [markdown({ base: markdownLanguage }), richPreview],
      }),
    });
    views.push(view);
    parent.querySelector<HTMLElement>(tag)!.click();
    const input = parent.querySelector("input")!;
    for (let i = 1; i <= typed.length; i++) {
      input.value = typed.slice(0, i);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(parent.querySelector("input")).toBe(input);
      expect(document.activeElement).toBe(input);
    }
    expect(view.state.doc.toString()).toBe(expected);
    expect(parent.querySelectorAll("tr")).toHaveLength(2);
  },
);

it("keeps typing and composition in a cell independent of neighboring code spans", () => {
  const doc = "| A | B |\n|---|---|\n| x | `y` |";
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), richPreview],
    }),
  });
  views.push(view);
  parent.querySelector<HTMLElement>("td")!.click();
  const input = parent.querySelector("input")!;
  input.value = "`";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(parent.querySelector("input")).toBe(input);
  expect(document.activeElement).toBe(input);
  input.dispatchEvent(
    new CompositionEvent("compositionstart", { bubbles: true }),
  );
  input.value += "日本語`";
  input.dispatchEvent(
    new InputEvent("input", { bubbles: true, isComposing: true }),
  );
  input.dispatchEvent(
    new CompositionEvent("compositionend", { bubbles: true }),
  );
  expect(parent.querySelector("input")).toBe(input);
  expect(view.state.doc.toString()).toBe(doc.replace("| x |", "| `日本語` |"));
  expect(parent.querySelectorAll("td")).toHaveLength(2);
});

function historyView(doc: string) {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        markdown({ base: markdownLanguage }),
        richPreview,
      ],
    }),
  });
  views.push(view);
  return { parent, view };
}

function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("undoes a whole cell edit in one step however slowly it was typed", () => {
  vi.useFakeTimers();
  try {
    const doc = "| A | B |\n| --- | --- |\n| alt | y |\n\nEnde";
    const { parent, view } = historyView(doc);
    parent.querySelector<HTMLElement>("td")!.click();
    const input = parent.querySelector("input")!;
    // Pauses longer than CodeMirror's 500 ms grouping window between inputs.
    for (const value of ["", "n", "ne", "neu"]) {
      vi.advanceTimersByTime(1000);
      typeInto(input, value);
    }
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(view.state.doc.toString()).toBe(doc.replace("alt", "neu"));
    undo(view);
    expect(view.state.doc.toString()).toBe(doc);
    redo(view);
    expect(view.state.doc.toString()).toBe(doc.replace("alt", "neu"));
  } finally {
    vi.useRealTimers();
  }
});

it("never joins cell typing after an undo onto an earlier, unrelated edit", () => {
  const table = "| A | B |\n| --- | --- |\n| alt | y |";
  const { parent, view } = historyView("Vorher\n\n" + table);
  view.dispatch({ changes: { from: 0, insert: "X" } });
  parent.querySelector<HTMLElement>("td")!.click();
  typeInto(parent.querySelector("input")!, "eins");
  parent
    .querySelector("input")!
    .dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
    );
  expect(view.state.doc.toString()).toBe("XVorher\n\n" + table);
  typeInto(parent.querySelector("input")!, "zwei");
  undo(view);
  expect(view.state.doc.toString()).toBe("XVorher\n\n" + table);
});
