import { expect, test } from "@playwright/test";

test("records a custom hotkey and runs the command with it", async ({
  page,
}) => {
  test.skip(
    test.info().project.name === "android-layout",
    "Phones have no hardware keyboard shortcuts in this layout.",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Einstellungen", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "Einstellungen" });
  await settings.getByRole("tab", { name: "Tastenkürzel" }).click();
  await settings
    .getByRole("button", {
      name: "Tastenkürzel für „Graphansicht öffnen“ festlegen",
    })
    .click();
  await expect(settings.getByText("Tastenkombination drücken …")).toBeVisible();
  // A plain letter would type text, so it is refused.
  await page.keyboard.press("g");
  await expect(
    page.getByText("Bitte mit Strg, Alt oder einer F-Taste kombinieren."),
  ).toBeVisible();
  await page.keyboard.press("Control+Alt+g");
  const row = settings.locator(".setting-item", {
    hasText: "Graphansicht öffnen",
  });
  await expect(row.locator("kbd")).toHaveText("Strg + Alt + G");

  // Giving the same combination to another command takes it away, and says so.
  await settings
    .getByRole("button", {
      name: "Tastenkürzel für „Schnellauswahl öffnen“ festlegen",
    })
    .click();
  await page.keyboard.press("Control+Alt+g");
  await expect(
    page.getByText(
      "Das Tastenkürzel wurde von „Graphansicht öffnen“ entfernt.",
    ),
  ).toBeVisible();
  await settings
    .getByRole("button", {
      name: "„Schnellauswahl öffnen“ auf das Standardkürzel zurücksetzen",
    })
    .click();
  await settings
    .getByRole("button", {
      name: "Tastenkürzel für „Graphansicht öffnen“ festlegen",
    })
    .click();
  await page.keyboard.press("Control+Alt+g");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  await page.keyboard.press("Control+Alt+g");
  await expect(
    page.getByRole("dialog", { name: "Graphansicht" }),
  ).toBeVisible();
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("basalt-hotkeys")!),
  );
  expect(stored).toEqual({ "open-graph": "Mod+Alt+G" });
  expect(errors).toEqual([]);
});
