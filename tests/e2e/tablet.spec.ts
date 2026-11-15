import { expect, test, type Page } from "@playwright/test";

// Tablets need touch input; the android-layout project emulates it.
test.beforeEach(() => {
  test.skip(
    test.info().project.name !== "android-layout",
    "needs a touch device",
  );
});

const workspace = (page: Page) => page.locator("#workspace");
const rail = (page: Page, name: string) =>
  page.locator(".workspace-ribbon").getByRole("button", { name, exact: true });

async function open(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await expect(page.locator("body")).toHaveClass(/is-tablet/);
}

test("the rail opens the left views and shows which one is open", async ({
  page,
}) => {
  await open(page, 1280, 800);
  const files = rail(page, "Dateien");
  await expect(files).toBeVisible();
  await expect(rail(page, "Suche")).toBeVisible();
  await expect(rail(page, "Lesezeichen")).toBeVisible();
  // Landscape keeps room for the note: the files sit beside it.
  await expect(workspace(page)).not.toHaveClass(/is-left-sheet/);
  await expect(files).toHaveAttribute("aria-pressed", "true");
  await rail(page, "Suche").tap();
  await expect(rail(page, "Suche")).toHaveAttribute("aria-pressed", "true");
  await expect(files).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("searchbox", { name: "Im Vault suchen" }),
  ).toBeVisible();
  // Tapping the open view again closes the sidebar.
  await rail(page, "Suche").tap();
  await expect(workspace(page)).not.toHaveClass(/is-left-open/);
  await expect(rail(page, "Suche")).toHaveAttribute("aria-pressed", "false");
});

test("landscape docks both sidebars beside the note", async ({ page }) => {
  await open(page, 1280, 800);
  await page
    .getByRole("button", { name: "Rechte Seitenleiste umschalten" })
    .tap();
  await expect(workspace(page)).toHaveClass(/is-left-open/);
  await expect(workspace(page)).toHaveClass(/is-right-open/);
  await expect(workspace(page)).not.toHaveClass(/is-right-sheet/);
  await expect(page.locator(".workspace-drawer-backdrop")).not.toHaveClass(
    /is-visible/,
  );
  const note = await page.locator(".workspace-main-column").boundingBox();
  expect(note!.width).toBeGreaterThanOrEqual(520);
});

test("portrait slides sidebars over the note, one at a time", async ({
  page,
}) => {
  await open(page, 834, 1194);
  await expect(workspace(page)).toHaveClass(/is-left-sheet/);
  // A sheet starts closed and leaves the note its full width.
  await expect(workspace(page)).not.toHaveClass(/is-left-open/);
  const before = await page.locator(".workspace-main-column").boundingBox();

  await rail(page, "Dateien").tap();
  await expect(workspace(page)).toHaveClass(/is-left-open/);
  await expect(page.locator("#left-split")).toBeVisible();
  const after = await page.locator(".workspace-main-column").boundingBox();
  expect(after!.width).toBe(before!.width);
  await expect(page.locator(".workspace-drawer-backdrop")).toHaveClass(
    /is-visible/,
  );

  // Another rail view replaces the sheet's content; the rail stays tappable.
  await rail(page, "Suche").tap();
  await expect(rail(page, "Suche")).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("searchbox", { name: "Im Vault suchen" }),
  ).toBeVisible();

  // The backdrop closes it; then the right sheet opens on its own.
  await page
    .locator(".workspace-drawer-backdrop")
    .tap({ position: { x: 600, y: 600 } });
  await expect(workspace(page)).not.toHaveClass(/is-left-open/);
  await page
    .getByRole("button", { name: "Rechte Seitenleiste umschalten" })
    .tap();
  await expect(workspace(page)).toHaveClass(/is-right-open/);
  await expect(workspace(page)).not.toHaveClass(/is-left-open/);

  // Tapping the note beside the sheet closes it.
  await page
    .locator(".workspace-drawer-backdrop")
    .tap({ position: { x: 100, y: 600 } });
  await expect(workspace(page)).not.toHaveClass(/is-right-open/);

  // Picking a file closes the sheet and opens the note.
  await rail(page, "Dateien").tap();
  await page.getByRole("treeitem", { name: "Ideensammlung" }).tap();
  await expect(page.locator("#tab-name")).toHaveText("Ideensammlung");
  await expect(workspace(page)).not.toHaveClass(/is-left-open/);
});

test("turning the tablet docks or slides the sidebar", async ({ page }) => {
  await open(page, 1280, 800);
  await expect(workspace(page)).toHaveClass(/is-left-open/);
  await expect(workspace(page)).not.toHaveClass(/is-left-sheet/);
  await page.setViewportSize({ width: 800, height: 1280 });
  await expect(workspace(page)).toHaveClass(/is-left-sheet/);
  await expect(workspace(page)).not.toHaveClass(/is-left-open/);
  await page.setViewportSize({ width: 1280, height: 800 });
  // The docked sidebar comes back as it was.
  await expect(workspace(page)).not.toHaveClass(/is-left-sheet/);
  await expect(workspace(page)).toHaveClass(/is-left-open/);
});

test("an edge swipe opens the files sheet", async ({ page }) => {
  await open(page, 834, 1194);
  await page.evaluate(() => {
    const touch = (type: string, x: number) => {
      const point = new Touch({
        identifier: 1,
        target: document.body,
        clientX: x,
        clientY: 600,
      });
      document.dispatchEvent(
        new TouchEvent(type, {
          touches: type === "touchend" ? [] : [point],
          changedTouches: [point],
          bubbles: true,
        }),
      );
    };
    touch("touchstart", 10);
    touch("touchend", 220);
  });
  await expect(workspace(page)).toHaveClass(/is-left-open/);
});

test("focus mode leaves only the note", async ({ page }) => {
  await open(page, 1280, 800);
  await page.getByRole("button", { name: "Fokusmodus", exact: true }).tap();
  await expect(page.locator("body")).toHaveClass(/is-focus-mode/);
  await expect(page.locator(".workspace-ribbon")).toBeHidden();
  await expect(page.locator("#left-split")).toBeHidden();
  await expect(
    page.locator(".workspace-tab-header-container.mod-root").first(),
  ).toBeHidden();
  await expect(
    page.getByRole("textbox", { name: "Markdown-Editor" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Fokusmodus beenden" }).tap();
  await expect(page.locator("body")).not.toHaveClass(/is-focus-mode/);
  await expect(page.locator(".workspace-ribbon")).toBeVisible();
  // The layout is as it was: the files are still docked.
  await expect(page.locator("#workspace")).toHaveClass(/is-left-open/);
});
