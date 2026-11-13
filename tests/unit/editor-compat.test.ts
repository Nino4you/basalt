import { EditorState, type TransactionSpec } from "@codemirror/state";
import { history } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { Editor, type EditorViewPort } from "../../src/compat/editor-adapter";

function harness(text: string) {
  let state = EditorState.create({
    doc: text,
    extensions: [history(), EditorState.allowMultipleSelections.of(true)],
  });
  const dispatched: TransactionSpec[] = [];
  const view: EditorViewPort = {
    get state() {
      return state;
    },
    hasFocus: true,
    scrollDOM: document.createElement("div"),
    focus: vi.fn(),
    requestMeasure: vi.fn(),
    dispatch(spec) {
      dispatched.push(spec);
      state = state.update(spec).state;
    },
  };
  return { editor: new Editor(view), view, dispatched };
}

describe("CodeMirror-backed editor compatibility", () => {
  it("maps UTF-16 editor positions and clamps navigation to document boundaries", () => {
    const { editor } = harness("Grüße 🌱\nAndroid\n");
    expect(editor.lineCount()).toBe(3);
    expect(editor.getLine(1)).toBe("Android");
    expect(editor.posToOffset({ line: 1, ch: 0 })).toBe(9);
    expect(editor.offsetToPos(8)).toEqual({ line: 0, ch: 8 });
    editor.setCursor({ line: 500, ch: 100 });
    expect(editor.getCursor()).toEqual({ line: 2, ch: 0 });
    expect(() => editor.getLine(100)).toThrow(RangeError);
  });
  it("preserves backwards selections and replaces them through CodeMirror transactions", () => {
    const { editor } = harness("alpha beta");
    editor.setSelection({ line: 0, ch: 10 }, { line: 0, ch: 6 });
    expect(editor.getSelection()).toBe("beta");
    expect(editor.getCursor("anchor").ch).toBe(10);
    expect(editor.getCursor("from").ch).toBe(6);
    editor.replaceSelection("gamma");
    expect(editor.getValue()).toBe("alpha gamma");
    expect(editor.somethingSelected()).toBe(false);
    editor.undo();
    expect(editor.getValue()).toBe("alpha beta");
    editor.redo();
    expect(editor.getValue()).toBe("alpha gamma");
  });
  it("applies multiple changes against the original document in one transaction", () => {
    const { editor, dispatched } = harness("abc\ndef");
    editor.transaction({
      changes: [
        { from: { line: 0, ch: 0 }, to: { line: 0, ch: 1 }, text: "LONG" },
        { from: { line: 1, ch: 0 }, to: { line: 1, ch: 1 }, text: "D" },
      ],
      selection: { anchor: { line: 1, ch: 2 }, head: { line: 1, ch: 2 } },
      origin: "input.plugin",
    });
    expect(dispatched).toHaveLength(1);
    expect(editor.getValue()).toBe("LONGbc\nDef");
    expect(editor.getCursor()).toEqual({ line: 1, ch: 2 });
  });
  it("supports multiple selections without mutating text outside selected spans", () => {
    const { editor } = harness("one two three");
    editor.setSelections([
      { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 3 } },
      { anchor: { line: 0, ch: 8 }, head: { line: 0, ch: 13 } },
    ]);
    editor.replaceSelection("X");
    expect(editor.getValue()).toBe("X two X");
    expect(editor.listSelections()).toHaveLength(2);
  });
  it("executes documented editor commands through CodeMirror", () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "eins\nzwei" }),
    });
    const editor = new Editor(view);
    try {
      editor.setCursor({ line: 0, ch: 0 });
      editor.exec("indentMore");
      expect(editor.getValue()).toBe("  eins\nzwei");
      editor.setValue("eins\nzwei");
      editor.setCursor({ line: 1, ch: 4 });
      editor.exec("newlineAndIndent");
      expect(editor.getValue()).toBe("eins\nzwei\n");
      expect(() =>
        (editor.exec as (name: string) => void)("unknown-command"),
      ).toThrow(RangeError);
    } finally {
      view.destroy();
    }
  });
  it("retains the host view and delegates focus, measure and scroll operations", () => {
    const { editor, view, dispatched } = harness("one\ntwo");
    expect(editor.cm).toBe(view);
    editor.focus();
    editor.refresh();
    editor.scrollTo(10, 20);
    expect(view.focus).toHaveBeenCalledOnce();
    expect(view.requestMeasure).toHaveBeenCalledOnce();
    expect(editor.getScrollInfo().top).toBe(20);
    editor.scrollIntoView(
      { from: { line: 0, ch: 0 }, to: { line: 1, ch: 2 } },
      true,
    );
    expect(dispatched.at(-1)?.effects).toBeDefined();
  });
  it("returns the document text and rewrites a single line", () => {
    const { editor, dispatched } = harness("Titel\nAlt\nEnde");
    expect(editor.getDoc()).toBe("Titel\nAlt\nEnde");
    editor.setLine(1, "Neu");
    expect(editor.getValue()).toBe("Titel\nNeu\nEnde");
    expect(dispatched).toHaveLength(1);
    expect(() => editor.setLine(9, "x")).toThrow(RangeError);
  });
  it("returns the word around a position and resolves boundaries to the earlier word", () => {
    const { editor } = harness("alpha beta well-known");
    expect(editor.wordAt({ line: 0, ch: 0 })).toEqual({
      from: { line: 0, ch: 0 },
      to: { line: 0, ch: 5 },
    });
    expect(editor.wordAt({ line: 0, ch: 3 })).toEqual({
      from: { line: 0, ch: 0 },
      to: { line: 0, ch: 5 },
    });
    expect(editor.wordAt({ line: 0, ch: 15 })).toEqual({
      from: { line: 0, ch: 11 },
      to: { line: 0, ch: 15 },
    });
    expect(editor.wordAt({ line: 0, ch: 5 })).toEqual({
      from: { line: 0, ch: 0 },
      to: { line: 0, ch: 5 },
    });
    expect(editor.wordAt({ line: 0, ch: 6 })).toEqual({
      from: { line: 0, ch: 6 },
      to: { line: 0, ch: 10 },
    });
    const { editor: spaced } = harness("alpha  beta");
    expect(spaced.wordAt({ line: 0, ch: 6 })).toBeNull();
  });
  it("blurs the CodeMirror content element", () => {
    const { editor, view } = harness("text");
    const contentDOM = document.createElement("div");
    const blur = vi.spyOn(contentDOM, "blur");
    (view as { contentDOM?: HTMLElement }).contentDOM = contentDOM;
    editor.blur();
    expect(blur).toHaveBeenCalledOnce();
    expect(() => editor.blur()).not.toThrow();
  });
});
