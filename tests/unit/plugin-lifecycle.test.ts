import { describe, expect, it, vi } from "vitest";
import {
  Plugin,
  PluginRegistry,
  type PluginDataStore,
  type PluginManifest,
} from "../../src/compat";

const manifest = (id = "fixture"): PluginManifest => ({
  id,
  name: id,
  version: "0.0.1",
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function host(mobile = false) {
  const values = new Map<string, unknown>();
  const data: PluginDataStore = {
    read: async (id) => values.get(id),
    write: async (id, value) => {
      values.set(id, value);
    },
  };
  const registry = new PluginRegistry({}, data, mobile);
  return { registry, values };
}

describe("compiled plugin activation (no external bundle loader)", () => {
  it("awaits onload, deduplicates enabling, and publishes enabled state only on success", async () => {
    const { registry } = host();
    const gate = deferred();
    const started = deferred();
    class Fixture extends Plugin {
      override async onload() {
        started.resolve();
        await gate.promise;
      }
    }
    const first = registry.enable(manifest(), Fixture);
    const second = registry.enable(manifest(), Fixture);
    expect(second).toBe(first);
    await started.promise;
    expect(registry.enabledPlugins.has("fixture")).toBe(false);
    gate.resolve();
    const plugin = await first;
    expect(registry.plugins.fixture).toBe(plugin);
    expect(registry.enabledPlugins.has("fixture")).toBe(true);
    await registry.disable("fixture");
    expect(registry.plugins.fixture).toBeUndefined();
  });

  it("rolls back registered resources and removes failed plugins", async () => {
    const { registry } = host();
    const cleanup = vi.fn();
    class Broken extends Plugin {
      override async onload() {
        this.register(cleanup);
        throw new Error("load failed");
      }
    }
    await expect(registry.enable(manifest(), Broken)).rejects.toThrow(
      "load failed",
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(registry.plugins.fixture).toBeUndefined();
    expect(registry.enabledPlugins.size).toBe(0);
  });

  it("cancels activation and immediately disposes resources registered after unload", async () => {
    const { registry } = host();
    const gate = deferred();
    const started = deferred();
    const cleanup = vi.fn();
    class Slow extends Plugin {
      override async onload() {
        started.resolve();
        await gate.promise;
        this.register(cleanup);
      }
    }
    const enabling = registry.enable(manifest(), Slow);
    await started.promise;
    const stopping = registry.disable("fixture");
    expect(registry.plugins.fixture).toBeUndefined();
    gate.resolve();
    await expect(enabling).rejects.toThrow("cancelled");
    await stopping;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(registry.enabledPlugins.size).toBe(0);
  });

  it("waits for async shutdown before creating a replacement instance", async () => {
    const { registry } = host();
    const gate = deferred();
    const stopped = deferred();
    let started = 0;
    class Fixture extends Plugin {
      override onload() {
        started++;
      }
      override async onunload() {
        await gate.promise;
        stopped.resolve();
      }
    }
    await registry.enable(manifest(), Fixture);
    const disabling = registry.disable("fixture");
    const replacing = registry.enable(manifest(), Fixture);
    expect(started).toBe(1);
    gate.resolve();
    await disabling;
    await stopped.promise;
    await replacing;
    expect(started).toBe(2);
    await registry.disable("fixture");
  });

  it("isolates plugin JSON data and does not return mutable stored references", async () => {
    const { registry, values } = host();
    const first = await registry.enable(manifest("one"), Plugin);
    const second = await registry.enable(manifest("two"), Plugin);
    const settings = { nested: { count: 1 } };
    await first.saveData(settings);
    settings.nested.count = 10;
    expect(values.get("one")).toEqual({ nested: { count: 1 } });
    const loaded = (await first.loadData()) as typeof settings;
    loaded.nested.count = 20;
    expect(await first.loadData()).toEqual({ nested: { count: 1 } });
    expect(await second.loadData()).toBeNull();
    await expect(first.saveData(1n)).rejects.toThrow();
  });

  it("does not hand back a dying instance when shutdown re-enters the registry", async () => {
    const { registry } = host();
    let replacement: Promise<Plugin> | undefined;
    class Replacement extends Plugin {}
    class First extends Plugin {
      override onunload() {
        replacement = registry.enable(manifest(), Replacement);
      }
    }
    const first = await registry.enable(manifest(), First);
    await registry.disable("fixture");
    const next = await replacement;
    expect(next).toBeInstanceOf(Replacement);
    expect(next).not.toBe(first);
    await registry.disable("fixture");
  });

  it("rejects desktop-only plugins on mobile and invalid ids without constructing plugins", async () => {
    const { registry } = host(true);
    const Constructor = vi.fn();
    await expect(
      registry.enable({ ...manifest(), isDesktopOnly: true }, Constructor),
    ).rejects.toThrow("Desktop-only");
    expect(Constructor).not.toHaveBeenCalled();
    expect(() => registry.enable(manifest("../escape"), Plugin)).toThrow(
      "Invalid plugin id",
    );
    expect(() => registry.enable(manifest("__proto__"), Plugin)).toThrow(
      "Invalid plugin id",
    );
  });
});

it("registers hover link sources for the plugin's lifetime", () => {
  const workspace = {
    registerHoverLinkSource: vi.fn(),
    unregisterHoverLinkSource: vi.fn(),
  };
  const plugin = new Plugin({ workspace }, { id: "recent", name: "Recent", version: "1.0.0" });
  plugin.load();
  plugin.registerHoverLinkSource("recent", { display: "Recent files", defaultMod: true });
  expect(workspace.registerHoverLinkSource).toHaveBeenCalledWith("recent", { display: "Recent files", defaultMod: true });
  plugin.unload();
  expect(workspace.unregisterHoverLinkSource).toHaveBeenCalledWith("recent");
});
