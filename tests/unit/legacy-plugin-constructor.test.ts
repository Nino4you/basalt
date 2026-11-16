import { describe, expect, it } from "vitest";
import { createObsidianApi, PluginSettingTab } from "../../src/compat/obsidian-api";
import { Plugin, PluginRegistry } from "../../src/compat/plugin";
import { loadPluginConstructor } from "../../src/compat/plugin-module";

describe("ES5 plugin superclass construction", () => {
  it("rejects foreign receivers and still validates plugin manifests", () => {
    const manifest = { id: "legacy", name: "Legacy", version: "1.0.0" };
    expect(() => Reflect.apply(Plugin.call, Plugin, [{}, {}, manifest])).toThrow("derived receiver");
    expect(() => Reflect.apply(PluginSettingTab.apply, PluginSettingTab, [null, []])).toThrow("derived receiver");
    const receiver = Object.create(Plugin.prototype) as Plugin;
    expect(() => Plugin.call(receiver, {}, { ...manifest, id: "../invalid" })).toThrow("Invalid plugin id");
  });

  it.each(["call", "apply"])("supports compiled super.%s without replacing host classes", async (method) => {
    const app = { loads: 0, closes: 0, tab: null as PluginSettingTab | null };
    const api = createObsidianApi({ app });
    expect(api.Plugin).toBe(Plugin);
    expect(api.PluginSettingTab).toBe(PluginSettingTab);
    const source = `
      const { Plugin, PluginSettingTab } = require("obsidian");
      function LegacyTab(app, plugin) {
        return PluginSettingTab.${method}(this, ${method === "call" ? "app, plugin" : "arguments"}) || this;
      }
      Object.setPrototypeOf(LegacyTab, PluginSettingTab);
      LegacyTab.prototype = Object.create(PluginSettingTab.prototype);
      LegacyTab.prototype.constructor = LegacyTab;
      LegacyTab.prototype.display = function() { this.containerEl.textContent = "Legacy settings"; };
      function Legacy(app, manifest) {
        return Plugin.${method}(this, ${method === "call" ? "app, manifest" : "arguments"}) || this;
      }
      Object.setPrototypeOf(Legacy, Plugin);
      Legacy.prototype = Object.create(Plugin.prototype);
      Legacy.prototype.constructor = Legacy;
      Legacy.prototype.onload = function() {
        this.app.loads++;
        this.register(() => { this.app.closes++; });
        this.app.tab = new LegacyTab(this.app, this);
        this.app.tab.display();
      };
      module.exports = Legacy;
    `;
    const Constructor = loadPluginConstructor(source, "legacy", { obsidian: api });
    const registry = new PluginRegistry(app, { read: async () => null, write: async () => {} });
    const plugin = await registry.enable({ id: "legacy", name: "Legacy", version: "1.0.0" }, Constructor);
    expect(plugin).toBeInstanceOf(Plugin);
    expect(plugin).toBeInstanceOf(Constructor);
    expect(plugin._loaded).toBe(true);
    expect(app.loads).toBe(1);
    expect(app.tab).toBeInstanceOf(PluginSettingTab);
    expect(app.tab?.plugin).toBe(plugin);
    expect(app.tab?.containerEl.textContent).toBe("Legacy settings");
    await registry.disable("legacy");
    expect(plugin._loaded).toBe(false);
    expect(app.closes).toBe(1);
    expect(registry.plugins.legacy).toBeUndefined();
  });
});
