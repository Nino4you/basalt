import { expect, test, type Page } from "@playwright/test";

const stored = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("basalt-demo-v1")!) as Record<
        string,
        string
      >,
  );

async function renameActive(page: Page, name: string) {
  // A click into the editor could land on a link and open another note.
  await page.keyboard.press("ControlOrMeta+p");
  await page
    .getByRole("textbox", { name: "Befehlspalette" })
    .fill("Aktuelle Datei umbenennen");
  await page.keyboard.press("Enter");
  await page.getByLabel("Neuer Dateiname").fill(name);
  await page.getByRole("button", { name: "Umbenennen" }).click();
  await expect(page.locator("#tab-name")).toHaveText(name);
}

test("renaming a note rewrites the links that pointed to it", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await renameActive(page, "Start");
  await expect(
    page.getByText("Links in 4 Dateien aktualisiert."),
  ).toBeVisible();

  const files = await stored(page);
  expect(files["Willkommen.md"]).toBeUndefined();
  expect(files["Ideensammlung.md"]).toContain("Zurück zu [[Start]].");
  expect(files["Tagesnotiz.md"]).toContain("[[Ideensammlung]] und [[Start]]");
  expect(files["Plugins.md"]).toContain("[[Start]]");
  expect(files["Plugins.md"]).not.toContain("Willkommen");
  const canvas = JSON.parse(files["Ideenboard.canvas"]);
  expect(
    canvas.nodes.filter((node: { file?: string }) => node.file === "Start.md"),
  ).toHaveLength(1);
  // Every rewritten file kept its previous content as a backup.
  for (const path of ["Ideensammlung.md", "Tagesnotiz.md", "Plugins.md"])
    expect(
      Object.keys(files).some((key) =>
        key.startsWith(`.basalt/history/${path}/`),
      ),
      path,
    ).toBe(true);

  expect(errors).toEqual([]);
});

test("links stay as written when the setting is off", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "basalt-settings",
      JSON.stringify({ language: "de", updateLinks: false }),
    ),
  );
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await renameActive(page, "Start");
  const files = await stored(page);
  expect(files["Start.md"]).toBeDefined();
  expect(files["Ideensammlung.md"]).toContain("[[Willkommen]]");
});
