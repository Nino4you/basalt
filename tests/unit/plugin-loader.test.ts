import { describe, expect, it } from "vitest";
import type { FileEntry, FileStats } from "../../src/compat/files";
import { Plugin, PluginRegistry } from "../../src/compat/plugin";
import { VaultPluginBundles } from "../../src/compat/plugin-bundles";
import { PluginBundleHost } from "../../src/compat/plugin-host";
import {
  loadPluginConstructor,
  parsePluginManifest,
} from "../../src/compat/plugin-module";
import type { VaultStoragePort } from "../../src/compat/storage-port";
import { Vault } from "../../src/compat/vault";

const encoder = new TextEncoder();

interface Stored {
  data: Uint8Array;
  stat: FileStats;
}

class Port implements VaultStoragePort {
  readonly vaultId = "plugin-test";
  private readonly files = new Map<string, Stored>();
  private clock = 0;

  seed(path: string, text: string | Uint8Array): void {
    const data = typeof text === "string" ? encoder.encode(text) : text;
    const at = ++this.clock;
    this.files.set(path, {
      data,
      stat: { ctime: at, mtime: at, size: data.byteLength },
    });
  }

  async snapshot(): Promise<FileEntry[]> {
    return [...this.files.entries()]
      .sort(([first], [second]) => (first < second ? -1 : 1))
      .map(([path, { stat }]) => ({ path, kind: "file", stat: { ...stat } }));
  }

  async read(
    path: string,
  ): Promise<{ bytes: Uint8Array; version: string; stat: FileStats }> {
    const stored = this.files.get(path);
    if (!stored) throw new Error(`ENOENT: ${path}`);
    return {
      bytes: new Uint8Array(stored.data),
      version: `v${stored.stat.mtime}`,
      stat: { ...stored.stat },
    };
  }

  async create(): Promise<{ version: string; stat: FileStats }> {
    throw new Error("not used");
  }

  async write(): Promise<{ version: string; stat: FileStats }> {
    throw new Error("not used");
  }

  async mkdir(): Promise<void> {
    throw new Error("not used");
  }
}

function manifest(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    name: `Plugin ${id}`,
    version: "1.0.0",
    minAppVersion: "1.0.0",
    ...extra,
  });
}

const FIXTURE = `
const { Plugin } = require("obsidian");
class Fixture extends Plugin {
  async onload() {
    this.app.loads = (this.app.loads || 0) + 1;
  }
  onunload() {
    this.app.loads = (this.app.loads || 0) - 1;
  }
}
module.exports = Fixture;
`;

async function harness() {
  const port = new Port();
  port.seed("Basalt/Plugins/fixture/manifest.json", manifest("fixture"));
  port.seed("Basalt/Plugins/fixture/main.js", FIXTURE);
  port.seed("Basalt/Plugins/fixture/styles.css", ".fixture { color: red; }");
  const vault = new Vault(port, "Vault");
  await vault.initialize();
  const bundles = new VaultPluginBundles(vault);
  const registry = new PluginRegistry(
    {},
    {
      async read() {
        return null;
      },
      async write() {},
    },
    false,
  );
  const host = new PluginBundleHost({
    bundles,
    registry,
    moduleHost: { obsidian: { Plugin } },
  });
  return { port, vault, bundles, registry, host };
}

describe("plugin manifests and CommonJS loading", () => {
  it("validates, trims and freezes manifests", () => {
    const parsed = parsePluginManifest(
      {
        id: "fixture",
        name: "  Fixture  ",
        version: " 1.2.3 ",
        minAppVersion: "1.0.0",
        isDesktopOnly: false,
        ignored: "field",
      },
      "fixture",
    );
    expect(parsed).toEqual({
      id: "fixture",
      name: "Fixture",
      version: "1.2.3",
      minAppVersion: "1.0.0",
      isDesktopOnly: false,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => parsePluginManifest({ ...parsed, id: "Other" })).toThrow(
      /invalid id/,
    );
    expect(() => parsePluginManifest({ ...parsed }, "other")).toThrow(
      /does not match/,
    );
    expect(() => parsePluginManifest({ ...parsed, name: " " })).toThrow(/name/);
  });

  it("evaluates a bundle without activating it and injects obsidian", () => {
    const obsidian = { Plugin, marker: "host" };
    const Constructor = loadPluginConstructor(FIXTURE, "fixture", { obsidian });
    expect(Constructor.prototype).toBeInstanceOf(Plugin);
    const app = {};
    const plugin = new Constructor(app, {
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
    });
    expect(plugin).toBeInstanceOf(Plugin);
    expect((app as { loads?: number }).loads).toBeUndefined();
  });

  it("rejects unsupported modules, non-plugin exports and syntax errors", () => {
    expect(() =>
      loadPluginConstructor(
        'require("fs"); module.exports = class extends require("obsidian").Plugin {};',
        "fixture",
        { obsidian: { Plugin } },
      ),
    ).toThrow(/unavailable module: fs/);
    expect(() =>
      loadPluginConstructor("module.exports = 42;", "fixture", {
        obsidian: { Plugin },
      }),
    ).toThrow(/does not export/);
    expect(() =>
      loadPluginConstructor(
        "module.exports = class NotAPlugin {};",
        "fixture",
        { obsidian: { Plugin } },
      ),
    ).toThrow(/must extend/);
    expect(() =>
      loadPluginConstructor("module.exports = ;", "fixture", {
        obsidian: { Plugin },
      }),
    ).toThrow(/could not be compiled/);
  });
});

describe("vault plugin bundles", () => {
  it("lists valid and broken folders without evaluating source", async () => {
    const port = new Port();
    port.seed("Basalt/Plugins/good/manifest.json", manifest("good"));
    port.seed(
      "Basalt/Plugins/good/main.js",
      'throw new Error("must not run during discovery");',
    );
    port.seed("Basalt/Plugins/broken/manifest.json", manifest("other"));
    port.seed("Basalt/Plugins/broken/main.js", FIXTURE);
    port.seed("Basalt/Plugins/invalid*/manifest.json", manifest("bad"));
    const vault = new Vault(port, "Vault");
    await vault.initialize();
    const listings = await new VaultPluginBundles(vault).list();
    expect(listings.map((entry) => entry.id)).toEqual([
      "broken",
      "good",
      "invalid*",
    ]);
    expect(listings[0].error).toMatch(/does not match/);
    expect(listings[1].manifest?.id).toBe("good");
    expect(listings[2].error).toMatch(/valid plugin id/);
  });

  it("reads source and styles with id and size checks", async () => {
    const { bundles, port } = await harness();
    const bundle = await bundles.read("fixture");
    expect(bundle.manifest.name).toBe("Plugin fixture");
    expect(bundle.source).toContain("class Fixture");
    expect(bundle.styles).toContain(".fixture");
    await expect(bundles.read("../fixture")).rejects.toThrow(/Invalid/);
    await expect(bundles.read("missing")).rejects.toThrow(/manifest/);

    port.seed("Basalt/Plugins/fixture/manifest.json", "x".repeat(65 * 1024));
    await expect(bundles.read("fixture")).rejects.toThrow(/64 KiB/);
    await expect(bundles.list()).resolves.toEqual([
      expect.objectContaining({ id: "fixture", error: expect.any(String) }),
    ]);
  });
});

describe("plugin bundle host", () => {
  it("activates and disables one explicit bundle with scoped styles", async () => {
    const { host, registry } = await harness();
    const style = () =>
      document.head.querySelector('style[data-basalt-plugin="fixture"]');
    expect(style()).toBeNull();
    expect(await host.list()).toEqual([
      expect.objectContaining({ id: "fixture", error: null }),
    ]);
    expect(style()).toBeNull();

    const plugin = await host.enable("fixture");
    expect(plugin.manifest.id).toBe("fixture");
    expect(plugin.manifest.dir).toBe(".obsidian/plugins/fixture");
    expect(host.isEnabled("fixture")).toBe(true);
    expect(registry.enabledPlugins.has("fixture")).toBe(true);
    expect(style()?.textContent).toContain(".fixture");
    expect(await host.enable("fixture")).toBe(plugin);

    await host.disable("fixture");
    expect(host.isEnabled("fixture")).toBe(false);
    expect(registry.enabledPlugins.has("fixture")).toBe(false);
    expect(style()).toBeNull();
  });

  it("removes injected styles when activation fails", async () => {
    const port = new Port();
    port.seed("Basalt/Plugins/fixture/manifest.json", manifest("fixture"));
    port.seed(
      "Basalt/Plugins/fixture/main.js",
      'const { Plugin } = require("obsidian"); module.exports = class Broken extends Plugin { onload() { throw new Error("boom"); } };',
    );
    port.seed("Basalt/Plugins/fixture/styles.css", ".fixture { color: red; }");
    const { vault } = await harnessWith(port);
    const failing = new PluginBundleHost({
      bundles: new VaultPluginBundles(vault),
      registry: new PluginRegistry(
        {},
        {
          async read() {
            return null;
          },
          async write() {},
        },
        false,
      ),
      moduleHost: { obsidian: { Plugin } },
    });
    await expect(failing.enable("fixture")).rejects.toThrow("boom");
    expect(
      document.head.querySelector('style[data-basalt-plugin="fixture"]'),
    ).toBeNull();
  });
});

async function harnessWith(port: Port) {
  const vault = new Vault(port, "Vault");
  await vault.initialize();
  return { vault };
}
