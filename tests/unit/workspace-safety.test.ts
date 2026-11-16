import { EditorState } from "@codemirror/state";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../src/app/app";
import { backend } from "../../src/backend";
import { BrowserBackend } from "../../src/backend";
import { NoteStore } from "../../src/store";
import { TextFileView } from "../../src/compat/obsidian-api";

afterEach(() => vi.restoreAllMocks());

it("removes plugin files from every tab and history without changing other files", async () => {
  localStorage.clear();
  const api = new BrowserBackend();
  await api.create("Table.xlsx", "workbook bytes");
  await api.create("Note.md", "note");
  const store = new NoteStore(api, "vault");
  const tab = () => ({
    path: "Table.xlsx",
    kind: "plugin",
    viewType: "sheet",
    note: null,
    state: EditorState.create(),
    loaded: true,
    request: 0,
    history: ["Note.md", "Table.xlsx"],
    historyIndex: 1,
  });
  const first = tab();
  const second = tab();
  const context = {
    store,
    active: first,
    tabs: [first, second],
    allTabs: [first, second],
    saveTimers: new Map(),
    failed: new Map(),
    ws: { bookmarks: ["Table.xlsx", "Note.md"], recent: ["Table.xlsx"] },
    index: { files: ["Table.xlsx", "Note.md"] },
    releasePluginUi: vi.fn(),
    editor: { setEditable: vi.fn() },
    setFiles: vi.fn(),
    emit: vi.fn(),
    saveWorkspace: vi.fn(),
    refreshCompatibility: vi.fn().mockResolvedValue(undefined),
    report: vi.fn(),
    showActive: vi.fn(),
  };
  const remove = (
    App.prototype as unknown as {
      deleteFile(path: string, store: NoteStore): Promise<void>;
    }
  ).deleteFile;
  await remove.call(context as unknown as App, "Table.xlsx", store);
  for (const current of context.tabs) {
    expect(current).toMatchObject({
      path: null,
      kind: "empty",
      state: null,
      history: ["Note.md"],
      historyIndex: 0,
      request: 1,
    });
  }
  expect(context.setFiles).toHaveBeenCalledWith(["Note.md"]);
  expect(context.ws.bookmarks).toEqual(["Note.md"]);
  expect(context.ws.recent).toEqual([]);
  expect(await api.read("Note.md")).toBe("note");
  expect(context.releasePluginUi).toHaveBeenCalledOnce();
  expect(context.showActive).toHaveBeenCalledOnce();
  await expect(
    remove.call(
      context as unknown as App,
      "Note.md",
      new NoteStore(api, "other"),
    ),
  ).rejects.toThrow("Vault");
  expect(await api.read("Note.md")).toBe("note");
});

it("does not open another vault when saving the current drafts fails", async () => {
  const failure = new Error("External file conflict");
  const choose = vi.spyOn(backend, "choose").mockResolvedValue(null);
  const context = {
    choosingVault: false,
    store: { saveAll: vi.fn().mockRejectedValue(failure) },
    report: vi.fn(),
    loadVault: vi.fn(),
  };
  await App.prototype.chooseVault.call(context as unknown as App);
  expect(choose).not.toHaveBeenCalled();
  expect(context.loadVault).not.toHaveBeenCalled();
  expect(context.report).toHaveBeenCalledWith(failure);
  expect(context.choosingVault).toBe(false);
});

it("saves drafts before selecting and loading another vault", async () => {
  const info = { id: "next", name: "Next", files: [], platform: "linux" };
  const events: string[] = [];
  vi.spyOn(backend, "choose").mockImplementation(async () => {
    events.push("choose");
    return info;
  });
  const context = {
    choosingVault: false,
    store: {
      saveAll: async () => {
        events.push("save");
      },
    },
    report: vi.fn(),
    loadVault: vi.fn(async () => {
      events.push("load");
    }),
  };
  await App.prototype.chooseVault.call(context as unknown as App);
  expect(events).toEqual(["save", "choose", "load"]);
  expect(context.loadVault).toHaveBeenCalledWith(info);
  expect(context.report).not.toHaveBeenCalled();
  expect(context.choosingVault).toBe(false);
});

it.each([false, true])("saves plugin text views before choosing another vault (failure=%s)", async (failure) => {
  const events: string[] = [];
  const error = new Error("Plugin version conflict");
  let finish!: () => void;
  const saved = new Promise<void>(resolve => { finish = resolve; });
  const view = Object.create(TextFileView.prototype) as TextFileView;
  view.save = vi.fn(async () => {
    events.push("plugin-save");
    await saved;
    if (failure) throw error;
    events.push("plugin-saved");
  });
  const choose = vi.spyOn(backend, "choose").mockImplementation(async () => {
    events.push("choose");
    return null;
  });
  const context = {
    choosingVault: false,
    store: { saveAll: vi.fn(async () => { events.push("notes-save"); }) },
    compatibility: { workspace: {
      flushPending: vi.fn(async () => { events.push("flush"); }),
      iterateAllLeaves(callback: (leaf: { view: object }) => void) {
        callback({ view });
        callback({ view }); // Shared view identity is written only once.
        callback({ view: {} });
      },
    } },
    report: vi.fn(), loadVault: vi.fn(),
  };
  const switching = App.prototype.chooseVault.call(context as unknown as App);
  await vi.waitFor(() => expect(view.save).toHaveBeenCalledOnce());
  expect(choose).not.toHaveBeenCalled();
  expect(context.choosingVault).toBe(true);
  finish();
  await switching;
  expect(events).toEqual(failure
    ? ["notes-save", "flush", "plugin-save"]
    : ["notes-save", "flush", "plugin-save", "plugin-saved", "choose"]);
  expect(choose).toHaveBeenCalledTimes(failure ? 0 : 1);
  expect(context.report).toHaveBeenCalledTimes(failure ? 1 : 0);
  if (failure) expect(context.report).toHaveBeenCalledWith(error);
  expect(context.loadVault).not.toHaveBeenCalled();
  expect(context.choosingVault).toBe(false);
});

it.each([false, true])(
  "only keeps plugin surfaces in the visible view (reading=%s)",
  (reading) => {
    const state = EditorState.create({ doc: "# Note" });
    const element = () => document.createElement("div");
    const context = {
      active: {
        kind: "markdown",
        note: { text: "# Note" },
        path: "Note.md",
        state,
        reading,
      },
      pluginView: null,
      attachmentUrl: null,
      attachmentRequest: 0,
      clearAttachment: vi.fn(),
      shell: {
        empty: element(),
        pluginView: element(),
        canvasHost: element(),
        baseHost: element(),
        attachmentHost: element(),
        editorEl: element(),
        previewEl: element(),
      },
      settings: { get: () => false },
      editor: {
        state,
        setEditable: vi.fn(),
        setTitle: vi.fn(),
        refreshPluginBlocks: vi.fn(),
        releasePluginBlocks: vi.fn(),
      },
      reading: { clear: vi.fn(), render: vi.fn() },
      compatibility: { setActivePath: vi.fn() },
      emit: vi.fn(),
      applyReveal: vi.fn(),
    };
    const show = (App.prototype as unknown as { showActive(): void })
      .showActive;
    show.call(context as unknown as App);
    expect(context.reading.clear).toHaveBeenCalledTimes(reading ? 0 : 1);
    expect(context.reading.render).toHaveBeenCalledTimes(reading ? 1 : 0);
    expect(context.editor.releasePluginBlocks).toHaveBeenCalledTimes(
      reading ? 1 : 0,
    );
    expect(context.editor.refreshPluginBlocks).toHaveBeenCalledTimes(
      reading ? 0 : 1,
    );
    expect(context.shell.previewEl.hidden).toBe(!reading);
    expect(context.shell.editorEl.hidden).toBe(reading);
    expect(context.shell.baseHost.hidden).toBe(true);
    expect(context.shell.canvasHost.hidden).toBe(true);
    expect(context.shell.attachmentHost.hidden).toBe(true);
    expect(context.compatibility.setActivePath).toHaveBeenCalledWith("Note.md");
  },
);
