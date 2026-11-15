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

test("the dock opens views as a floating card", async ({ page }) => {
  await open(page, 1280, 800);
  // Icons only; their names are what touch readers and tooltips use.
  for (const name of [
    "Dateien",
    "Suche",
    "Lesezeichen",
    "Neue Notiz",
    "Einstellungen",
  ])
    await expect(rail(page, name)).toBeVisible();
  await expect(page.locator(".workspace-ribbon .rail-item-label")).toHaveCount(
    0,
  );
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

test("the dock can float at the bottom instead", async ({ page }) => {
  await page.addInitScript(() => {
    const settings = JSON.parse(
      localStorage.getItem("basalt-settings") ?? "{}",
    );
    localStorage.setItem(
      "basalt-settings",
      JSON.stringify({ ...settings, tabletDock: "bottom" }),
    );
  });
  await open(page, 834, 1194);
  await expect(page.locator("body")).toHaveClass(/is-dock-bottom/);
  const dock = await page.locator(".workspace-ribbon").boundingBox();
  // A pill centred near the bottom, not a column at the left edge.
  expect(dock!.width).toBeGreaterThan(dock!.height * 4);
  expect(Math.abs(dock!.x + dock!.width / 2 - 834 / 2)).toBeLessThan(2);
  expect(dock!.y + dock!.height).toBeGreaterThan(1194 - 100);
  // The note starts at the left edge; nothing is reserved for a rail.
  const note = await page.locator(".workspace-main-column").boundingBox();
  expect(note!.x).toBeLessThan(10);

  // The card grows out of the dock, above the icon that opened it.
  await rail(page, "Suche").tap();
  await expect(workspace(page)).toHaveClass(/is-left-open/);
  await expect
    .poll(async () => {
      const card = await page.locator("#left-split").boundingBox();
      return card!.y + card!.height;
    })
    .toBeLessThan(dock!.y);
  const icon = await rail(page, "Suche").boundingBox();
  const card = await page.locator("#left-split").boundingBox();
  const centre = icon!.x + icon!.width / 2;
  expect(centre).toBeGreaterThan(card!.x);
  expect(centre).toBeLessThan(card!.x + card!.width);

  // Pulled down by its header, it goes back into the dock.
  const header = await page.locator(".sheet-header.mod-left").boundingBox();
  await page.evaluate(
    async ({ x, y }) => {
      const target = document.elementFromPoint(x, y)!;
      const fire = (type: string, at: number) => {
        const point = new Touch({
          identifier: 1,
          target,
          clientX: x,
          clientY: at,
        });
        target.dispatchEvent(
          new TouchEvent(type, {
            touches: type === "touchend" ? [] : [point],
            changedTouches: [point],
            bubbles: true,
          }),
        );
      };
      fire("touchstart", y);
      for (let i = 1; i <= 8; i++) {
        await new Promise((done) => setTimeout(done, 16));
        fire("touchmove", y + i * 60);
      }
      await new Promise((done) => setTimeout(done, 200));
      fire("touchend", y + 480);
    },
    { x: header!.x + header!.width / 2, y: header!.y + 20 },
  );
  await expect(workspace(page)).not.toHaveClass(/is-left-open/);

  // And it stays clear of Android's navigation bar.
  await page.evaluate(() =>
    document.documentElement.style.setProperty(
      "--android-inset-bottom",
      "48px",
    ),
  );
  // The dock glides up; wait for it to arrive.
  await expect
    .poll(async () => {
      const box = await page.locator(".workspace-ribbon").boundingBox();
      return box!.y + box!.height;
    })
    .toBeLessThanOrEqual(1194 - 48);
});

/** Long press on an icon, drag it to (x, y) and let go, like a finger. */
async function longPressDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [from],
  });
  await page.waitForTimeout(450);
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: from.x + ((to.x - from.x) * i) / 10,
          y: from.y + ((to.y - from.y) * i) / 10,
        },
      ],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

const dockOrder = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        ".workspace-ribbon .rail-item, .side-dock-actions > [data-command], .side-dock-settings > [data-command]",
      ),
    ].map((el) => el.getAttribute("aria-label")),
  );

const centre = async (page: Page, name: string) => {
  const box = await rail(page, name).boundingBox();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
};

test("dock icons are reordered by long press and drag", async ({ page }) => {
  await open(page, 1280, 800);
  // A view moves up among the views; the tap does not open it.
  const files = await centre(page, "Dateien");
  await longPressDrag(page, await centre(page, "Lesezeichen"), {
    x: files.x,
    y: files.y - 20,
  });
  await expect
    .poll(() => dockOrder(page))
    .toEqual([
      "Lesezeichen",
      "Dateien",
      "Suche",
      "Schnellauswahl öffnen",
      "Heutige Tagesnotiz öffnen",
      "Befehlspalette öffnen",
      "Graphansicht öffnen",
      "Farbschema wechseln",
      "Einstellungen",
    ]);
  await expect(workspace(page)).not.toHaveClass(/is-left-open/);

  // An action moves from the end of the dock up to the others.
  const graph = await centre(page, "Graphansicht öffnen");
  await longPressDrag(page, await centre(page, "Einstellungen"), {
    x: graph.x,
    y: graph.y + 10,
  });
  await expect
    .poll(() => dockOrder(page))
    .toEqual([
      "Lesezeichen",
      "Dateien",
      "Suche",
      "Schnellauswahl öffnen",
      "Heutige Tagesnotiz öffnen",
      "Befehlspalette öffnen",
      "Graphansicht öffnen",
      "Einstellungen",
      "Farbschema wechseln",
    ]);
  await expect(
    page
      .locator(".side-dock-actions")
      .getByRole("button", { name: "Einstellungen" }),
  ).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The order is kept.
  await page.reload();
  await expect.poll(() => dockOrder(page)).toContain("Lesezeichen");
  expect((await dockOrder(page))[0]).toBe("Lesezeichen");
  expect((await dockOrder(page)).at(-2)).toBe("Einstellungen");

  // A quick swipe over the dock is no reorder.
  const first = await centre(page, "Lesezeichen");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [first],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: first.x, y: first.y + 120 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  expect((await dockOrder(page))[0]).toBe("Lesezeichen");
});

test("the bottom dock is reordered sideways", async ({ page }) => {
  await page.addInitScript(() => {
    const settings = JSON.parse(
      localStorage.getItem("basalt-settings") ?? "{}",
    );
    localStorage.setItem(
      "basalt-settings",
      JSON.stringify({ ...settings, tabletDock: "bottom" }),
    );
  });
  await open(page, 1280, 800);
  const bookmarks = await centre(page, "Lesezeichen");
  await longPressDrag(page, await centre(page, "Dateien"), {
    x: bookmarks.x + 20,
    y: bookmarks.y,
  });
  await expect
    .poll(async () => (await dockOrder(page)).slice(0, 3))
    .toEqual(["Suche", "Lesezeichen", "Dateien"]);
});
