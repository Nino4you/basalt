import { expect, test } from "@playwright/test";
import type { Menu } from "../../src/compat/obsidian-api";
import type { TAbstractFile } from "../../src/compat/files";

test("file and folder menus expose plugin actions without replacing host actions", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tests/fixtures/vault.html");
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [{ App }, { CompatibilitySession }, { MemoryPort }] =
      await Promise.all([
        load("/src/app/app.ts"),
        load("/src/compat/session.ts"),
        load("/tests/helpers/vault-store.ts"),
      ]);
    const app = new App(document.querySelector("#app"));
    await app.start();
    const port = new MemoryPort({ "Folder/Note.md": "# Note" });
    const session = await CompatibilitySession.create({
      vaultId: port.vaultId,
      name: "Menu test",
      mobile: false,
      port,
      editor: app.editor.compat,
      extensions: app.editor.extensions,
      container: app.shell.viewContent,
      navigate: () => {},
    });
    app.compatibility = session;
    app.syncVisibleFiles();
    app.explorer.reveal("Folder/Note.md");
    session.workspace.on(
      "file-menu",
      (menu: Menu, file: TAbstractFile, source: string) => {
        menu.onHide(() => {
          document.body.dataset.menuHidden = file.path;
        });
        menu.addItem((item) =>
          item.setTitle(`Plugin: ${file.path} (${source})`).onClick(() => {
            document.body.dataset.menuSelected = file.path;
          }),
        );
      },
    );
  });
  const row = page.locator('.tree-item-self[data-path="Folder/Note.md"]');
  await row.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Umbenennen", exact: true }),
  ).toBeVisible();
  const plugin = page.getByRole("menuitem", {
    name: "Plugin: Folder/Note.md (file-explorer)",
    exact: true,
  });
  await expect(plugin).toBeVisible();
  await plugin.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute(
    "data-menu-selected",
    "Folder/Note.md",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-menu-hidden",
    "Folder/Note.md",
  );
  await page
    .locator('.tree-item-self[data-folder="Folder"]')
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", {
      name: "Plugin: Folder (file-explorer)",
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute(
    "data-menu-hidden",
    "Folder",
  );
  expect(errors).toEqual([]);
});
