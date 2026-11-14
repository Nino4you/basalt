import { expect, test, type Page } from "@playwright/test";

const editorOf = (page: Page) =>
  page.getByRole("textbox", { name: "Markdown-Editor" });

async function command(page: Page, name: string) {
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("textbox", { name: "Befehlspalette" }).fill(name);
  await page.keyboard.press("Enter");
}

test("folds sections under headings and unfolds them again", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  // Clicking the middle of the note could follow a link.
  await editorOf(page).focus();
  await expect(editorOf(page)).toContainText("Ein kleiner Anfang");

  await command(page, "Alle Überschriften und Listen einklappen");
  await expect(page.locator(".cm-foldPlaceholder").first()).toBeVisible();
  await expect(editorOf(page)).not.toContainText("Ein kleiner Anfang");

  await command(page, "Alle Überschriften und Listen ausklappen");
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(0);
  await expect(editorOf(page)).toContainText("Ein kleiner Anfang");

  // The gutter arrow folds one section; the placeholder opens it again.
  await editorOf(page).hover();
  await page
    .locator(".cm-fold-marker")
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(1);
  await page.locator(".cm-foldPlaceholder").click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(0);
});
