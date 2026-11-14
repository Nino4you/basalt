import { expect, test, type Page } from "@playwright/test";

const editorOf = (page: Page) =>
  page.getByRole("textbox", { name: "Markdown-Editor" });

const stored = (page: Page, path: string) =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem("basalt-demo-v1")!)[key] as string,
    path,
  );

test("edits with Vim keys and saves with :w", async ({ page }) => {
  await page.addInitScript(() => {
    const settings = JSON.parse(
      localStorage.getItem("basalt-settings") ?? "{}",
    );
    localStorage.setItem(
      "basalt-settings",
      JSON.stringify({ ...settings, vimMode: true }),
    );
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Notiz", exact: true }).click();
  await page.locator("#new-name").fill("Vim");
  await page
    .getByRole("button", { name: "Notiz anlegen", exact: true })
    .click();
  await expect(page.locator("#tab-name")).toHaveText("Vim");
  await editorOf(page).focus();
  // The Vim chunk loads lazily; its status line shows once it is active.
  await expect(page.locator(".cm-vim-panel")).toBeVisible();

  await page.keyboard.press("G");
  await page.keyboard.press("o");
  await page.keyboard.type("erste Zeile");
  await page.keyboard.press("Escape");
  await page.keyboard.type("yyp");
  await expect(editorOf(page)).toContainText("erste Zeile\nerste Zeile", {
    useInnerText: true,
  });
  await page.keyboard.type(":w");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => stored(page, "Vim.md"))
    .toMatch(/erste Zeile\nerste Zeile\n?$/);
});
