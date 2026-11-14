import { expect, test } from "@playwright/test";

test("replaces a term across the vault after asking", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await page.keyboard.press("ControlOrMeta+Shift+F");
  const search = page.getByRole("searchbox", { name: "Im Vault suchen" });
  await expect(search).toBeFocused();
  await search.fill("Ideensammlung");
  await expect(page.locator(".search-results-info")).toContainText("Dateien");

  await page.getByRole("button", { name: "Ersetzen", exact: true }).click();
  const replace = page.getByRole("textbox", { name: "Ersetzen durch" });
  await expect(replace).toBeFocused();
  await replace.fill("Ideenliste");
  await page.getByRole("button", { name: "Alle ersetzen" }).click();
  const dialog = page.getByRole("dialog", { name: "Alle ersetzen" });
  await expect(dialog).toContainText("„Ideensammlung“");
  await dialog.getByRole("button", { name: "Ersetzen", exact: true }).click();
  await expect(page.locator(".notice").last()).toContainText("ersetzt");

  const files = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("basalt-demo-v1")!) as Record<
        string,
        string
      >,
  );
  expect(files["Willkommen.md"]).toContain("[[Ideenliste|Ideenliste]]");
  expect(files["Willkommen.md"]).not.toContain("Ideensammlung");
  // Every changed note was backed up first.
  expect(
    Object.keys(files).some((key) =>
      key.startsWith(".basalt/history/Willkommen.md/"),
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
