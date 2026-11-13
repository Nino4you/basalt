import { expect, it } from "vitest";
import { Plugin, PluginRegistry } from "../../src/compat/plugin";
import { PluginBundleHost } from "../../src/compat/plugin-host";
import type {
  VaultPluginBundles,
  PluginBundle,
} from "../../src/compat/plugin-bundles";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  readGate?: ReturnType<typeof deferred>,
  loadGate?: ReturnType<typeof deferred>,
) {
  const app = { evaluations: 0, loads: 0, unloads: 0, wait: loadGate?.promise };
  const registry = new PluginRegistry(app, {
    async read() {
      return null;
    },
    async write() {},
  });
  const bundle: PluginBundle = {
    id: "fixture",
    manifest: { id: "fixture", name: "Fixture", version: "1" },
    source: `const { Plugin, testApp } = require("obsidian");
      testApp.evaluations++;
      module.exports = class extends Plugin {
        async onload() { this.app.loads++; if (this.app.wait) await this.app.wait; }
        onunload() { this.app.unloads++; }
      };`,
    styles: ".fixture { color: red; }",
  };
  const bundles = {
    async read() {
      await readGate?.promise;
      return bundle;
    },
  } as unknown as VaultPluginBundles;
  const host = new PluginBundleHost({
    bundles,
    registry,
    moduleHost: { obsidian: { Plugin, testApp: app } },
  });
  return { host, registry, app };
}

it("deduplicates concurrent enables including module evaluation and styles", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([
    f.host.enable("fixture"),
    f.host.enable("fixture"),
  ]);
  expect(first).toBe(second);
  expect(f.app.evaluations).toBe(1);
  expect(f.app.loads).toBe(1);
  expect(
    document.querySelectorAll('style[data-basalt-plugin="fixture"]'),
  ).toHaveLength(1);
  await f.host.dispose();
  expect(f.app.unloads).toBe(1);
  expect(
    document.querySelectorAll('style[data-basalt-plugin="fixture"]'),
  ).toHaveLength(0);
});

it("cancels reads before evaluation when the host is disposed", async () => {
  const read = deferred();
  const f = fixture(read);
  const loading = f.host.enable("fixture");
  const stopped = f.host.dispose();
  read.resolve();
  await expect(loading).rejects.toThrow(/cancelled/);
  await stopped;
  expect(f.app.evaluations).toBe(0);
  expect(f.registry.enabledPlugins.size).toBe(0);
  await expect(f.host.enable("fixture")).rejects.toThrow(/disposed/);
});

it("cancels an async onload and waits for cleanup without re-enabling it", async () => {
  const load = deferred();
  const f = fixture(undefined, load);
  const loading = f.host.enable("fixture");
  // Let bundle read, evaluation and registry activation microtasks start.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(f.app.loads).toBe(1);
  const stopping = f.host.disable("fixture");
  expect(f.app.unloads).toBe(1);
  load.resolve();
  await expect(loading).rejects.toThrow(/cancelled/);
  await stopping;
  expect(f.host.isEnabled("fixture")).toBe(false);
  expect(f.registry.enabledPlugins.size).toBe(0);
  expect(
    document.querySelectorAll('style[data-basalt-plugin="fixture"]'),
  ).toHaveLength(0);
});
