import { Compartment, EditorState, Facet } from "@codemirror/state";
import { expect, it, beforeEach, vi } from "vitest";
import { CompatibilitySession } from "../../src/compat/session";
import { Editor } from "../../src/compat/editor-adapter";
import { EditorExtensionRegistry } from "../../src/compat/editor-extensions";
import { editorInfoField } from "../../src/compat/obsidian-api";
import { Plugin } from "../../src/compat/plugin";
import type { VaultStoragePort } from "../../src/compat/storage-port";

beforeEach(() => localStorage.clear());

function fixture() {
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
  // Other files (plugin data.json) live in plain maps with their own versions.
  const extra = new Map<string, { bytes: Uint8Array; version: number }>();
  const folders = new Set<string>();
  const port: VaultStoragePort = {
    vaultId: "fixture",
    snapshot: async () => [
      { path: "Note.md", kind: "file", stat: stats() },
      ...[...folders].map((path) => ({
        path,
        kind: "folder" as const,
        stat: { ctime: 1, mtime: 1, size: 0 },
      })),
      ...[...extra].map(([path, entry]) => ({
        path,
        kind: "file" as const,
        stat: { ctime: 1, mtime: entry.version, size: entry.bytes.byteLength },
      })),
    ],
    read: async (path) => {
      const other = extra.get(path);
      if (other)
        return {
          bytes: other.bytes.slice(),
          version: String(other.version),
          stat: { ctime: 1, mtime: other.version, size: other.bytes.byteLength },
        };
      return { bytes: bytes.slice(), version: String(version), stat: stats() };
    },
    write: async (path, next, expected) => {
      const other = extra.get(path);
      if (other) {
        if (expected !== String(other.version)) throw new Error("Conflict");
        const entry = { bytes: new Uint8Array(next), version: other.version + 1 };
        extra.set(path, entry);
        return {
          version: String(entry.version),
          stat: { ctime: 1, mtime: entry.version, size: entry.bytes.byteLength },
        };
      }
      if (expected !== String(version)) throw new Error("Conflict");
      bytes = new Uint8Array(next);
      version++;
      return { version: String(version), stat: stats() };
    },
    create: async (path, next) => {
      if (path === "Note.md" || extra.has(path)) throw new Error("EEXIST");
      extra.set(path, { bytes: new Uint8Array(next), version: 1 });
      return {
        version: "1",
        stat: { ctime: 1, mtime: 1, size: next.byteLength },
      };
    },
    mkdir: async (path) => {
      folders.add(path);
    },
  };
  return { editor, extensions, port, facet, state: () => state, extra };
}

it("connects an explicitly compiled fixture plugin to vault storage, workspace and real editor extensions", async () => {
  const f = fixture();
  let session: CompatibilitySession;
  session = await CompatibilitySession.create({
    vaultId: "fixture",
    name: "Fixture",
    mobile: false,
    editor: f.editor,
    extensions: f.extensions,
    container: document.createElement("div"),
    port: f.port,
    navigate: async (path) => session.setActivePath(path),
  });
  const file = session.vault.getFileByPath("Note.md")!;
  await session.workspace.getLeaf().openFile(file);
  expect(session.workspace.activeEditor?.editor).toBe(f.editor);
  class FixturePlugin extends Plugin {
    override async onload() {
      const app = this.app as CompatibilitySession;
      this.registerEditorExtension(f.facet.of("fixture-extension"));
      await app.vault.process(
        app.workspace.getActiveFile()!,
        (text) => `${text}\n\nChanged by compiled fixture.`,
      );
      await this.saveData({ enabled: true });
    }
  }
  const plugin = await session.plugins.enable(
    { id: "fixture-plugin", name: "Fixture", version: "0.0.1" },
    FixturePlugin,
  );
  expect(await session.vault.read(file)).toContain(
    "Changed by compiled fixture.",
  );
  expect(f.state().facet(f.facet)).toEqual(["fixture-extension"]);
  expect(await plugin.loadData()).toEqual({ enabled: true });
  // Settings live in the vault like Obsidian's data.json, not in localStorage,
  // and stay out of the content vault that sync plugins see.
  const data = f.extra.get("Basalt/Plugins/fixture-plugin/data.json");
  expect(JSON.parse(new TextDecoder().decode(data!.bytes))).toEqual({
    enabled: true,
  });
  expect(session.vault.getAbstractFileByPath("Basalt")).toBeNull();
  expect(Object.keys({ ...localStorage })).not.toContainEqual(
    expect.stringContaining("basalt-plugin-settings"),
  );
  await session.plugins.disable("fixture-plugin");
  expect(f.state().facet(f.facet)).toEqual([]);
  expect(session.plugins.enabledPlugins.size).toBe(0);
});

it("publishes the active file through editorInfoField for sync plugins", async () => {
  const f = fixture();
  let session: CompatibilitySession;
  session = await CompatibilitySession.create({
    vaultId: "fixture",
    name: "Fixture",
    mobile: false,
    editor: f.editor,
    extensions: f.extensions,
    container: document.createElement("div"),
    port: f.port,
    navigate: async (path) => session.setActivePath(path),
  });
  const file = session.vault.getFileByPath("Note.md")!;
  await session.workspace.getLeaf().openFile(file);
  const info = f.state().field(editorInfoField, false);
  expect(info?.file?.path).toBe("Note.md");
  expect(info?.app).toBe(session);
  const callback = vi.fn();
  session.services.addCommand("test-plugin", {
    id: "editor-command",
    name: "Editor command",
    editorCallback: callback,
  });
  session.services.addCommand("test-plugin", {
    id: "test-plugin:visible-command",
    name: "Sichtbar",
    icon: "star",
    callback,
  });
  const record = session.commands.commands;
  expect(record["test-plugin:visible-command"].icon).toBe("star");
  record["test-plugin:visible-command"].icon = "trash";
  expect(session.services.getCommands()).toContainEqual(
    expect.objectContaining({
      id: "test-plugin:visible-command",
      icon: "trash",
    }),
  );
  session.commands.removeCommand("test-plugin:visible-command");
  expect(record["test-plugin:visible-command"]).toBeUndefined();
  expect(session.commands.executeCommandById("test-plugin:visible-command")).toBe(false);
  expect(session.services.isCommandAvailable("editor-command")).toBe(true);
  session.services.runCommand("editor-command");
  expect(callback).toHaveBeenCalledWith(
    f.editor,
    session.workspace.markdownView,
  );
  session.setActivePath(null);
  expect(session.services.isCommandAvailable("editor-command")).toBe(false);
  await session.dispose();
});

it("persists app-level local storage as JSON like the documented API", async () => {
  const f = fixture();
  let session: CompatibilitySession;
  session = await CompatibilitySession.create({
    vaultId: "fixture",
    name: "Fixture",
    mobile: false,
    editor: f.editor,
    extensions: f.extensions,
    container: document.createElement("div"),
    port: f.port,
    navigate: async (path) => session.setActivePath(path),
  });
  expect(session.loadLocalStorage("sample-sync-token")).toBeNull();
  session.saveLocalStorage("sample-sync-token", "abc");
  session.saveLocalStorage("sample-sync-device", { name: "Android", mobile: true });
  expect(session.loadLocalStorage("sample-sync-token")).toBe("abc");
  expect(session.loadLocalStorage("sample-sync-device")).toEqual({
    name: "Android",
    mobile: true,
  });
  session.saveLocalStorage("sample-sync-token", null);
  expect(session.loadLocalStorage("sample-sync-token")).toBeNull();
  localStorage.setItem(
    `basalt-app:${JSON.stringify([session.id, "sample-sync-device"])}`,
    "{not json",
  );
  expect(session.loadLocalStorage("sample-sync-device")).toBeNull();
  await session.dispose();
});

it("refuses to bind a foreign storage port or navigate foreign file objects", async () => {
  const f = fixture();
  const options = {
    vaultId: "other",
    name: "Fixture",
    mobile: false,
    editor: f.editor,
    extensions: f.extensions,
    container: document.createElement("div"),
    port: f.port,
    navigate: vi.fn(async () => {}),
  };
  await expect(CompatibilitySession.create(options)).rejects.toThrow(
    "different vault",
  );
  const first = await CompatibilitySession.create({
    ...options,
    vaultId: "fixture",
  });
  const second = await CompatibilitySession.create({
    ...options,
    vaultId: "fixture",
  });
  await expect(
    first.workspace.getLeaf().openFile(second.vault.getFileByPath("Note.md")!),
  ).rejects.toThrow("another or stale");
  expect(options.navigate).not.toHaveBeenCalled();
});

it("exposes the host status bar container to plugins", async () => {
  const f = fixture();
  const statusBarEl = document.createElement("div");
  const options = {
    vaultId: "fixture",
    name: "Fixture",
    mobile: false,
    editor: f.editor,
    extensions: f.extensions,
    container: document.createElement("div"),
    port: f.port,
    navigate: vi.fn(async () => {}),
  };
  const injected = await CompatibilitySession.create({ ...options, statusBarEl });
  expect(injected.statusBar.containerEl).toBe(statusBarEl);
  const fallback = await CompatibilitySession.create({ ...options, statusBarEl: undefined });
  expect(fallback.statusBar.containerEl).toBeInstanceOf(HTMLElement);
  expect(fallback.statusBar.containerEl).not.toBe(statusBarEl);
  await injected.dispose();
  await fallback.dispose();
});
it("reports a previously enabled plugin that fails to restore instead of dropping it silently", async () => {
  const f = fixture();
  const put = (path: string, text: string) =>
    f.extra.set(path, { bytes: new TextEncoder().encode(text), version: 1 });
  put(
    "Basalt/Plugins/broken-data/manifest.json",
    JSON.stringify({ id: "broken-data", name: "Broken", version: "1.0.0" }),
  );
  put(
    "Basalt/Plugins/broken-data/main.js",
    'const { Plugin } = require("obsidian");\n' +
      "module.exports = class extends Plugin { async onload() { await this.loadData(); } };",
  );
  put("Basalt/Plugins/broken-data/data.json", "{ kaputt");
  localStorage.setItem(
    `basalt-plugin-enabled:${JSON.stringify("fixture")}`,
    JSON.stringify(["broken-data"]),
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const session = await CompatibilitySession.create({
    vaultId: "fixture",
    name: "Fixture",
    mobile: false,
    editor: f.editor,
    extensions: f.extensions,
    container: document.createElement("div"),
    port: f.port,
    navigate: async () => {},
  });
  warn.mockRestore();
  expect(session.plugins.enabledPlugins.has("broken-data")).toBe(false);
  expect(String(session.restoreFailures.get("broken-data"))).toContain(
    "data.json is not valid JSON",
  );
  // The file the user may still want to repair is left untouched.
  expect(
    new TextDecoder().decode(
      f.extra.get("Basalt/Plugins/broken-data/data.json")!.bytes,
    ),
  ).toBe("{ kaputt");
  await session.dispose();
});
