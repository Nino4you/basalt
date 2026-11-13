import { expect, test, type Page } from "@playwright/test";

// Test the real app default independently of the German regression suites.
test.use({ storageState: { cookies: [], origins: [] } });

async function openSettings(page: Page, language: "de" | "en") {
  const mobile = test.info().project.name === "android-layout";
  if (mobile) {
    // Editing replaces the phone navbar with the formatting toolbar.
    const hideKeyboard = page.getByRole("button", {
      name: language === "en" ? "Hide keyboard" : "Tastatur ausblenden",
      exact: true,
    });
    if (await hideKeyboard.isVisible()) await hideKeyboard.click();
    await page
      .getByRole("button", {
        name: language === "en" ? "Menu" : "Menü",
        exact: true,
      })
      .click();
    await page
      .getByRole("menuitem", {
        name: language === "en" ? "Settings" : "Einstellungen",
        exact: true,
      })
      .click();
  } else {
    await page
      .getByRole("button", {
        name: language === "en" ? "Settings" : "Einstellungen",
        exact: true,
      })
      .click();
  }
  await page
    .getByRole("tab", {
      name: language === "en" ? "General" : "Allgemein",
      exact: true,
    })
    .click();
}

test("starts in English and switches languages without translating note contents", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  // The German demo vault is user content, not part of the interface catalog.
  await expect(editor).toContainText("Platz für deine Gedanken");
  await editor.fill("# Meine Notiz\n\nDieser Inhalt bleibt unverändert.");
  await openSettings(page, "en");
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("de");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(
    page.getByRole("textbox", { name: "Markdown-Editor", exact: true }),
  ).toContainText("Dieser Inhalt bleibt unverändert.");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await openSettings(page, "de");
  await page
    .getByRole("combobox", { name: "Sprache", exact: true })
    .selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(editor).toContainText("Dieser Inhalt bleibt unverändert.");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(editor).toContainText("Dieser Inhalt bleibt unverändert.");
  if (test.info().project.name === "android-layout") {
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Open command palette", exact: true })
      .click();
  } else {
    await page
      .getByRole("button", { name: "Open command palette", exact: true })
      .click();
  }
  await expect(
    page.getByRole("textbox", { name: "Command palette", exact: true }),
  ).toBeVisible();
});

test("does not reload or lose a draft when a conflict blocks a language change", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", {
    name: "Markdown editor",
    exact: true,
  });
  await expect(editor).toContainText("Platz für deine Gedanken");
  await page.evaluate(() => {
    const files = JSON.parse(localStorage.getItem("basalt-demo-v1") ?? "{}");
    files["Willkommen.md"] = "External version";
    localStorage.setItem("basalt-demo-v1", JSON.stringify(files));
  });
  await editor.fill("My unsaved draft");
  await openSettings(page, "en");
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("de");
  await expect(
    page.locator(".notice").filter({ hasText: "Could not change language" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("combobox", { name: "Language", exact: true }),
  ).toHaveValue("en");
  await page.locator('[data-close="settings"]').click();
  await expect(editor).toContainText("My unsaved draft");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("basalt-demo-v1")!)["Willkommen.md"],
    ),
  ).toBe("External version");
});
