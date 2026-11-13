import { EditorState } from "@codemirror/state";
import { expect, it, vi } from "vitest";
import { Editor } from "../../src/compat/editor-adapter";
import { EditorExtensionRegistry } from "../../src/compat/editor-extensions";
import { FileIndex } from "../../src/compat/files";
import { MarkdownView, Workspace } from "../../src/compat/workspace";

it("exposes the real active editor and emits navigation only after the host changes files", async () => {
  const state = EditorState.create({ doc: "hello" });
  const editor = new Editor({
    state,
    hasFocus: false,
    scrollDOM: document.createElement("div"),
    dispatch: vi.fn(),
    focus: vi.fn(),
    requestMeasure: vi.fn(),
  });
  const view = new MarkdownView(editor, document.createElement("div"));
  const extensions = new EditorExtensionRegistry(vi.fn());
  const navigate = vi.fn(async (file) => {
    workspace.setActiveFile(file);
  });
  const workspace = new Workspace(view, navigate, extensions);
  const index = new FileIndex();
  index.replace([
    { path: "Hello.md", kind: "file", stat: { ctime: 0, mtime: 1, size: 5 } },
  ]);
  const file = index.getFileByPath("Hello.md")!;
  const changed = vi.fn();
  workspace.on("file-open", changed);
  await workspace.getLeaf().openFile(file);
  expect(navigate).toHaveBeenCalledWith(file);
  expect(workspace.activeEditor?.editor).toBe(editor);
  expect(workspace.getActiveFile()).toBe(file);
  expect(workspace.getActiveViewOfType(MarkdownView)).toBe(view);
  expect(workspace.getLeavesOfType("markdown")).toEqual([workspace.activeLeaf]);
  expect(workspace.getLeavesOfType("spreadsheet")).toEqual([]);
  expect(changed).toHaveBeenCalledOnce();
  workspace.setActiveFile(file);
  expect(changed).toHaveBeenCalledOnce();
  expect(() => workspace.getLeaf("split")).toThrow("not implemented");
});

it("stores and removes registered hover link sources", () => {
  const editor = new Editor({
    state: EditorState.create({ doc: "hello" }),
    hasFocus: false,
    scrollDOM: document.createElement("div"),
    dispatch: vi.fn(),
    focus: vi.fn(),
    requestMeasure: vi.fn(),
  });
  const workspace = new Workspace(
    new MarkdownView(editor, document.createElement("div")),
    vi.fn(async () => {}),
    new EditorExtensionRegistry(vi.fn()),
  );
  workspace.registerHoverLinkSource("tag-wrangler", { display: "Tags", defaultMod: false });
  expect((workspace as any).hoverSources.get("tag-wrangler")).toEqual({
    display: "Tags",
    defaultMod: false,
  });
  workspace.unregisterHoverLinkSource("tag-wrangler");
  expect((workspace as any).hoverSources.has("tag-wrangler")).toBe(false);
});

it("reports no active editor while a non-markdown view is active", async () => {
  const editor = new Editor({
    state: EditorState.create({ doc: "hello" }),
    hasFocus: false,
    scrollDOM: document.createElement("div"),
    dispatch: vi.fn(),
    focus: vi.fn(),
    requestMeasure: vi.fn(),
  });
  const view = new MarkdownView(editor, document.createElement("div"));
  const workspace = new Workspace(
    view,
    vi.fn(async () => {}),
    new EditorExtensionRegistry(vi.fn()),
  );
  const index = new FileIndex();
  index.replace([
    { path: "Hello.md", kind: "file", stat: { ctime: 0, mtime: 1, size: 5 } },
  ]);
  const file = index.getFileByPath("Hello.md")!;

  workspace.setActiveFile(file);
  expect(workspace.activeEditor?.editor).toBe(editor);
  expect(workspace.getActiveViewOfType(MarkdownView)).toBe(view);

  workspace.setActiveFile(null);
  expect(workspace.activeEditor).toBeNull();
  expect(workspace.getActiveFile()).toBeNull();
  expect(workspace.getActiveViewOfType(MarkdownView)).toBeNull();
});
