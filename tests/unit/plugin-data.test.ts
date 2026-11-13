import { beforeEach, expect, it } from "vitest";
import { TFile } from "../../src/compat/files";
import {
  legacyPluginDataKey,
  VaultPluginDataStore,
} from "../../src/compat/plugin-data";
import { memoryVault } from "../helpers/vault-store";

beforeEach(() => localStorage.clear());

const PATH = "Basalt/Plugins/sample-sync/data.json";

it("returns null before a plugin saved anything", async () => {
  const store = new VaultPluginDataStore(await memoryVault(), "v1");
  expect(await store.read("sample-sync")).toBeNull();
});

it("writes data.json into the plugin folder like Obsidian", async () => {
  const vault = await memoryVault({
    "Basalt/Plugins/sample-sync/manifest.json": "{}",
  });
  const store = new VaultPluginDataStore(vault, "v1");
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
  const store = new VaultPluginDataStore(vault, "v1");
  await store.write("compiled", [1, 2]);
  expect(vault.getFolderByPath("Basalt/Plugins/compiled")).not.toBeNull();
  expect(await store.read("compiled")).toEqual([1, 2]);
});

it("reads an existing data.json copied over from Obsidian", async () => {
  const vault = await memoryVault({ [PATH]: '{"token":"abc"}' });
  const store = new VaultPluginDataStore(vault, "v1");
  expect(await store.read("sample-sync")).toEqual({ token: "abc" });
});

it("treats an empty data.json as no data", async () => {
  const vault = await memoryVault({ [PATH]: "  \n" });
  expect(await new VaultPluginDataStore(vault, "v1").read("sample-sync")).toBeNull();
});

it("refuses to parse a broken data.json and leaves it untouched", async () => {
  const vault = await memoryVault({ [PATH]: "{broken" });
  const store = new VaultPluginDataStore(vault, "v1");
  await expect(store.read("sample-sync")).rejects.toThrow("not valid JSON");
  expect(await vault.read(vault.getFileByPath(PATH)!)).toBe("{broken");
});

it("migrates settings an older Basalt kept in localStorage", async () => {
  const vault = await memoryVault();
  const key = legacyPluginDataKey("v1", "sample-sync");
  localStorage.setItem(key, '{"device":"laptop"}');
  localStorage.setItem(legacyPluginDataKey("v2", "sample-sync"), '{"other":1}');
  const store = new VaultPluginDataStore(vault, "v1");
  expect(await store.read("sample-sync")).toEqual({ device: "laptop" });
  await store.write("sample-sync", { device: "laptop", seen: true });
  expect(localStorage.getItem(key)).toBeNull();
  // Another vault's legacy entry is not this store's to touch.
  expect(
    localStorage.getItem(legacyPluginDataKey("v2", "sample-sync")),
  ).not.toBeNull();
  expect(await store.read("sample-sync")).toEqual({ device: "laptop", seen: true });
});

it("prefers data.json over a leftover localStorage entry", async () => {
  const vault = await memoryVault({ [PATH]: '{"from":"file"}' });
  localStorage.setItem(legacyPluginDataKey("v1", "sample-sync"), '{"from":"old"}');
  const store = new VaultPluginDataStore(vault, "v1");
  expect(await store.read("sample-sync")).toEqual({ from: "file" });
});

it("applies overlapping saves in call order", async () => {
  const vault = await memoryVault();
  const store = new VaultPluginDataStore(vault, "v1");
  await Promise.all([
    store.write("sample-sync", { n: 1 }),
    store.write("sample-sync", { n: 2 }),
    store.write("sample-sync", { n: 3 }),
  ]);
  expect(await store.read("sample-sync")).toEqual({ n: 3 });
});

it("keeps a failed save from blocking later ones", async () => {
  const vault = await memoryVault();
  const store = new VaultPluginDataStore(vault, "v1");
  await expect(store.write("sample-sync", undefined)).rejects.toThrow(TypeError);
  await store.write("sample-sync", { ok: true });
  expect(await store.read("sample-sync")).toEqual({ ok: true });
});

it("rejects ids that could leave the plugin folder", async () => {
  const store = new VaultPluginDataStore(await memoryVault(), "v1");
  await expect(store.write("../notes", {})).rejects.toThrow(
    "Invalid plugin id",
  );
  await expect(store.read("a/b")).rejects.toThrow("Invalid plugin id");
});
