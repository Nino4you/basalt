import { expect, test, type Page } from "@playwright/test";

const editorOf = (page: Page) =>
  page.getByRole("textbox", { name: "Markdown-Editor" });

const stored = (page: Page, path: string) =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem("basalt-demo-v1")!)[key] as string,
    path,
  );

test("edits frontmatter as properties", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Notiz", exact: true }).click();
  await page.locator("#new-name").fill("Eigenschaften");
  await page
    .getByRole("button", { name: "Notiz anlegen", exact: true })
    .click();
  await expect(page.locator("#tab-name")).toHaveText("Eigenschaften");
  await editorOf(page).click();

  await page.keyboard.press("ControlOrMeta+;");
  const name = page.getByRole("textbox", { name: "Name der Eigenschaft" });
  await expect(name).toBeFocused();
  await name.fill("status");
  await name.press("Enter");
  const value = page.getByRole("textbox", { name: "Wert von „status“" });
  await value.fill("offen");
  await value.press("Enter");
  await expect
    .poll(() => stored(page, "Eigenschaften.md"))
    .toMatch(/^---\nstatus: offen\n---\n/);

  await page.getByRole("button", { name: "Eigenschaft hinzufügen" }).click();
  await page
    .getByRole("textbox", { name: "Name der Eigenschaft" })
    .last()
    .fill("tags");
  await page.keyboard.press("Enter");
  const tags = page.getByRole("textbox", { name: "Wert von „tags“" });
  await tags.fill("projekt");
  await tags.press("Enter");
  await expect(page.locator(".multi-select-pill")).toHaveText("projekt");
  await expect
    .poll(() => stored(page, "Eigenschaften.md"))
    .toMatch(/^---\nstatus: offen\ntags:\n  - projekt\n---\n/);

  // The reading view shows the same properties.
  await page.getByRole("button", { name: "Leseansicht", exact: true }).click();
  await expect(
    page.locator(".markdown-preview-view .metadata-container").first(),
  ).toContainText("offen");
  expect(errors).toEqual([]);
});
