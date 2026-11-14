import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "../../src/compat/files";
import {
  legacyPluginDataKey,
  PLUGIN_DATA_TIMING,
  VaultPluginDataStore,
} from "../../src/compat/plugin-data";
import { memoryVault } from "../helpers/vault-store";

beforeEach(() => localStorage.clear());

const PATH = "Basalt/Plugins/sample-sync/data.json";
/** No coalescing delay: these tests are about what gets written, not when. */
const NOW = { debounceMs: 0, maxWaitMs: 0 };

it("returns null before a plugin saved anything", async () => {
  const store = new VaultPluginDataStore(
    await memoryVault(),
    "v1",
    localStorage,
    undefined,
    NOW,
  );
  expect(await store.read("sample-sync")).toBeNull();
});

it("writes data.json into the plugin folder like Obsidian", async () => {
  const vault = await memoryVault({
    "Basalt/Plugins/sample-sync/manifest.json": "{}",
  });
  const store = new VaultPluginDataStore(
    vault,
    "v1",
    localStorage,
    undefined,
    NOW,
  );
  await store.write("sample-sync", { server: "https://sync.example", n: 1 });
  const file = vault.getAbstractFileByPath(PATH);
  expect(file).toBeInstanceOf(TFile);
  expect(await vault.read(file as TFile)).toBe(
    '{\n  "server": "https://sync.example",\n  "n": 1\n}',
  );
  await store.write("sample-sync", { n: 2 });
  expect(await store.read("sample-sync")).toEqual({ n: 2 });
});

it("creates missing plugin folders for compiled plugins", async () => {
  const vault = await memoryVault();
  const store = new VaultPluginDataStore(
    vault,
    "v1",
    localStorage,
    undefined,
    NOW,
  );
  await store.write("compiled", [1, 2]);
  expect(vault.getFolderByPath("Basalt/Plugins/compiled")).not.toBeNull();
  expect(await store.read("compiled")).toEqual([1, 2]);
});

it("reads an existing data.json copied over from Obsidian", async () => {
  const vault = await memoryVault({ [PATH]: '{"token":"abc"}' });
  const store = new VaultPluginDataStore(
    vault,
    "v1",
    localStorage,
    undefined,
    NOW,
  );
  expect(await store.read("sample-sync")).toEqual({ token: "abc" });
});

it("treats an empty data.json as no data", async () => {
  const vault = await memoryVault({ [PATH]: "  \n" });
  expect(
    await new VaultPluginDataStore(
      vault,
      "v1",
      localStorage,
      undefined,
      NOW,
    ).read("sample-sync"),
  ).toBeNull();
});

it("refuses to parse a broken data.json and leaves it untouched", async () => {
  const vault = await memoryVault({ [PATH]: "{broken" });
  const store = new VaultPluginDataStore(
    vault,
    "v1",
    localStorage,
    undefined,
    NOW,
  );
  await expect(store.read("sample-sync")).rejects.toThrow("not valid JSON");
  expect(await vault.read(vault.getFileByPath(PATH)!)).toBe("{broken");
});

it("migrates settings an older Basalt kept in localStorage", async () => {
  const vault = await memoryVault();
  const key = legacyPluginDataKey("v1", "sample-sync");
  localStorage.setItem(key, '{"device":"laptop"}');
  localStorage.setItem(legacyPluginDataKey("v2", "sample-sync"), '{"other":1}');
  const store = new VaultPluginDataStore(
    vault,
    "v1",
    localStorage,
    undefined,
    NOW,
  );
  expect(await store.read("sample-sync")).toEqual({ device: "laptop" });
  await store.write("sample-sync", { device: "laptop", seen: true });
  expect(localStorage.getItem(key)).toBeNull();
  // Another vault's legacy entry is not this store's to touch.
  expect(
    localStorage.getItem(legacyPluginDataKey("v2", "sample-sync")),
  ).not.toBeNull();
  expect(await store.read("sample-sync")).toEqual({
    device: "laptop",
    seen: true,
  });
});

it("prefers data.json over a leftover localStorage entry", async () => {
  const vault = await memoryVault({ [PATH]: '{"from":"file"}' });
  localStorage.setItem(
    legacyPluginDataKey("v1", "sample-sync"),
    '{"from":"old"}',
  );
  const store = new VaultPluginDataStore(
    vault,
    "v1",
    localStorage,
    undefined,
    NOW,
  );
  expect(await store.read("sample-sync")).toEqual({ from: "file" });
});

it("applies overlapping saves in call order", async () => {
  const vault = await memoryVault();
  const store = new VaultPluginDataStore(
    vault,
    "v1",
    localStorage,
    undefined,
    NOW,
  );
  await Promise.all([
    store.write("sample-sync", { n: 1 }),
    store.write("sample-sync", { n: 2 }),
    store.write("sample-sync", { n: 3 }),
  ]);
  expect(await store.read("sample-sync")).toEqual({ n: 3 });
});

it("keeps a failed save from blocking later ones", async () => {
  const vault = await memoryVault();
  const store = new VaultPluginDataStore(
    vault,
    "v1",
    localStorage,
    undefined,
    NOW,
  );
  await expect(store.write("sample-sync", undefined)).rejects.toThrow(
    TypeError,
  );
  await store.write("sample-sync", { ok: true });
  expect(await store.read("sample-sync")).toEqual({ ok: true });
});

it("rejects ids that could leave the plugin folder", async () => {
  const store = new VaultPluginDataStore(
    await memoryVault(),
    "v1",
    localStorage,
    undefined,
    NOW,
  );
  await expect(store.write("../notes", {})).rejects.toThrow(
    "Invalid plugin id",
  );
  await expect(store.read("a/b")).rejects.toThrow("Invalid plugin id");
});

describe("coalescing settings saves", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function setup(initial?: string) {
    const vault = await memoryVault(initial ? { [PATH]: initial } : {});
    const modify = vi.spyOn(vault, "modify");
    const create = vi.spyOn(vault, "create");
    const store = new VaultPluginDataStore(vault, "v1");
    const content = async () =>
      vault.read(vault.getFileByPath(PATH)!).then((text) => JSON.parse(text));
    return {
      vault,
      store,
      content,
      writes: () => modify.mock.calls.length + create.mock.calls.length,
    };
  }

  it("writes a burst of keystrokes once, after typing pauses", async () => {
    const { store, content, writes } = await setup('{"server":""}');
    const url = "https://sync.example.org";
    const saves: Promise<void>[] = [];
    for (let i = 1; i <= url.length; i++) {
      saves.push(store.write("sample-sync", { server: url.slice(0, i) }));
      await vi.advanceTimersByTimeAsync(120);
    }
    expect(writes()).toBe(0);
    await vi.advanceTimersByTimeAsync(PLUGIN_DATA_TIMING.debounceMs);
    await Promise.all(saves);
    expect(writes()).toBe(1);
    expect(await content()).toEqual({ server: url });
  });

  it("still saves at least every maxWaitMs while typing continues", async () => {
    const { store, writes } = await setup('{"n":0}');
    for (let i = 1; i <= 24; i++) {
      void store.write("sample-sync", { n: i });
      await vi.advanceTimersByTimeAsync(500);
    }
    // 12 s of steady typing: one write per 5 s window, not one per change.
    expect(writes()).toBe(2);
    await vi.advanceTimersByTimeAsync(PLUGIN_DATA_TIMING.debounceMs);
    expect(writes()).toBe(3);
  });

  it("returns the latest unsaved value to loadData", async () => {
    const { store, writes } = await setup('{"n":0}');
    void store.write("sample-sync", { n: 1 });
    void store.write("sample-sync", { n: 2 });
    expect(await store.read("sample-sync")).toEqual({ n: 2 });
    expect(writes()).toBe(1);
  });

  it("writes everything on flush and reports pending saves", async () => {
    const { store, content } = await setup();
    const saved = store.write("sample-sync", { token: "abc" });
    expect(store.hasPendingWrites()).toBe(true);
    await store.flush();
    await saved;
    expect(store.hasPendingWrites()).toBe(false);
    expect(await content()).toEqual({ token: "abc" });
  });

  it("skips the write (and its backup) when nothing changed", async () => {
    const { store, writes } = await setup('{\n  "a": 1\n}');
    void store.write("sample-sync", { a: 2 });
    void store.write("sample-sync", { a: 1 });
    await store.flush();
    expect(writes()).toBe(0);
  });

  it("writes directly after close, so onunload saves are not delayed", async () => {
    const { store, content, writes } = await setup('{"n":0}');
    void store.write("sample-sync", { n: 1 });
    await store.close();
    expect(writes()).toBe(1);
    await store.write("sample-sync", { n: 2 });
    expect(writes()).toBe(2);
    expect(await content()).toEqual({ n: 2 });
  });

  it("rejects invalid values at once and rejects all waiters of a failed write", async () => {
    const { vault, store } = await setup('{"n":0}');
    await expect(store.write("sample-sync", undefined)).rejects.toThrow(
      TypeError,
    );
    vi.spyOn(vault, "modify").mockRejectedValueOnce(new Error("disk full"));
    const first = store.write("sample-sync", { n: 1 });
    const second = store.write("sample-sync", { n: 2 });
    const checks = Promise.all([
      expect(first).rejects.toThrow("disk full"),
      expect(second).rejects.toThrow("disk full"),
    ]);
    await vi.advanceTimersByTimeAsync(PLUGIN_DATA_TIMING.debounceMs);
    await checks;
  });
});
