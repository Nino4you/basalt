import { expect, test } from "@playwright/test";

// The android-layout project emulates a Pixel 7: coarse pointer, touch input.
test.beforeEach(() => {
  test.skip(
    test.info().project.name !== "android-layout",
    "needs a touch device",
  );
});

test("the formatting bar replaces the navbar while typing on a phone", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  const toolbar = page.getByRole("toolbar", { name: "Bearbeiten" });
  const navbar = page.getByRole("navigation", { name: "Navigation" });
  await expect(toolbar).toBeHidden();
  await expect(navbar).toBeVisible();

  await page.locator(".cm-content").tap({ position: { x: 20, y: 20 } });
  await expect(toolbar).toBeVisible();
  await expect(navbar).toBeHidden();

  const editor = page.locator(".cm-content");
  // Live preview draws `- [ ]` as a checkbox, so count those.
  const boxes = editor.locator("input.task-list-item-checkbox");
  const before = await boxes.count();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Aufgabe");
  await toolbar.getByRole("button", { name: "Aufgabe umschalten" }).tap();
  await expect(boxes).toHaveCount(before + 1);
  // The editor keeps focus, so the on-screen keyboard would stay open.
  await expect(editor).toBeFocused();
  await toolbar.getByRole("button", { name: "Rückgängig" }).tap();
  await expect(boxes).toHaveCount(before);
  await expect(editor).toContainText("Aufgabe");

  await toolbar.getByRole("button", { name: "Tastatur ausblenden" }).tap();
  await expect(toolbar).toBeHidden();
  await expect(navbar).toBeVisible();
});

test("a phone turned sideways keeps the phone layout", async ({ page }) => {
  await page.setViewportSize({ width: 915, height: 412 });
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await expect(page.locator("body")).toHaveClass(/is-mobile/);
  await expect(page.locator("#left-split")).not.toBeInViewport();
  await expect(
    page.getByRole("navigation", { name: "Navigation" }),
  ).toBeVisible();
});

test("a portrait tablet shows one sidebar at a time", async ({ page }) => {
  await page.setViewportSize({ width: 834, height: 1194 });
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await expect(page.locator("body")).toHaveClass(/is-tablet/);
  const left = page.locator("#left-split");
  const right = page.locator("#right-split");
  await page
    .getByRole("button", { name: "Rechte Seitenleiste umschalten" })
    .tap();
  // Desktop sidebars collapse to zero width rather than leaving the screen.
  await expect(right).not.toHaveCSS("width", "0px");
  await expect(left).toHaveCSS("width", "0px");
  await page
    .getByRole("button", { name: "Linke Seitenleiste umschalten" })
    .tap();
  await expect(left).not.toHaveCSS("width", "0px");
  await expect(right).toHaveCSS("width", "0px");
});

test("phone settings open as a category list with pages and keep wide controls below their label", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Menü", exact: true }).tap();
  await page.getByRole("menuitem", { name: "Einstellungen" }).tap();
  const dialog = page.getByRole("dialog", { name: "Einstellungen" });
  await expect(dialog).toBeVisible();
  // Like Obsidian's mobile app: the categories are a page of their own.
  const categories = dialog.getByRole("tablist", { name: "Kategorien" });
  await expect(categories).toBeVisible();
  await expect(dialog.getByRole("tabpanel")).toBeHidden();
  await dialog.getByRole("tab", { name: "Editor", exact: true }).tap();
  await expect(categories).toBeHidden();
  await expect(dialog.locator(".settings-page-title")).toHaveText("Editor");
  const back = dialog.getByRole("button", { name: "Zurück", exact: true });
  await expect(back).toBeFocused();

  const row = dialog
    .locator(".setting-item", { has: page.locator("select") })
    .first();
  const label = await row.locator(".setting-item-info").boundingBox();
  const control = await row.locator("select").boundingBox();
  expect(control!.y).toBeGreaterThanOrEqual(label!.y + label!.height - 1);
  // The page title ends before the close button instead of under it.
  const header = await dialog.locator(".settings-page-header").boundingBox();
  const close = await dialog.locator(".modal-close-button").boundingBox();
  const title = await dialog.locator(".settings-page-title").boundingBox();
  expect(title!.x + title!.width).toBeLessThanOrEqual(close!.x + 1);
  expect(close!.y + close!.height).toBeLessThanOrEqual(
    header!.y + header!.height + 1,
  );

  await back.tap();
  await expect(categories).toBeVisible();
  await expect(dialog.getByRole("tabpanel")).toBeHidden();
});
