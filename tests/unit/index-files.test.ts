import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../src/app/app";
import { backend } from "../../src/backend";
import { Vault } from "../../src/compat/vault";
import { MemoryPort } from "../helpers/vault-store";

afterEach(() => vi.restoreAllMocks());

it("reuses warm vault text for indexing while preferring unsaved drafts", async () => {
  const port = new MemoryPort({ "A.md": "saved", "B.md": "cached", "Layout.canvas": "{}", "Bild.png": "binary" });
  const read = vi.spyOn(port, "read");
  const vault = new Vault(port, "Index");
  await vault.initialize();
  await vault.cachedRead(vault.getFileByPath("B.md")!);
  read.mockClear();
  const fallback = vi.spyOn(backend, "read").mockImplementation(async path => new TextDecoder().decode((await port.read(path)).bytes));
  const indexed = new Map<string, string>();
  const context = {
    epoch: 1, vault: { id: port.vaultId }, compatibility: { vault },
    store: { notes: new Map([["A.md", { text: "unsaved draft" }]]) },
    index: {
      files: ["A.md", "B.md", "Layout.canvas", "Bild.png"], content: (path: string) => indexed.get(path),
      setContent: (path: string, text: string) => indexed.set(path, text), flush: vi.fn(),
    },
    report: vi.fn(), indexing: false,
  };
  const indexFiles = (App.prototype as unknown as { indexFiles(): Promise<void> }).indexFiles;
  await indexFiles.call(context as unknown as App);
  expect(indexed).toEqual(new Map([["A.md", "unsaved draft"], ["B.md", "cached"], ["Layout.canvas", "{}"]]));
  expect(fallback).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledExactlyOnceWith("Layout.canvas");
  expect(context.indexing).toBe(false);
  expect(context.report).not.toHaveBeenCalled();

  const { version } = await port.read("B.md");
  await port.write("B.md", new TextEncoder().encode("external edit"), version);
  await vault.refresh();
  indexed.clear();
  await indexFiles.call(context as unknown as App);
  expect(indexed.get("B.md")).toBe("external edit");
  expect(indexed.get("A.md")).toBe("unsaved draft");
  expect(fallback).not.toHaveBeenCalled();
});

it("keeps browser-demo indexing on its backend when there is no compatibility session", async () => {
  const read = vi.spyOn(backend, "read").mockResolvedValue("browser text");
  const setContent = vi.fn();
  const context = {
    epoch: 1, vault: { id: "browser" }, compatibility: null, store: { notes: new Map() },
    index: { files: ["Note.md"], content: () => undefined, setContent, flush: vi.fn() },
    report: vi.fn(), indexing: false,
  };
  const indexFiles = (App.prototype as unknown as { indexFiles(): Promise<void> }).indexFiles;
  await indexFiles.call(context as unknown as App);
  expect(read).toHaveBeenCalledExactlyOnceWith("Note.md", "browser");
  expect(setContent).toHaveBeenCalledWith("Note.md", "browser text", true);
});
