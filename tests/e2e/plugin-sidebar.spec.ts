import { expect, test } from "@playwright/test";

// A minimal plugin that opens its view in the right sidebar on layout ready,
// the way calendar or outline plugins do.
const MAIN = `
const { ItemView, Plugin } = require("obsidian");
class CounterView extends ItemView {
  getViewType() { return "sidebar-fixture"; }
  getDisplayText() { return "Sidebar fixture"; }
  getIcon() { return "calendar"; }
  async onOpen() { this.contentEl.createEl("p", { text: "Hello from the sidebar" }); }
}
module.exports = class extends Plugin {
  async onload() {
    this.registerView("sidebar-fixture", (leaf) => new CounterView(leaf));
    this.app.workspace.onLayoutReady(async () => {
      if (this.app.workspace.getLeavesOfType("sidebar-fixture").length) return;
      await this.app.workspace.getRightLeaf(false).setViewState({ type: "sidebar-fixture", active: true });
    });
  }
};`;

test("plugin views open as sidebar panels and close with the plugin", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "android-layout",
    "Sidebar tabs are covered on desktop; phones reuse the same dock areas.",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tests/fixtures/vault.html");
  await page.evaluate(async (main) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [{ App }, { CompatibilitySession }, { MemoryPort }] =
      await Promise.all([
        load("/src/app/app.ts"),
        load("/src/compat/session.ts"),
        load("/tests/helpers/vault-store.ts"),
      ]);
    const app = new App(document.querySelector("#app"));
    await app.start();
    const port = new MemoryPort({
      "Note.md": "# Note",
      "Basalt/Plugins/sidebar-fixture/main.js": main,
      "Basalt/Plugins/sidebar-fixture/manifest.json": JSON.stringify({
        id: "sidebar-fixture",
        name: "Sidebar fixture",
        version: "1.0.0",
        minAppVersion: "1.0.0",
      }),
    });
    const session = await CompatibilitySession.create({
      vaultId: port.vaultId,
      name: "Sidebar test",
      mobile: false,
      port,
      editor: app.editor.compat,
      extensions: app.editor.extensions,
      container: app.shell.viewContent,
      navigate: () => {},
    });
    app.compatibility = session;
    app.bindPluginWorkspace(session);
    (window as any).sidebarTest = { app, session };
    await session.bundleHost.enable("sidebar-fixture");
  }, MAIN);

  const tab = page.getByRole("tab", { name: "Sidebar fixture", exact: true });
  await expect(tab).toBeVisible();
  const panel = page.getByRole("tabpanel", { name: "Sidebar fixture" });
  await expect(panel.getByText("Hello from the sidebar")).toBeVisible();
  await page.screenshot({ path: info.outputPath("sidebar.png") });

  // Back to another panel and again: the view stays mounted.
  await page.getByRole("tab", { name: "Tags", exact: true }).click();
  await expect(panel).toBeHidden();
  await tab.click();
  await expect(panel.getByText("Hello from the sidebar")).toBeVisible();

  // Closing the panel detaches the plugin's leaf, as in Obsidian.
  await tab.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Ansicht schließen" }).click();
  await expect(tab).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as any).sidebarTest.session.workspace.getLeavesOfType(
          "sidebar-fixture",
        ).length,
    ),
  ).toBe(0);

  // Reopening through the API puts it back; disabling the plugin removes it.
  await page.evaluate(() =>
    (window as any).sidebarTest.session.workspace.ensureSideLeaf(
      "sidebar-fixture",
      "right",
    ),
  );
  await expect(tab).toBeVisible();
  await page.evaluate(() =>
    (window as any).sidebarTest.session.bundleHost.disable("sidebar-fixture"),
  );
  await expect(tab).toHaveCount(0);
  expect(errors).toEqual([]);
});
