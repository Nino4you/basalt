import { describe, expect, it } from "vitest";
import { TFile } from "../../src/compat/files";
import {
  CATALOG_URL,
  compareVersions,
  downloadRelease,
  installedSource,
  installPlugin,
  latestManifest,
  loadCatalog,
  parseCatalog,
  parseRepo,
  searchCatalog,
  STATS_URL,
  uninstallPlugin,
  validatePluginFiles,
} from "../../src/compat/plugin-catalog";
import type { RequestUrl } from "../../src/compat/request";
import { ScopedVaultPort } from "../../src/compat/scoped-port";
import { Vault } from "../../src/compat/vault";
import { MemoryPort, memoryVault } from "../helpers/vault-store";

/** A network of fixed responses; anything else is a 404. */
function network(pages: Record<string, unknown>): {
  request: RequestUrl;
  asked: string[];
} {
  const asked: string[] = [];
  const request: RequestUrl = async (param) => {
    const url = typeof param === "string" ? param : param.url;
    asked.push(url);
    const body = pages[url];
    const status = body === undefined ? 404 : 200;
    const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
    const shouldThrow = typeof param === "string" || param.throw !== false;
    if (status >= 400 && shouldThrow) throw new Error(`HTTP ${status}`);
    return {
      status,
      headers: {},
      arrayBuffer: new TextEncoder().encode(text).buffer,
      text,
      get json() {
        return JSON.parse(text);
      },
    };
  };
  return { request, asked };
}

const release = (repo: string, file: string) =>
  `https://github.com/${repo}/releases/latest/download/${file}`;

const manifest = (id: string, version = "1.0.0") =>
  JSON.stringify({
    id,
    name: `Name of ${id}`,
    version,
    minAppVersion: "1.0.0",
  });

const catalog = [
  {
    id: "calendar",
    name: "Calendar",
    author: "Liam",
    description: "A calendar view",
    repo: "liamcain/obsidian-calendar-plugin",
  },
  {
    id: "obsidian-excalidraw-plugin",
    name: "Excalidraw",
    author: "Zsolt",
    description: "Drawings",
    repo: "zsviczian/obsidian-excalidraw-plugin",
  },
  {
    id: "dataview",
    name: "Dataview",
    author: "Michael",
    description: "Query your notes like a database",
    repo: "blacksmithgu/obsidian-dataview",
  },
  { id: "Bad Id", name: "Broken", author: "x", description: "", repo: "a/b" },
  {
    id: "no-repo",
    name: "No repo",
    author: "x",
    description: "",
    repo: "not a repo",
  },
  {
    id: "calendar",
    name: "Duplicate",
    author: "x",
    description: "",
    repo: "a/b",
  },
];

describe("catalog", () => {
  it("keeps valid entries with download counts and verified versions", async () => {
    const { request } = network({
      [CATALOG_URL]: catalog,
      [STATS_URL]: {
        dataview: { downloads: 3000 },
        calendar: { downloads: 1000 },
      },
    });
    const entries = await loadCatalog(request);
    expect(entries.map((entry) => entry.id)).toEqual([
      "calendar",
      "obsidian-excalidraw-plugin",
      "dataview",
    ]);
    expect(entries[2].downloads).toBe(3000);
    expect(entries[1].verified).toBe("2.29.2");
    expect(entries[0].verified).toBeNull();
    expect(() => parseCatalog({})).toThrow();
  });

  it("still loads without download counts", async () => {
    const { request } = network({ [CATALOG_URL]: catalog });
    expect(
      (await loadCatalog(request)).every((entry) => entry.downloads === 0),
    ).toBe(true);
  });

  it("ranks checked plugins, then name matches, then popular ones", () => {
    const entries = parseCatalog(catalog, {
      dataview: { downloads: 3000 },
      calendar: { downloads: 1000 },
    });
    expect(searchCatalog(entries, "").map((entry) => entry.id)).toEqual([
      "obsidian-excalidraw-plugin",
      "dataview",
      "calendar",
    ]);
    expect(searchCatalog(entries, "database").map((entry) => entry.id)).toEqual(
      ["dataview"],
    );
    expect(searchCatalog(entries, "cal view").map((entry) => entry.id)).toEqual(
      ["calendar"],
    );
    expect(searchCatalog(entries, "zzz")).toEqual([]);
  });
});

describe("parseRepo", () => {
  it("accepts the short form and GitHub URLs", () => {
    expect(parseRepo("owner/repo")).toBe("owner/repo");
    expect(parseRepo(" https://github.com/owner/repo.git ")).toBe("owner/repo");
    expect(parseRepo("https://github.com/owner/repo/releases/tag/1.0")).toBe(
      "owner/repo",
    );
    for (const value of [
      "",
      "owner",
      "https://example.com/a/b",
      "a/b c",
      "-x/y",
    ])
      expect(parseRepo(value), value).toBeNull();
  });
});

describe("plugin files", () => {
  it("checks the manifest, its id and the size limits", () => {
    expect(
      validatePluginFiles(manifest("demo"), "module.exports = {}", null)
        .manifest.id,
    ).toBe("demo");
    expect(() =>
      validatePluginFiles(manifest("demo"), "x", null, "other"),
    ).toThrow("does not match");
    expect(() => validatePluginFiles("{", "x", null)).toThrow("not valid JSON");
    expect(() => validatePluginFiles(manifest("demo"), "  ", null)).toThrow(
      "empty",
    );
    expect(() =>
      validatePluginFiles(manifest("demo"), "x", "a".repeat(1024 * 1024 + 1)),
    ).toThrow("1 MiB");
  });

  it("downloads the latest release, styles optional", async () => {
    const repo = "owner/demo";
    const { request } = network({
      [release(repo, "manifest.json")]: manifest("demo", "2.0.0"),
      [release(repo, "main.js")]: "module.exports = class {}",
    });
    const files = await downloadRelease(repo, request, "demo");
    expect(files.manifest.version).toBe("2.0.0");
    expect(files.styles).toBeNull();
    expect((await latestManifest(repo, request)).version).toBe("2.0.0");
    await expect(downloadRelease("owner/none", request)).rejects.toThrow(
      "no release",
    );
    await expect(downloadRelease(repo, request, "other")).rejects.toThrow(
      "does not match",
    );
  });

  it("compares versions", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("v2.0", "2.0.0")).toBe(0);
    expect(compareVersions("2.0.0-beta.1", "2.0.0")).toBe(-1);
    expect(compareVersions("1.2", "1.2.1")).toBe(-1);
  });
});

describe("install", () => {
  it("installs, updates in place keeping settings, and uninstalls", async () => {
    const vault = await memoryVault({});
    const read = (path: string) => vault.read(vault.getFileByPath(path)!);
    const first = validatePluginFiles(manifest("demo"), "v1", ".a{}");
    expect(await installPlugin(vault, first, { repo: "owner/demo" })).toEqual({
      id: "demo",
      updated: false,
    });
    expect(await read("Basalt/Plugins/demo/main.js")).toBe("v1");
    expect(await read("Basalt/Plugins/demo/styles.css")).toBe(".a{}");
    expect(await installedSource(vault, "demo")).toMatchObject({
      repo: "owner/demo",
      version: "1.0.0",
    });

    await vault.create("Basalt/Plugins/demo/data.json", '{"kept":true}');
    const second = validatePluginFiles(manifest("demo", "1.1.0"), "v2", null);
    expect(
      (await installPlugin(vault, second, { repo: "owner/demo" })).updated,
    ).toBe(true);
    expect(await read("Basalt/Plugins/demo/main.js")).toBe("v2");
    expect(vault.getFileByPath("Basalt/Plugins/demo/styles.css")).toBeNull();
    expect(await read("Basalt/Plugins/demo/data.json")).toBe('{"kept":true}');
    expect((await installedSource(vault, "demo"))?.version).toBe("1.1.0");

    await uninstallPlugin(vault, "demo");
    expect(
      vault
        .getAllLoadedFiles()
        .filter(
          (entry) =>
            entry instanceof TFile &&
            entry.path.startsWith("Basalt/Plugins/demo/"),
        ),
    ).toEqual([]);
    await expect(uninstallPlugin(vault, "../x")).rejects.toThrow();
  });

  it("installs a local plugin without a source record", async () => {
    const vault = await memoryVault({});
    await installPlugin(
      vault,
      validatePluginFiles(manifest("mine"), "x", null),
      null,
    );
    expect(await installedSource(vault, "mine")).toBeNull();
    expect(
      vault.getFileByPath("Basalt/Plugins/mine/manifest.json"),
    ).not.toBeNull();
  });
});

it("installs through the plugin config view the app uses", async () => {
  const port = new MemoryPort({ "Note.md": "hi" });
  const config = new Vault(ScopedVaultPort.pluginConfig(port), "Vault");
  await config.initialize();
  await installPlugin(
    config,
    validatePluginFiles(manifest("scoped"), "x", null),
    null,
  );
  const content = new Vault(ScopedVaultPort.content(port), "Vault");
  await content.initialize();
  expect(config.getFileByPath("Basalt/Plugins/scoped/main.js")).not.toBeNull();
  // Plugin code stays out of the vault content plugins and sync see.
  expect(content.getFileByPath("Basalt/Plugins/scoped/main.js")).toBeNull();
});
