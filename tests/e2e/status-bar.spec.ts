import { expect, test } from "@playwright/test";

test("counts the selection instead of the whole note", async ({ page }) => {
  test.skip(
    test.info().project.name === "android-layout",
    "The phone layout has no status bar.",
  );
  await page.addInitScript(() => {
    if (localStorage.getItem("basalt-demo-v1")) return;
    localStorage.setItem(
      "basalt-demo-v1",
      JSON.stringify({ "Zählen.md": "eins zwei drei vier fünf" }),
    );
    localStorage.setItem(
      'basalt-workspace:"basalt-demo-v1"',
      JSON.stringify({ tabs: [{ path: "Zählen.md" }], active: 0 }),
    );
  });
  await page.goto("/");
  const words = page.locator("#word-count");
  await expect(words).toHaveText("5 Wörter");
  await page.getByText("eins zwei drei vier fünf").click();
  await page.keyboard.press("Home");
  for (let i = 0; i < "eins zwei".length; i++)
    await page.keyboard.press("Shift+ArrowRight");
  await expect(words).toHaveText("2 Wörter ausgewählt");
  await expect(page.locator("#char-count")).toHaveText("9 Zeichen");
  await page.keyboard.press("End");
  await expect(words).toHaveText("5 Wörter");
});
