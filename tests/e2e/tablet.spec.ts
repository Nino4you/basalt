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
const editor = (page: Page) =>
  page.getByRole("textbox", { name: "Markdown-Editor" });

async function open(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await expect(page.locator("body")).toHaveClass(/is-tablet/);
}

/**
 * A one-finger horizontal drag from x0 to x1, one move per frame. `rest`
 * holds the finger still before lifting it, which drops its speed.
 */
async function drag(page: Page, x0: number, x1: number, rest = false) {
  await page.evaluate(
    async ({ x0, x1, rest }) => {
      const y = 500;
      const steps = 8;
      const frame = () => new Promise((done) => setTimeout(done, 16));
      const target = document.elementFromPoint(x0, y) ?? document.body;
      const fire = (type: string, x: number) => {
        const point = new Touch({
          identifier: 1,
          target,
          clientX: x,
          clientY: y,
        });
        target.dispatchEvent(
          new TouchEvent(type, {
            touches: type === "touchend" ? [] : [point],
            changedTouches: [point],
            bubbles: true,
          }),
        );
      };
      fire("touchstart", x0);
      for (let i = 1; i <= steps; i++) {
        await frame();
        fire("touchmove", x0 + ((x1 - x0) * i) / steps);
      }
      if (rest) await new Promise((done) => setTimeout(done, 200));
      fire("touchend", x1);
    },
    { x0, x1, rest },
  );
}

test("the rail opens labelled views as a floating card", async ({ page }) => {
  await open(page, 1280, 800);
  for (const name of [
    "Dateien",
    "Suche",
    "Lesezeichen",
    "Öffnen",
    "Heute",
    "Befehle",
  ])
    await expect(page.locator(".workspace-ribbon")).toContainText(name);
  const files = rail(page, "Dateien");
  // Even in landscape the sidebar floats until it is pinned.
  await expect(workspace(page)).toHaveClass(/is-left-sheet/);
  await expect(workspace(page)).not.toHaveClass(/is-left-open/);
  await files.tap();
  await expect(workspace(page)).toHaveClass(/is-left-open/);
  await expect(files).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".sheet-title")).toHaveText("Dateien");
  // No dimming: the note behind stays as it is.
  await expect(page.locator(".workspace-drawer-backdrop")).not.toHaveClass(
    /is-visible/,
  );
  await rail(page, "Suche").tap();
  await expect(page.locator(".sheet-title")).toHaveText("Suche");
  await expect(
    page.getByRole("searchbox", { name: "Im Vault suchen" }),
  ).toBeVisible();
  // A second tap on the open view closes the card.
  await rail(page, "Suche").tap();
  await expect(workspace(page)).not.toHaveClass(/is-left-open/);
});

test("a tap on the note closes the card and still reaches the note", async ({
  page,
}) => {
  await open(page, 1280, 800);
  await rail(page, "Dateien").tap();
  await expect(workspace(page)).toHaveClass(/is-left-open/);
  // A line of text right of the card.
  await page
    .getByText("Manche Ideen brauchen keinen")
    .tap({ position: { x: 400, y: 8 } });
  await expect(workspace(page)).not.toHaveClass(/is-left-open/);
  await expect(editor(page)).toBeFocused();
});

test("pinning docks the sidebar beside the note and survives a restart", async ({
  page,
}) => {
  await open(page, 1280, 800);
  const before = await page.locator(".workspace-main-column").boundingBox();
  await rail(page, "Dateien").tap();
  await page.getByRole("button", { name: "Anpinnen" }).first().tap();
  await expect(workspace(page)).not.toHaveClass(/is-left-sheet/);
  await expect(workspace(page)).toHaveClass(/is-left-open/);
  const pinned = await page.locator(".workspace-main-column").boundingBox();
  expect(pinned!.width).toBeLessThan(before!.width);
  expect(pinned!.width).toBeGreaterThanOrEqual(520);
  // Opening a file keeps a pinned sidebar.
  await page.getByRole("treeitem", { name: "Ideensammlung" }).tap();
  await expect(page.locator("#tab-name")).toHaveText("Ideensammlung");
  await expect(workspace(page)).toHaveClass(/is-left-open/);

  await page.reload();
  await expect(workspace(page)).not.toHaveClass(/is-left-sheet/);
  await expect(workspace(page)).toHaveClass(/is-left-open/);

  // In portrait there is no room: even a pinned sidebar floats.
  await page.setViewportSize({ width: 800, height: 1280 });
  await expect(workspace(page)).toHaveClass(/is-left-sheet/);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(workspace(page)).not.toHaveClass(/is-left-sheet/);

  await page.getByRole("button", { name: "Lösen" }).first().tap();
  await expect(workspace(page)).toHaveClass(/is-left-sheet/);
});

test("cards follow the finger and open or close on release", async ({
  page,
}) => {
  await open(page, 834, 1194);
  const card = page.locator("#left-split");
  // Pulled out a little and let go after a pause, it slides back.
  await drag(page, 30, 120, true);
  await expect(workspace(page)).not.toHaveClass(/is-left-open/);
  // Pulled past half way, it opens even after a pause.
  await drag(page, 30, 380, true);
  await expect(workspace(page)).toHaveClass(/is-left-open/);
  await expect(card).not.toHaveClass(/is-dragging/);
  await expect(card).toHaveAttribute("style", /^(?!.*translate)/);
  // A quick flick back closes it, though it moved only a little.
  await drag(page, 300, 220);
  await expect(workspace(page)).not.toHaveClass(/is-left-open/);
  // The right card comes in from the screen edge.
  await drag(page, 830, 500);
  await expect(workspace(page)).toHaveClass(/is-right-open/);
});

test("picking a file closes a floating card", async ({ page }) => {
  await open(page, 834, 1194);
  await rail(page, "Dateien").tap();
  await page.getByRole("treeitem", { name: "Ideensammlung" }).tap();
  await expect(page.locator("#tab-name")).toHaveText("Ideensammlung");
  await expect(workspace(page)).not.toHaveClass(/is-left-open/);
});

test("focus mode leaves only the note", async ({ page }) => {
  await open(page, 1280, 800);
  await page.getByRole("button", { name: "Fokusmodus", exact: true }).tap();
  await expect(page.locator("body")).toHaveClass(/is-focus-mode/);
  await expect(page.locator(".workspace-ribbon")).toBeHidden();
  await expect(
    page.locator(".workspace-tab-header-container.mod-root").first(),
  ).toBeHidden();
  await expect(editor(page)).toBeVisible();
  await page.getByRole("button", { name: "Fokusmodus beenden" }).tap();
  await expect(page.locator("body")).not.toHaveClass(/is-focus-mode/);
  await expect(page.locator(".workspace-ribbon")).toBeVisible();
});

test("the rail and status bar stay above Android's navigation bar", async ({
  page,
}) => {
  await open(page, 834, 1194);
  // What src/ui/android-insets.ts sets for a 48 px gesture/navigation bar.
  await page.evaluate(() =>
    document.documentElement.style.setProperty(
      "--android-inset-bottom",
      "48px",
    ),
  );
  const limit = 1194 - 48;
  for (const name of ["Einstellungen", "Farbschema wechseln"]) {
    const box = await rail(page, name).boundingBox();
    expect(box!.y + box!.height, name).toBeLessThanOrEqual(limit);
  }
  const status = await page.locator(".status-bar").boundingBox();
  expect(status!.y + status!.height).toBeLessThanOrEqual(limit);
  await rail(page, "Einstellungen").tap();
  await expect(page.getByRole("dialog")).toBeVisible();
});
