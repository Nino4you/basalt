import { Compartment, EditorState, Facet } from "@codemirror/state";
import { beforeEach, expect, it, vi } from "vitest";
import { Editor } from "../../src/compat/editor-adapter";
import { EditorExtensionRegistry } from "../../src/compat/editor-extensions";
import { editorInfoField } from "../../src/compat/obsidian-api";
import { Plugin } from "../../src/compat/plugin";
import { CompatibilitySession } from "../../src/compat/session";
import type { VaultStoragePort } from "../../src/compat/storage-port";

beforeEach(() => localStorage.clear());

function fixture(options: { failSnapshot?: boolean } = {}) {
  const facet = Facet.define<string, readonly string[]>({
    combine: (values) => values,
  });
  const compartment = new Compartment();
  let state = EditorState.create({
    doc: "# Initial",
    extensions: [compartment.of([])],
  });
  const editor = new Editor({
    get state() {
      return state;
    },
    hasFocus: true,
    scrollDOM: document.createElement("div"),
    dispatch(spec) {
      state = state.update(spec).state;
    },
    focus: vi.fn(),
    requestMeasure: vi.fn(),
  });
  const extensions = new EditorExtensionRegistry((values) => {
    state = state.update({ effects: compartment.reconfigure(values) }).state;
  });
  let bytes = new TextEncoder().encode("# Initial");
  let version = 1;
  const stats = () => ({ ctime: 1, mtime: version, size: bytes.byteLength });
  const port: VaultStoragePort = {
    vaultId: "fixture",
    snapshot: async () => {
      if (options.failSnapshot) throw new Error("snapshot failed");
      return [{ path: "Note.md", kind: "file", stat: stats() }];
    },
    read: async () => ({
      bytes: bytes.slice(),
      version: String(version),
      stat: stats(),
    }),
    write: async (path, next, expected) => {
      if (expected !== String(version)) throw new Error("Conflict");
      bytes = new Uint8Array(next);
      version++;
      return { version: String(version), stat: stats() };
    },
    create: async () => {
      throw new Error("Unsupported fixture create");
    },
    mkdir: async () => {
      throw new Error("Unsupported fixture mkdir");
    },
  };
  return {
    editor,
    extensions,
    port,
    facet,
    state: () => state,
    createOptions() {
      let session: CompatibilitySession;
      const created = CompatibilitySession.create({
        vaultId: "fixture",
        name: "Fixture",
        mobile: false,
        editor,
        extensions,
        container: document.createElement("div"),
        port,
        navigate: async (path) => session.setActivePath(path),
      }).then((value) => {
        session = value;
        return value;
      });
      return created;
    },
  };
}

it("updates editorInfoField before publishing workspace file-open", async () => {
  const f = fixture();
  const session = await f.createOptions();
  const seen: Array<string | null | undefined> = [];
  session.workspace.on("file-open", () => {
    seen.push(f.state().field(editorInfoField, false)?.file?.path);
  });
  const file = session.vault.getFileByPath("Note.md")!;
  await session.workspace.getLeaf().openFile(file);
  expect(seen).toEqual(["Note.md"]);
  expect(session.workspace.activeEditor?.file).toBe(file);
  await session.dispose();
});

it("disposes registered extensions when vault initialization fails", async () => {
  const f = fixture({ failSnapshot: true });
  await expect(f.createOptions()).rejects.toThrow("snapshot failed");
  expect(f.state().field(editorInfoField, false)).toBeUndefined();
});

it("is idempotent and still removes every resource when plugin cleanup fails", async () => {
  const f = fixture();
  const session = await f.createOptions();
  const goodUnload = vi.fn();
  class Good extends Plugin {
    override onload() {
      this.registerEditorExtension(f.facet.of("good-extension"));
    }
    override onunload() {
      goodUnload();
    }
  }
  class Broken extends Plugin {
    override onunload() {
      throw new Error("plugin cleanup failed");
    }
  }
  await session.plugins.enable(
    { id: "good", name: "Good", version: "0.0.1" },
    Good,
  );
  await session.plugins.enable(
    { id: "broken", name: "Broken", version: "0.0.1" },
    Broken,
  );
  expect(f.state().facet(f.facet)).toEqual(["good-extension"]);

  const first = session.dispose();
  await expect(first).rejects.toThrow("Plugin host cleanup failed");
  await expect(session.dispose()).rejects.toThrow("Plugin host cleanup failed");
  expect(goodUnload).toHaveBeenCalledOnce();
  expect(session.plugins.enabledPlugins.size).toBe(0);
  expect(f.state().facet(f.facet)).toEqual([]);
  expect(f.state().field(editorInfoField, false)).toBeUndefined();
});

it("does not clear a replacement session's active editor info on disposal", async () => {
  const f = fixture();
  const first = await f.createOptions();
  const second = await f.createOptions();
  const file = second.vault.getFileByPath("Note.md")!;
  await second.workspace.getLeaf().openFile(file);
  expect(second.workspace.activeEditor?.file).toBe(file);

  await first.dispose();

  const info = f.state().field(editorInfoField, false);
  expect(info?.app).toBe(second);
  expect(info?.file?.path).toBe("Note.md");
  expect(second.workspace.activeEditor?.file).toBe(file);
  await second.dispose();
});
