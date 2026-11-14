import { expect, test, type Page } from "@playwright/test";

const demo = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("basalt-demo-v1")!) as Record<
        string,
        string
      >,
  );

async function open(page: Page, name: string) {
  await page.keyboard.press("ControlOrMeta+o");
  await page.getByRole("textbox", { name: "Schnellauswahl" }).fill(name);
  await page.keyboard.press("Enter");
  await expect(page.locator("#tab-name")).toHaveText(name);
}

async function palette(page: Page, command: string) {
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("textbox", { name: "Befehlspalette" }).fill(command);
  await page.keyboard.press("Enter");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("basalt-demo-v1")) return;
    localStorage.setItem(
      "basalt-settings",
      JSON.stringify({ language: "de" }),
    );
    localStorage.setItem(
      "basalt-demo-v1",
      JSON.stringify({
        "Start.md": "Siehe [[Entwurf]] und [[Ziel]].\n",
        "Entwurf.md": "---\ntags: [idee]\n---\n## Entwurf\nZweiter Teil\n",
        "Ziel.md": "---\ntags: [projekt]\n---\n# Ziel\nErster Teil\n",
      }),
    );
    localStorage.setItem(
      'basalt-workspace:"basalt-demo-v1"',
      JSON.stringify({ tabs: [{ path: "Start.md" }], active: 0 }),
    );
  });
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Start");
});

test("merges a note into another and points links at the target", async ({
  page,
}) => {
  await open(page, "Entwurf");
  await palette(page, "Aktuelle Notiz mit einer anderen zusammenführen");
  await page.getByRole("textbox", { name: "Zusammenführen mit" }).fill("Ziel");
  await page.keyboard.press("Enter");
  await page
    .getByRole("dialog", { name: "Notizen zusammenführen" })
    .getByRole("button", { name: "Zusammenführen" })
    .click();
  await expect(page.locator("#tab-name")).toHaveText("Ziel");
  await expect
    .poll(() => demo(page))
    .toMatchObject({
      "Start.md": "Siehe [[Ziel]] und [[Ziel]].\n",
      "Ziel.md":
        "---\ntags:\n  - projekt\n  - idee\n---\n# Ziel\nErster Teil\n\n## Entwurf\nZweiter Teil\n",
    });
  expect(await demo(page)).not.toHaveProperty("Entwurf.md");
});

test("extracts the selection into a new linked note", async ({ page }) => {
  await open(page, "Ziel");
  const editor = page.getByRole("textbox", { name: "Markdown-Editor" });
  await editor.getByText("Erster Teil").selectText();
  await palette(page, "Auswahl in neue Notiz extrahieren");
  const dialog = page.getByRole("dialog", {
    name: "Auswahl in neue Notiz extrahieren",
  });
  await expect(dialog.getByRole("textbox", { name: "Name der Notiz" })).toHaveValue(
    "Erster Teil",
  );
  await dialog.getByRole("button", { name: "Extrahieren" }).click();
  await expect
    .poll(() => demo(page))
    .toMatchObject({
      "Erster Teil.md": "Erster Teil\n",
      "Ziel.md": "---\ntags: [projekt]\n---\n# Ziel\n[[Erster Teil]]\n",
    });
});
