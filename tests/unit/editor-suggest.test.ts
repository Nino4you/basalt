import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CompletionContext } from "@codemirror/autocomplete";
import { afterEach, expect, it, vi } from "vitest";
import { Editor } from "../../src/compat/editor-adapter";
import {
  EditorSuggestBridge,
  type EditorSuggestRegistration,
} from "../../src/editor/editor-suggest";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function editorAt(text: string): Editor {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    state: EditorState.create({ doc: text, selection: { anchor: text.length } }),
    parent,
  });
  views.push(view);
  return new Editor(view);
}

function registration(
  overrides: Partial<EditorSuggestRegistration> = {},
): EditorSuggestRegistration {
  return {
    context: null,
    limit: 100,
    onTrigger: () => ({ start: { line: 0, ch: 0 }, end: { line: 0, ch: 4 }, query: "Test" }),
    getSuggestions: async () => [{ label: "Testwort" }],
    renderSuggestion: (value, el) => {
      el.textContent = (value as { label: string }).label;
    },
    selectSuggestion: () => undefined,
    close: () => undefined,
    ...overrides,
  };
}

async function complete(bridge: EditorSuggestBridge) {
  return bridge.source({} as CompletionContext);
}

it("turns registered editor suggestions into completion options", async () => {
  const editor = editorAt("Test");
  const suggest = registration();
  const bridge = new EditorSuggestBridge(
    {
      editorFile: () => ({ path: "Notiz.md" }) as never,
      editorSuggests: () => [suggest],
    },
    () => editor,
  );
  const result = await complete(bridge);
  expect(result?.from).toBe(0);
  expect(result?.to).toBe(4);
  expect(result?.filter).toBe(false);
  expect(result?.options.map((option) => option.label)).toEqual(["Testwort"]);
  expect(suggest.context).toMatchObject({ query: "Test", editor });
});

it("selects through the plugin with the current keyboard event", async () => {
  const editor = editorAt("Test");
  const selected = vi.fn();
  const suggest = registration({ selectSuggestion: selected });
  const bridge = new EditorSuggestBridge(
    {
      editorFile: () => ({ path: "Notiz.md" }) as never,
      editorSuggests: () => [suggest],
    },
    () => editor,
  );
  const result = await complete(bridge);
  const event = new KeyboardEvent("keydown", { key: "Enter" });
  editor.cm.contentDOM?.dispatchEvent(event);
  expect(result).not.toBeNull();
  if (!result) throw new Error("Completion result missing");
  const apply = result.options[0].apply;
  expect(typeof apply).toBe("function");
  if (typeof apply === "function")
    apply(editor.cm as never, result.options[0], 0, 4);
  expect(selected).toHaveBeenCalledWith({ label: "Testwort" }, event);
});

it("ignores a stale async result after a newer trigger", async () => {
  const editor = editorAt("Test");
  let resolveFirst: (values: unknown[]) => void = () => undefined;
  let call = 0;
  const first = registration({
    getSuggestions: () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  });
  const second = registration({
    getSuggestions: async () => [{ label: "Neu" }],
  });
  const bridge = new EditorSuggestBridge(
    {
      editorFile: () => ({ path: "Notiz.md" }) as never,
      editorSuggests: () => (++call === 1 ? [first] : [second]),
    },
    () => editor,
  );
  const old = complete(bridge);
  const current = await complete(bridge);
  resolveFirst([{ label: "Alt" }]);
  expect(await old).toBeNull();
  expect(current?.options.map((option) => option.label)).toEqual(["Neu"]);
});

it("closes and suppresses options when the plugin closes while loading", async () => {
  const editor = editorAt("Test");
  let resolve: (values: unknown[]) => void = () => undefined;
  const suggest = registration({
    getSuggestions: () =>
      new Promise((done) => {
        resolve = done;
      }),
    close() {
      this.context = null;
    },
  });
  const bridge = new EditorSuggestBridge(
    {
      editorFile: () => ({ path: "Notiz.md" }) as never,
      editorSuggests: () => [suggest],
    },
    () => editor,
  );
  const pending = complete(bridge);
  suggest.close();
  resolve([{ label: "Zu spät" }]);
  expect(await pending).toBeNull();
});
