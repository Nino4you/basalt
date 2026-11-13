import { describe, expect, it, vi } from "vitest";
import { Component } from "../../src/compat/component";
import { EmbedRegistry, mountPluginEmbed } from "../../src/compat/embeds";
import { MetadataCache } from "../../src/compat/metadata-cache";
import { renderPluginMarkdown } from "../../src/compat/plugin-markdown";
import { PluginServices } from "../../src/compat/plugin-services";
import { memoryVault } from "../helpers/vault-store";

describe("plugin file embeds", () => {
  it("resolves relative files and sheet subpaths only for registered extensions", async () => {
    const vault = await memoryVault({
      "Notes/Table.xlsx": "",
      "Notes/A.md": "",
    });
    const registry = new EmbedRegistry(new MetadataCache(vault));
    expect(registry.resolve("Table.xlsx#Sheet 2", "Notes/A.md")).toBeNull();
    const factory = vi.fn();
    registry.registerExtension("xlsx", factory);
    const result = registry.resolve("Table.xlsx#Sheet 2", "Notes/A.md");
    expect(result?.file.path).toBe("Notes/Table.xlsx");
    expect(result?.subpath).toBe("#Sheet 2");
    expect(result?.factory).toBe(factory);
    expect(registry.resolve("Missing.xlsx", "Notes/A.md")).toBeNull();
    registry.unregisterExtension("xlsx");
    expect(registry.resolve("Table.xlsx", "Notes/A.md")).toBeNull();
  });

  it("loads in a mounted container and unloads when the owning view closes", async () => {
    const vault = await memoryVault({ "Table.xlsx": "" });
    const container = document.createElement("div");
    document.body.append(container);
    const owner = new Component();
    owner.load();
    const cleanup = vi.fn();
    class Embed extends Component {
      onload() {
        expect(container.isConnected).toBe(true);
        this.register(cleanup);
      }
      loadFile() {
        container.textContent = "cell A1";
      }
    }
    try {
      await mountPluginEmbed(
        {
          file: vault.getFileByPath("Table.xlsx")!,
          subpath: "",
          factory: () => new Embed(),
        },
        container,
        owner,
      );
      expect(container.textContent).toBe("cell A1");
      await owner.unloadAsync();
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      container.remove();
    }
  });

  it("cleans up a failed embed", async () => {
    const vault = await memoryVault({ "Table.xlsx": "" });
    const cleanup = vi.fn();
    class Broken extends Component {
      onload() {
        this.register(cleanup);
      }
      loadFile() {
        throw new Error("bad workbook");
      }
    }
    const owner = new Component();
    owner.load();
    await expect(
      mountPluginEmbed(
        {
          file: vault.getFileByPath("Table.xlsx")!,
          subpath: "",
          factory: () => new Broken(),
        },
        document.createElement("div"),
        owner,
      ),
    ).rejects.toThrow("bad workbook");
    expect(cleanup).toHaveBeenCalledOnce();
    await owner.unloadAsync();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("renders registered embeds in reading mode and leaves unsupported links intact", async () => {
    const vault = await memoryVault({ "Notes/Table.xlsx": "" });
    const embeds = new EmbedRegistry(new MetadataCache(vault));
    embeds.registerExtension(
      "xlsx",
      ({ containerEl }, file, subpath) =>
        new (class extends Component {
          loadFile() {
            containerEl.textContent = `${file.path}${subpath}:A1`;
          }
        })(),
    );
    const preview = document.createElement("div");
    preview.innerHTML =
      '<p><a class="internal-link is-embed" data-note="Table.xlsx#Two" data-source="Notes/A.md">Table</a></p><p><a class="internal-link is-embed" data-note="Missing.xlsx">Missing</a></p>';
    const owner = new Component();
    owner.load();
    await renderPluginMarkdown(
      preview,
      new PluginServices(),
      {
        sourcePath: "Other.md",
        app: {},
        embeds,
        addChild: (child) => owner.addChild(child),
      },
      () => true,
    );
    expect(preview.querySelector(".plugin-embed")?.textContent).toBe(
      "Notes/Table.xlsx#Two:A1",
    );
    expect(preview.querySelector('a[data-note="Missing.xlsx"]')).not.toBeNull();
    expect(preview.querySelector("p .plugin-embed")).toBeNull();
    await owner.unloadAsync();
  });
});
