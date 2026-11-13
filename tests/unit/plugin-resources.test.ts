import { describe, expect, it, vi } from "vitest";
import { VaultAdapter } from "../../src/compat/adapter";
import type { FileEntry } from "../../src/compat/files";
import { Plugin, PluginRegistry } from "../../src/compat/plugin";
import type {
  PluginBundle,
  VaultPluginBundles,
} from "../../src/compat/plugin-bundles";
import { PluginBundleHost } from "../../src/compat/plugin-host";
import {
  NativePluginResources,
  PluginResourceUrls,
  type PluginResourceHost,
} from "../../src/compat/plugin-resources";
import type { VaultStoragePort } from "../../src/compat/storage-port";
import { ScopedVaultPort } from "../../src/compat/scoped-port";
import { Vault } from "../../src/compat/vault";

const TOKEN = "a".repeat(64);
const BASE = `basalt-resource://localhost/${TOKEN}/`;

class FakeHost implements PluginResourceHost {
  readonly granted = new Set<string>();
  readonly calls: string[] = [];
  async grant(id: string) {
    this.calls.push(`grant ${id}`);
    this.granted.add(id);
    return BASE;
  }
  async revoke(id: string) {
    this.calls.push(`revoke ${id}`);
    this.granted.delete(id);
  }
}

class EmptyPort implements VaultStoragePort {
  readonly vaultId = "resources";
  constructor(private readonly folders: string[]) {}
  async snapshot(): Promise<FileEntry[]> {
    return this.folders.map((path) => ({ path, kind: "folder" }));
  }
  read(): never {
    throw new Error("unused");
  }
  create(): never {
    throw new Error("unused");
  }
  write(): never {
    throw new Error("unused");
  }
  remove(): never {
    throw new Error("unused");
  }
  mkdir(): never {
    throw new Error("unused");
  }
}

async function adapterWith(resources: PluginResourceUrls) {
  const port = new EmptyPort(["Basalt", "Basalt/Plugins", "Notes"]);
  const vault = new Vault(ScopedVaultPort.content(port), "Vault");
  const config = new Vault(ScopedVaultPort.pluginConfig(port), "Vault");
  await vault.initialize();
  await config.initialize();
  return new VaultAdapter(vault, null, config, resources);
}

describe("plugin resource URLs", () => {
  it("serve only folders of activated plugins, encoded per segment", async () => {
    const host = new FakeHost();
    const resources = new PluginResourceUrls(host);
    const adapter = await adapterWith(resources);
    const lang = ".obsidian/plugins/sample-ink/models/tesseract";
    expect(() => adapter.getResourcePath(lang)).toThrow(/activated plugins/);

    await resources.grant("sample-ink");
    // Works without a desktop base path (Android SAF) and for folders.
    expect(adapter.getResourcePath(lang)).toBe(`${BASE}models/tesseract`);
    expect(
      adapter.getResourcePath(
        ".obsidian/plugins/sample-ink/A b/ü#?.bin",
      ),
    ).toBe(`${BASE}A%20b/%C3%BC%23%3F.bin`);
    expect(() =>
      adapter.getResourcePath(".obsidian/plugins/sample-sheet/main.js"),
    ).toThrow(/activated plugins/);
    // Note content and hidden or escaping paths never get resource URLs.
    for (const path of [
      "Notes/bild.png",
      "Basalt/Plugins/sample-ink/main.js",
      ".obsidian/plugins/sample-ink/.secret",
      ".obsidian/plugins/sample-ink/../sample-sheet/x",
      ".obsidian/app.json",
    ])
      expect(() => adapter.getResourcePath(path), path).toThrow();

    await resources.revoke("sample-ink");
    expect(host.calls).toEqual([
      "grant sample-ink",
      "revoke sample-ink",
    ]);
    expect(() => adapter.getResourcePath(lang)).toThrow(/activated plugins/);
  });

  it("are unavailable without a native resource host", async () => {
    const adapter = await adapterWith(new PluginResourceUrls(null));
    expect(() =>
      adapter.getResourcePath(".obsidian/plugins/ink/models"),
    ).toThrow(/No resource URLs are available/);
  });

  it("accept only well-formed native grant URLs", async () => {
    const calls: unknown[] = [];
    let answer: unknown = BASE;
    const native = new NativePluginResources(
      "vault-1",
      async (command, args) => {
        calls.push([command, args]);
        return answer;
      },
    );
    expect(await native.grant("ink")).toBe(BASE);
    answer = `http://basalt-resource.localhost/${TOKEN}/`;
    expect(await native.grant("ink")).toBe(answer);
    for (answer of [
      "https://example.com/",
      `basalt-resource://localhost/${TOKEN}`,
      `basalt-resource://localhost/${TOKEN}/../`,
      "basalt-resource://localhost/short/",
      42,
    ])
      await expect(native.grant("ink")).rejects.toThrow(/invalid URL/);
    await native.revoke("ink");
    expect(calls[0]).toEqual([
      "plugin_resource_grant",
      { vaultId: "vault-1", pluginId: "ink" },
    ]);
    expect(calls.at(-1)).toEqual([
      "plugin_resource_revoke",
      { vaultId: "vault-1", pluginId: "ink" },
    ]);
  });
});

describe("plugin host resource grants", () => {
  function fixture(host: PluginResourceHost) {
    const seen: { url: string | null } = { url: null };
    const resources = new PluginResourceUrls(host);
    const registry = new PluginRegistry(
      { seen, resources },
      {
        async read() {
          return null;
        },
        async write() {},
      },
    );
    const bundle: PluginBundle = {
      id: "ink",
      manifest: { id: "ink", name: "Ink", version: "1" },
      source: `const { Plugin } = require("obsidian");
        module.exports = class extends Plugin {
          onload() { this.app.seen.url = this.app.resources.url("ink", "models"); }
        };`,
      styles: null,
    };
    const bundles = {
      async read() {
        return bundle;
      },
    } as unknown as VaultPluginBundles;
    const bundleHost = new PluginBundleHost({
      bundles,
      registry,
      resources,
      moduleHost: { obsidian: { Plugin } },
    });
    return { bundleHost, resources, seen };
  }

  it("grants before onload and revokes on disable and dispose", async () => {
    const host = new FakeHost();
    const f = fixture(host);
    await f.bundleHost.enable("ink");
    expect(f.seen.url).toBe(`${BASE}models`);
    await f.bundleHost.disable("ink");
    expect(host.granted.size).toBe(0);
    expect(f.resources.url("ink", "models")).toBeNull();
    await f.bundleHost.enable("ink");
    await f.bundleHost.dispose();
    expect(host.calls).toEqual([
      "grant ink",
      "revoke ink",
      "grant ink",
      "revoke ink",
    ]);
  });

  it("does not activate a plugin whose grant fails", async () => {
    const host = new FakeHost();
    host.grant = vi.fn(async () => {
      throw new Error("vault changed");
    });
    const f = fixture(host);
    await expect(f.bundleHost.enable("ink")).rejects.toThrow(/vault changed/);
    expect(f.seen.url).toBeNull();
    expect(f.bundleHost.isEnabled("ink")).toBe(false);
  });
});
