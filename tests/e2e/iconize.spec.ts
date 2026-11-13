import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginDirectories } from "../helpers/plugin-fixtures";

const id = "obsidian-icon-folder";
const directory = pluginDirectories().find(
  (path) =>
    JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")).id === id,
);

test("unchanged Iconize selects a custom icon through the file menu and disables cleanly", async ({
  page,
}, info) => {
  test.skip(
    !directory,
    "Set BASALT_PLUGIN_DIRS to an unchanged Iconize bundle",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()))
      errors.push(message.text());
  });
  const contents = Object.fromEntries(
    ["main.js", "manifest.json", "styles.css"].map((name) => [
      `Basalt/Plugins/${id}/${name}`,
      readFileSync(join(directory!, name), "utf8"),
    ]),
  );
  contents["Basalt/Config/icons/basalt-test/Test.svg"] =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>';
  await page.goto("/tests/fixtures/vault.html");
  const result = await page.evaluate(
    async ({ contents, mobile }) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const [{ App }, { CompatibilitySession }, { MemoryPort }] =
        await Promise.all([
          load("/src/app/app.ts"),
          load("/src/compat/session.ts"),
          load("/tests/helpers/vault-store.ts"),
        ]);
      const app = new App(document.querySelector("#app"));
      await app.start();
      const text = "# Test\n\n[[Note]]";
      const port = new MemoryPort({
        "Note.md": text,
        "Folder/Inner.md": "# Inner",
        ...contents,
      });
      const session = await CompatibilitySession.create({
        vaultId: port.vaultId,
        name: "Iconize browser test",
        mobile,
        port,
        editor: app.editor.compat,
        extensions: app.editor.extensions,
        container: app.shell.viewContent,
        navigate: () => {},
      });
      app.compatibility = session;
      app.bindPluginWorkspace(session);
      app.syncVisibleFiles();
      session.setActivePath("Note.md");
      app.editor.setText(text);
      (window as any).iconizeTest = { app, session, port };
      try {
        await session.bundleHost.enable("obsidian-icon-folder");
        const enabled = session.bundleHost.isEnabled("obsidian-icon-folder");
        const commands = session.services
          .getCommandsFor("obsidian-icon-folder")
          .map((command: { id: string }) => command.id);
        const icons = await session.vault.adapter.exists(".obsidian/icons/");
        const exposed =
          session.vault.getAbstractFileByPath("Basalt/Config/icons") !== null;
        return { enabled, commands, icons, exposed };
      } catch (error) {
        await session.dispose();
        throw error;
      }
    },
    { contents, mobile: test.info().project.name === "android-layout" },
  );
  expect(result.enabled).toBe(true);
  expect(result.commands).toContain(`${id}:iconize:set-icon-for-file`);
  expect(result.icons).toBe(true);
  expect(result.exposed).toBe(false);
  if (info.project.name === "android-layout")
    await page
      .getByRole("button", { name: "Seitenleiste öffnen", exact: true })
      .click();
  await page
    .locator('.tree-item-self[data-path="Note.md"]')
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Change icon", exact: true })
    .click();
  const dialog = page.locator(".basalt-plugin-modal");
  await expect(dialog).toBeVisible();
  expect(errors).toEqual([]);
  await dialog.locator("input.prompt-input").fill("Test (Bt)");
  const choice = dialog
    .locator(".suggestion-item")
    .filter({ hasText: "Test (Bt)" });
  await expect(choice).toHaveCount(1);
  await expect(choice.locator("svg")).toBeVisible();
  await page.screenshot({ path: info.outputPath("icon-picker.png") });
  await choice.click();
  await expect(dialog).toHaveCount(0);
  const noteIcon = page.locator(
    '.tree-item-self[data-path="Note.md"] .iconize-icon svg',
  );
  await expect(noteIcon).toBeVisible();
  // The explorer rebuilds its rows on vault changes; plugin decorations must survive that.
  await page.evaluate(() => (window as any).iconizeTest.app.explorer.render());
  await expect(noteIcon).toBeVisible();
  // Rows inside collapsed folders exist for plugins before the folder opens.
  expect(
    await page.evaluate(() =>
      Object.keys((window as any).iconizeTest.app.explorer.fileItems),
    ),
  ).toEqual(expect.arrayContaining(["Folder", "Folder/Inner.md", "Note.md"]));
  const folderRow = page.locator('.tree-item-self[data-folder="Folder"]');
  await folderRow.click();
  const innerRow = page.locator('.tree-item-self[data-path="Folder/Inner.md"]');
  await innerRow.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Change icon", exact: true })
    .click();
  await dialog.locator("input.prompt-input").fill("Test (Bt)");
  await dialog
    .locator(".suggestion-item")
    .filter({ hasText: "Test (Bt)" })
    .click();
  const innerIcon = innerRow.locator(".iconize-icon svg");
  await expect(innerIcon).toBeVisible();
  await folderRow.click();
  await page.evaluate(() => (window as any).iconizeTest.app.explorer.render());
  await folderRow.click();
  await expect(innerIcon).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { session } = (window as any).iconizeTest;
        const data = await session.vault.adapter.read(
          ".obsidian/plugins/obsidian-icon-folder/data.json",
        );
        return JSON.parse(data)["Note.md"];
      }),
    )
    .toBe("BtTest");
  const after = await page.evaluate(async () => {
    const { session } = (window as any).iconizeTest;
    await session.bundleHost.disable("obsidian-icon-folder");
    const result = {
      enabled: session.bundleHost.isEnabled("obsidian-icon-folder"),
      commands: session.services.getCommandsFor("obsidian-icon-folder").length,
    };
    await session.dispose();
    return result;
  });
  expect(after.enabled).toBe(false);
  expect(after.commands).toBe(0);
  expect(errors).toEqual([]);
});
