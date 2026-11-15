import { expect, test, type Page } from "@playwright/test";

const demo = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("basalt-demo-v1")!) as Record<
        string,
        string
      >,
  );

const BASE = `filters:
  and:
    - file.inFolder("Bücher")
formulas:
  sterne: 'if(bewertung, "★".repeat(bewertung), "")'
properties:
  formula.sterne:
    displayName: Sterne
views:
  - type: table
    name: Alle
    order: [file.name, autor, jahr, formula.sterne]
  - type: cards
    name: Regal
    groupBy:
      property: status
      direction: ASC
`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript((base) => {
    if (localStorage.getItem("basalt-demo-v1")) return;
    localStorage.setItem("basalt-settings", JSON.stringify({ language: "de" }));
    const book = (autor: string, jahr: number, bewertung: number | null, status: string) =>
      `---\nautor: ${autor}\njahr: ${jahr}\nbewertung: ${bewertung ?? ""}\nstatus: ${status}\n---\n`;
    localStorage.setItem(
      "basalt-demo-v1",
      JSON.stringify({
        "Bücher/Dune.md": book("Frank Herbert", 1965, 5, "gelesen"),
        "Bücher/Momo.md": book("Michael Ende", 1973, 4, "lese ich"),
        "Bücher/Solaris.md": book("Stanisław Lem", 1961, null, "gelesen"),
        "Anderes.md": "---\nautor: Niemand\n---\n",
        "Leseliste.base": base,
      }),
    );
    localStorage.setItem(
      'basalt-workspace:"basalt-demo-v1"',
      JSON.stringify({ tabs: [{ path: "Leseliste.base" }], active: 0 }),
    );
  }, BASE);
  await page.goto("/");
});

test("shows a base as a table, sorts by a column and saves the sort", async ({
  page,
}) => {
  const table = page.getByRole("table", { name: "Alle" });
  await expect(table).toBeVisible();
  await expect(page.locator(".bases-count")).toHaveText("3 Ergebnisse");
  const names = table.locator("tbody tr td:first-child");
  await expect(names).toHaveText(["Dune", "Momo", "Solaris"]);
  await expect(table.getByRole("columnheader")).toHaveText([
    "Dateiname",
    "autor",
    "jahr",
    "Sterne",
  ]);
  await expect(table.locator("tbody tr").first()).toContainText("★★★★★");

  await table.getByRole("button", { name: "jahr" }).click();
  await expect(names).toHaveText(["Solaris", "Dune", "Momo"]);
  await table.getByRole("button", { name: "jahr" }).click();
  await expect(names).toHaveText(["Momo", "Dune", "Solaris"]);
  await expect
    .poll(async () => (await demo(page))["Leseliste.base"])
    .toBe(
      BASE.replace(
        "order: [file.name, autor, jahr, formula.sterne]\n",
        "order: [file.name, autor, jahr, formula.sterne]\n    sort:\n      - property: jahr\n        direction: DESC\n",
      ),
    );

  await names.getByText("Momo").click();
  await expect(page.locator("#tab-name")).toHaveText("Momo");
});

test("switches to cards grouped by a property", async ({ page }) => {
  await page.getByRole("tab", { name: "Regal" }).click();
  const groups = page.locator(".bases-cards-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.first()).toContainText("gelesen");
  await expect(page.locator(".bases-card-title")).toHaveText([
    "Dune",
    "Solaris",
    "Momo",
  ]);
});

test("edits the base source and reports expression errors", async ({ page }) => {
  await page.getByRole("button", { name: "Quelltext bearbeiten" }).click();
  const source = page.getByRole("textbox", { name: "Base-Quelltext" });
  await expect(source).toHaveValue(BASE);
  await source.fill(BASE.replace('file.inFolder("Bücher")', "jahr > 1962"));
  await page.getByRole("button", { name: "Ansicht zeigen" }).click();
  await expect(
    page.getByRole("table", { name: "Alle" }).locator("tbody tr td:first-child"),
  ).toHaveText(["Dune", "Momo"]);
  await expect
    .poll(async () => (await demo(page))["Leseliste.base"])
    .toContain("jahr > 1962");

  await page.getByRole("button", { name: "Quelltext bearbeiten" }).click();
  await source.fill(BASE.replace('file.inFolder("Bücher")', "jahr >"));
  await page.getByRole("button", { name: "Ansicht zeigen" }).click();
  await expect(page.getByRole("alert")).toContainText("Fehler in der Base");
});

test("creates a new base from the command palette", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("textbox", { name: "Befehlspalette" }).fill("Neue Base erstellen");
  await page.keyboard.press("Enter");
  await expect(page.locator("#tab-name")).toHaveText("Unbenannt.base");
  await expect(page.getByRole("table", { name: "Tabelle" })).toBeVisible();
  // Without filters a base lists every note.
  await expect(page.locator(".bases-count")).toHaveText("4 Ergebnisse");
});
