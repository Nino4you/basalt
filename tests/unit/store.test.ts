import { beforeEach, expect, it, vi } from "vitest";
import { BrowserBackend, type Backend } from "../../src/backend";
import { NoteStore, OWN_BACKUP_INTERVAL } from "../../src/store";

beforeEach(() => localStorage.clear());

it("persists changes and refuses to overwrite existing notes", async () => {
  const api = new BrowserBackend();
  await api.create("Test.md", "one");
  await expect(api.create("Test.md", "two")).rejects.toThrow();
  const store = new NoteStore(api, "test");
  const note = await store.load("Test.md");
  store.edit(note, "edited");
  await store.save(note);
  expect(await api.read("Test.md")).toBe("edited");
  expect(note.saved).toBe(note.text);
});

it("preserves a dirty draft on storage conflicts", async () => {
  const api = new BrowserBackend();
  await api.create("Test.md", "base");
  const store = new NoteStore(api, "test");
  const note = await store.load("Test.md");
  store.edit(note, "mine");
  await api.save("Test.md", "external", "base");
  await expect(store.save(note)).rejects.toThrow();
  expect(await api.read("Test.md")).toBe("external");
  expect(note.text).toBe("mine");
  const recovered = await new NoteStore(api, "test").load("Test.md");
  expect(recovered.recovered).toBe(true);
  expect(recovered.saved).toBe("base");
  expect(recovered.text).toBe("mine");
  await expect(new NoteStore(api, "test").save(recovered)).rejects.toThrow();
});

it("does not discard edits made during an in-flight save", async () => {
  const real = new BrowserBackend();
  await real.create("Test.md", "base");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const api: Backend = {
    info: () => real.info(),
    read: (path) => real.read(path),
    create: (p, t) => real.create(p, t),
    remove: (p, e) => real.remove(p, e),
    move: (f, t, e) => real.move(f, t, e),
    choose: () => real.choose(),
    export: (p, t) => real.export(p, t),
    backups: () => real.backups(),
    readBackup: (location) => real.readBackup(location),
    removeBackups: (locations) => real.removeBackups(locations),
    save: async (p, t, e) => {
      started();
      await gate;
      await real.save(p, t, e);
    },
  };
  const store = new NoteStore(api, "test");
  const note = await store.load("Test.md");
  store.edit(note, "first");
  const saving = store.save(note);
  await ready;
  store.edit(note, "second");
  release();
  await saving;
  expect(note.text).toBe("second");
  expect(note.saved).toBe("first");
  await store.save(note);
  expect(await real.read("Test.md")).toBe("second");
});

it("archives local edits before reloading an externally changed file", async () => {
  const api = new BrowserBackend();
  await api.create("Test.md", "base");
  const store = new NoteStore(api, "test");
  const note = await store.load("Test.md");
  store.edit(note, "my unsaved changes");
  await api.save("Test.md", "external changes", "base");
  const reloaded = await store.reload("Test.md");
  expect(reloaded.text).toBe("external changes");
  expect(reloaded.saved).toBe("external changes");
  expect(store.recoveries()[0].text).toBe("my unsaved changes");
  store.edit(reloaded, "merged changes");
  await store.save(reloaded);
  expect(await api.read("Test.md")).toBe("merged changes");
});

it("pins asynchronous reads and saves to the original vault identity", async () => {
  const real = new BrowserBackend();
  await real.create("Test.md", "base");
  let selected = "original-vault";
  const api: Backend = {
    info: () => real.info(),
    create: (p, t) => real.create(p, t),
    remove: (p, e) => real.remove(p, e),
    move: (f, t, e) => real.move(f, t, e),
    choose: () => real.choose(),
    export: (p, t) => real.export(p, t),
    backups: () => real.backups(),
    readBackup: (location) => real.readBackup(location),
    removeBackups: (locations) => real.removeBackups(locations),
    read: async (path, vaultId) => {
      if (vaultId !== selected) throw new Error("vault changed");
      return real.read(path);
    },
    save: async (path, text, expected, vaultId) => {
      if (vaultId !== selected) throw new Error("vault changed");
      return real.save(path, text, expected);
    },
  };
  const store = new NoteStore(api, selected);
  const note = await store.load("Test.md");
  store.edit(note, "unsaved original-vault data");
  selected = "another-vault";
  await expect(store.save(note)).rejects.toThrow("vault changed");
  expect(await real.read("Test.md")).toBe("base");
  expect(note.text).toBe("unsaved original-vault data");
});

it("saves edits before trashing and ignores queued saves of the deleted note", async () => {
  const api = new BrowserBackend();
  await api.create("Test.md", "base");
  const store = new NoteStore(api, "test");
  const note = await store.load("Test.md");
  store.edit(note, "latest");
  const deleting = store.remove("Test.md");
  expect(() => store.edit(note, "too late")).toThrow();
  const saving = store.save(note);
  await deleting;
  await saving;
  expect(store.notes.has("Test.md")).toBe(false);
  expect(() => store.edit(note, "stale edit")).toThrow();
  await expect(api.read("Test.md")).rejects.toThrow();
  expect((await api.info()).files).not.toContain("Test.md");
  const files = JSON.parse(localStorage.getItem("basalt-demo-v1")!);
  const backup = Object.keys(files).find((p) => p.startsWith(".basalt/trash/"));
  expect(files[backup!]).toBe("latest");
});

it("keeps the file and dirty draft when deletion encounters an external conflict", async () => {
  const api = new BrowserBackend();
  await api.create("Test.md", "base");
  const store = new NoteStore(api, "test");
  const note = await store.load("Test.md");
  store.edit(note, "mine");
  await api.save("Test.md", "external", "base");
  await expect(store.remove("Test.md")).rejects.toThrow();
  expect(store.isDeleting("Test.md")).toBe(false);
  expect(await api.read("Test.md")).toBe("external");
  expect((await new NoteStore(api, "test").load("Test.md")).text).toBe("mine");
  expect(store.notes.get("Test.md")).toBe(note);
});

it("backs up a recovered draft even when the note was not opened in this session", async () => {
  const api = new BrowserBackend();
  await api.create("Test.md", "base");
  const old = new NoteStore(api, "test");
  old.edit(await old.load("Test.md"), "unopened draft");
  await new NoteStore(api, "test").remove("Test.md");
  const files = JSON.parse(localStorage.getItem("basalt-demo-v1")!);
  const backup = Object.keys(files).find((path) =>
    path.startsWith(".basalt/trash/"),
  );
  expect(files[backup!]).toBe("unopened draft");
});

it("does not delete a file when writing its trash backup fails", async () => {
  const api = new BrowserBackend();
  await api.create("Test.md", "base");
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("storage full");
    });
  try {
    await expect(api.remove("Test.md", "base")).rejects.toThrow("storage full");
    expect(await api.read("Test.md")).toBe("base");
  } finally {
    write.mockRestore();
  }
});

it.each(["load", "reload"] as const)(
  "does not resurrect a note whose %s finishes after deletion",
  async (method) => {
    const api = new BrowserBackend();
    await api.create("Test.md", "base");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(api, "read").mockImplementation(async () => {
      await gate;
      return "base";
    });
    const store = new NoteStore(api, "test");
    const loading = store[method]("Test.md");
    await Promise.resolve();
    await Promise.resolve();
    await store.remove("Test.md");
    release();
    await expect(loading).rejects.toThrow();
    expect(store.notes.has("Test.md")).toBe(false);
  },
);

it("moves a note with its unsaved edits and keeps the loaded note", async () => {
  const api = new BrowserBackend();
  await api.create("Test.md", "base");
  const store = new NoteStore(api, "test");
  const note = await store.load("Test.md");
  store.edit(note, "edited");
  await store.move("Test.md", "Ordner/Test.md");
  expect(note).toMatchObject({
    path: "Ordner/Test.md",
    text: "edited",
    saved: "edited",
  });
  expect(await api.read("Ordner/Test.md")).toBe("edited");
  await expect(api.read("Test.md")).rejects.toThrow();
  expect(store.notes.get("Ordner/Test.md")).toBe(note);
  expect(store.notes.has("Test.md")).toBe(false);
  expect(store.isDeleting("Test.md")).toBe(false);
  // The note stays editable and saves to its new place.
  store.edit(note, "again");
  await store.save(note);
  expect(await api.read("Ordner/Test.md")).toBe("again");
  // No draft is left behind under the old path.
  expect(
    Object.keys(localStorage).filter((key) => key.startsWith("basalt-draft")),
  ).toEqual([]);
});

it("never overwrites a file or loses changes when moving", async () => {
  const api = new BrowserBackend();
  await api.create("Test.md", "base");
  await api.create("Ordner/Test.md", "other");
  const store = new NoteStore(api, "test");
  await expect(store.move("Test.md", "Ordner/Test.md")).rejects.toThrow(
    /existiert bereits/,
  );
  expect(await api.read("Test.md")).toBe("base");
  expect(await api.read("Ordner/Test.md")).toBe("other");

  // An external change the editor has not seen blocks the move.
  const note = await store.load("Test.md");
  store.edit(note, "mine");
  await api.save("Test.md", "external", "base");
  await expect(store.move("Test.md", "Neu/Test.md")).rejects.toThrow();
  expect(await api.read("Test.md")).toBe("external");
  await expect(api.read("Neu/Test.md")).rejects.toThrow();
  expect(note).toMatchObject({ path: "Test.md", text: "mine" });
  expect(store.isDeleting("Test.md")).toBe(false);
});

it("backs up foreign content always and its own autosaves every few minutes", async () => {
  const real = new BrowserBackend();
  await real.create("Test.md", "from disk");
  const calls: boolean[] = [];
  const api: Backend = {
    info: () => real.info(),
    read: (path) => real.read(path),
    create: (p, t) => real.create(p, t),
    remove: (p, e) => real.remove(p, e),
    move: (f, t, e) => real.move(f, t, e),
    choose: () => real.choose(),
    export: (p, t) => real.export(p, t),
    backups: () => real.backups(),
    readBackup: (location) => real.readBackup(location),
    removeBackups: (locations) => real.removeBackups(locations),
    save: (path, text, expected, vaultId, backup = true) => {
      calls.push(backup);
      return real.save(path, text, expected, vaultId, backup);
    },
  };
  vi.useFakeTimers({ now: 0 });
  try {
    const store = new NoteStore(api, "test");
    const note = await store.load("Test.md");
    for (const text of ["a", "ab", "abc"]) {
      store.edit(note, text);
      await store.save(note);
    }
    // The content from disk is kept; the own intermediate states are not.
    expect(calls).toEqual([true, false, false]);
    vi.setSystemTime(OWN_BACKUP_INTERVAL);
    store.edit(note, "abcd");
    await store.save(note);
    store.edit(note, "abcde");
    await store.save(note, { backup: true });
    expect(calls).toEqual([true, false, false, true, true]);
    const versions = (await real.backups()).map((b) =>
      real.readBackup(b.location),
    );
    expect(await Promise.all(versions)).toEqual(["abcd", "abc", "from disk"]);

    // Someone else wrote the file: its content is backed up before it is replaced.
    await real.save("Test.md", "external", "abcde");
    const fresh = await new NoteStore(api, "test").load("Test.md");
    store.edit(fresh, "mine");
    calls.length = 0;
    await new NoteStore(api, "test").save(fresh);
    expect(calls).toEqual([true]);
  } finally {
    vi.useRealTimers();
  }
});
