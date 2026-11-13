// Regenerates the screenshots of the project page (site/assets/shot-*.png).
//
// The images show the real browser demo, seeded with the English showcase vault
// in site/showcase-vault.js. Start the demo first (`npm run dev`), then run:
//
//   node tools/site_screenshots.mjs [demo-url]
//
// Set BASALT_CHROMIUM to a Chromium binary if Playwright's own is not installed.
import { chromium, devices } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { accent, vault } from "../site/showcase-vault.js";

const url = process.argv[2] ?? "http://127.0.0.1:1420/";
const out = fileURLToPath(new URL("../site/assets/", import.meta.url));
mkdirSync(out, { recursive: true });

const settings = { language: "en", theme: "dark", accent };

const browser = await chromium.launch({
  executablePath: process.env.BASALT_CHROMIUM || undefined,
});

async function open(options) {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    ...options,
  });
  await context.addInitScript(
    ([files, prefs]) => {
      if (localStorage.getItem("basalt-demo-v1")) return;
      localStorage.setItem("basalt-demo-v1", files);
      localStorage.setItem("basalt-settings", prefs);
    },
    [JSON.stringify(vault), JSON.stringify(settings)],
  );
  const page = await context.newPage();
  await page.goto(url);
  // The phone layout keeps most buttons in drawers; the quick switcher is always there.
  await page
    .getByRole("button", { name: "Open quick switcher" })
    .last()
    .waitFor();
  return page;
}

async function shot(page, name) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}shot-${name}.png` });
  console.log(`shot-${name}.png`);
}

async function openNote(page, name) {
  await page
    .getByRole("button", { name: "Open quick switcher" })
    .first()
    .click();
  await page.keyboard.type(name);
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
}

const desktop = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
};
// The feature images are shown at about half the hero's width, so they use a
// smaller window to keep the interface readable.
const compact = {
  viewport: { width: 1120, height: 730 },
  deviceScaleFactor: 2,
};

// 1. Editor with live preview and backlinks.
{
  const page = await open(desktop);
  await openNote(page, "Welcome");
  await page.getByRole("button", { name: "Toggle right sidebar" }).click();
  await page.mouse.click(900, 860);
  await page.mouse.move(1000, 500);
  await shot(page, "editor");
  await page.context().close();
}

// 2. Two notes side by side, local graph in the sidebar.
{
  const page = await open(compact);
  await openNote(page, "Columnar jointing");
  await page
    .getByRole("button", { name: "Toggle left sidebar" })
    .first()
    .click();
  await page.getByRole("button", { name: "Toggle right sidebar" }).click();
  await page
    .getByRole("button", { name: "Open command palette" })
    .first()
    .click();
  await page.keyboard.type("Split editor right");
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await openNote(page, "Svartifoss");
  await page.getByRole("tab", { name: "Local graph" }).click();
  await page.mouse.move(560, 715);
  await shot(page, "split");
  await page.context().close();
}

// 3. Graph of the whole vault.
{
  const page = await open(compact);
  await page
    .getByRole("button", { name: "Toggle left sidebar" })
    .first()
    .click();
  await page.getByRole("button", { name: "Open graph view" }).click();
  const dialog = page.getByRole("dialog", { name: "Graph view" });
  await dialog.locator("summary", { hasText: "Appearance" }).click();
  await dialog.getByRole("checkbox", { name: "Color groups" }).check();
  await dialog.locator("summary", { hasText: "Appearance" }).click();
  await page.waitForTimeout(1500);
  await dialog.getByRole("button", { name: "Zoom in" }).click();
  await page.mouse.move(300, 725);
  await shot(page, "graph");
  await page.context().close();
}

// 4. Canvas.
{
  const page = await open(compact);
  await openNote(page, "Trip board");
  await page
    .getByRole("button", { name: "Toggle left sidebar" })
    .first()
    .click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Show all" }).click();
  await page.mouse.move(560, 725);
  await shot(page, "canvas");
  await page.context().close();
}

// 5. Phone layout, reading view.
{
  const page = await open({ ...devices["Pixel 7"] });
  await page
    .getByRole("button", { name: "Open quick switcher" })
    .last()
    .click();
  await page.keyboard.type("Welcome");
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Reading view" }).click();
  await page.waitForTimeout(800);
  await shot(page, "phone");
  await page.context().close();
}

await browser.close();
