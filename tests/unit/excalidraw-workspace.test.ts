import { EditorState } from "@codemirror/state";
import { expect, it, vi } from "vitest";
import { Editor } from "../../src/compat/editor-adapter";
import { EditorExtensionRegistry } from "../../src/compat/editor-extensions";
import { CompatibilitySession } from "../../src/compat/session";
import { FuzzySuggestModal, TextFileView, createObsidianApi } from "../../src/compat/obsidian-api";
import { Plugin } from "../../src/compat/plugin";
import { Workspace } from "../../src/compat/workspace";
import { MemoryPort } from "../helpers/vault-store";

async function setup() {
  const port = new MemoryPort({ "Drawing.excalidraw": "initial", "Note.md": "note" });
  const session = await CompatibilitySession.create({
    vaultId: port.vaultId, name: "Isolated", mobile: false, port,
    editor: new Editor({ state: EditorState.create(), hasFocus: false,
      scrollDOM: document.createElement("div"), dispatch() {}, focus() {}, requestMeasure() {} }),
    extensions: new EditorExtensionRegistry(() => {}),
    container: document.createElement("div"), navigate: async () => {},
  });
  return session;
}

it("exports the actual Workspace class used by the host", async () => {
  const session = await setup();
  expect(session.vault.getAbstractFileByPathInsensitive("note.MD")).toBe(session.vault.getFileByPath("Note.md"));
  expect(session.vault.getAbstractFileByPathInsensitive("")).toBe(session.vault.getRoot());
  expect(createObsidianApi({ app: session }).Workspace).toBe(Workspace);
  await session.dispose();
});

it("exposes indexed metadata paths and suggestion instructions", async () => {
  const session = await setup();
  expect(session.metadataCache.getCachedFiles()).toEqual(["Note.md"]);
  expect(session.metadataCache.getCache("Note.md")).toBe(session.metadataCache.getFileCache(session.vault.getFileByPath("Note.md")));
  class Picker extends FuzzySuggestModal<string> {
    getItems() { return ["drawing"]; }
    getItemText(item: string) { return item; }
  }
  const picker = new Picker(session);
  picker.setInstructions([{ command: "Enter", purpose: "Open drawing" }]);
  expect(picker.containerEl.textContent).toContain("Open drawing");
  await session.dispose();
});

it("tracks real plugin leaves, active files and view state, and saves before detaching", async () => {
  const session = await setup();
  const close = vi.fn();
  const order: string[] = [];
  class Drawing extends TextFileView {
    override getViewType() { return "drawing"; }
    override async onunload() { order.push("unload"); await super.onunload(); }
    override onClose() { order.push("close"); close(); }
  }
  class DrawingPlugin extends Plugin {
    override onload() {
      this.registerView("drawing", leaf => new Drawing(leaf as ConstructorParameters<typeof Drawing>[0]));
      this.registerExtensions(["excalidraw"], "drawing");
    }
  }
  await session.plugins.enable({ id: "drawing", name: "Drawing", version: "1" }, DrawingPlugin);
  const leaf = session.workspace.getLeaf("tab");
  await leaf.openFile(session.vault.getFileByPath("Drawing.excalidraw")!);
  expect(leaf.view).toBeInstanceOf(Drawing);
  expect(session.workspace.getActiveViewOfType(Drawing)).toBe(leaf.view);
  expect(session.workspace.activeEditor).toBeNull();
  expect(session.workspace.getActiveFile()?.path).toBe("Drawing.excalidraw");
  expect(leaf.getViewState()).toMatchObject({ type: "drawing", state: { file: "Drawing.excalidraw" } });
  const leaves: unknown[] = [];
  session.workspace.iterateAllLeaves(value => leaves.push(value));
  expect(leaves).toContain(leaf);
  (leaf.view as Drawing).data = "edited";
  session.workspace.detachLeavesOfType("drawing");
  await session.workspace.flushPending();
  expect(session.workspace.getLeavesOfType("drawing")).toEqual([]);
  expect(await session.vault.read(session.vault.getFileByPath("Drawing.excalidraw")!)).toBe("edited");
  expect(order).toEqual(["unload", "close"]);
  expect(close).toHaveBeenCalledOnce();
  await session.dispose();
});

it("awaits layout-ready startup and propagates asynchronous failures", async () => {
  const session = await setup();
  let ready = false;
  class Good extends Plugin {
    override onload() { session.workspace.onLayoutReady(async () => { await Promise.resolve(); ready = true; }); }
  }
  await session.plugins.enable({ id: "good", name: "Good", version: "1" }, Good);
  expect(ready).toBe(true);
  class Bad extends Plugin {
    override onload() { session.workspace.onLayoutReady(async () => { throw new Error("Layout failed"); }); }
  }
  await expect(session.plugins.enable({ id: "bad", name: "Bad", version: "1" }, Bad)).rejects.toThrow("Layout failed");
  expect(session.plugins.enabledPlugins.has("bad")).toBe(false);
  await session.dispose();
});
