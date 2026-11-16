import { describe, expect, it, vi } from "vitest";
import {
  Plugin,
  PluginRegistry,
  type PluginManifest,
} from "../../src/compat/plugin";
import {
  parseObsidianUrl,
  PluginServices,
} from "../../src/compat/plugin-services";
import { renderMarkdown } from "../../src/markdown";

const manifest = (id: string): PluginManifest => ({
  id,
  name: id,
  version: "1.0.0",
});

describe("obsidian:// protocol handlers", () => {
  it("parses the action and its parameters", () => {
    expect(
      parseObsidianUrl("obsidian://omnisearch?query=two%20words&vault=V"),
    ).toEqual({ action: "omnisearch", query: "two words", vault: "V" });
    expect(parseObsidianUrl("obsidian://open/")).toEqual({ action: "open" });
    expect(parseObsidianUrl("https://example.com")).toBeNull();
    // The action always comes from the host part.
    expect(parseObsidianUrl("obsidian://a?action=b")).toEqual({ action: "a" });
  });

  it("runs the registered handler and forgets it when the plugin unloads", async () => {
    const services = new PluginServices();
    const app = {};
    new PluginRegistry(
      app,
      { read: async () => undefined, write: async () => {} },
      false,
      undefined,
      services,
    );
    const plugin = new Plugin(app, manifest("search"));
    const handler = vi.fn();
    plugin.registerObsidianProtocolHandler("omnisearch", handler);
    expect(() =>
      new Plugin(app, manifest("other")).registerObsidianProtocolHandler(
        "omnisearch",
        () => {},
      ),
    ).toThrow(/already registered/);

    expect(services.handleObsidianUrl("obsidian://omnisearch?query=x")).toBe(
      true,
    );
    await Promise.resolve();
    expect(handler).toHaveBeenCalledWith({ action: "omnisearch", query: "x" });
    expect(services.handleObsidianUrl("obsidian://unknown")).toBe(false);

    plugin.unload();
    expect(services.handleObsidianUrl("obsidian://omnisearch")).toBe(false);
  });

  it("keeps obsidian:// links in rendered Markdown, but not script URLs", () => {
    const html = renderMarkdown(
      "[find](obsidian://omnisearch?query=x) [bad](javascript:alert(1))",
    );
    expect(html).toContain('href="obsidian://omnisearch?query=x"');
    expect(html).not.toContain("javascript:");
  });
});
