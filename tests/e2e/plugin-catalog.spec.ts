import { expect, test } from "@playwright/test";

const catalog = [
  {
    id: "obsidian-excalidraw-plugin",
    name: "Excalidraw",
    author: "Zsolt Viczian",
    description: "Sketch hand-drawn diagrams.",
    repo: "zsviczian/obsidian-excalidraw-plugin",
  },
  {
    id: "dataview",
    name: "Dataview",
    author: "Michael Brenan",
    description: "Complex data views for the data-obsessed.",
    repo: "blacksmithgu/obsidian-dataview",
  },
  {
    id: "calendar",
    name: "Calendar",
    author: "Liam Cain",
    description: "Calendar view of your daily notes.",
    repo: "liamcain/obsidian-calendar-plugin",
  },
];

test("browses the community catalog, checked plugins first", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const releases =
    "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master";
  const cors = { "access-control-allow-origin": "*" };
  await page.route(`${releases}/community-plugins.json`, (route) =>
    route.fulfill({ json: catalog, headers: cors }),
  );
  await page.route(`${releases}/community-plugin-stats.json`, (route) =>
    route.fulfill({
      json: { dataview: { downloads: 3_100_000 }, calendar: { downloads: 10 } },
      headers: cors,
    }),
  );
  await page.goto("/");
  if (test.info().project.name === "android-layout") {
    await page.getByRole("button", { name: "Menü", exact: true }).click();
    await page.getByRole("menuitem", { name: "Einstellungen" }).click();
    await page.getByText("Community-Plugins").click();
  } else {
    await page
      .getByRole("button", { name: "Einstellungen", exact: true })
      .click();
    await page.getByRole("tab", { name: "Community-Plugins" }).click();
  }
  // Installing needs the native app; the demo can only browse.
  await expect(page.getByRole("button", { name: "Von GitHub" })).toBeDisabled();
  await page.getByRole("button", { name: "Durchsuchen" }).click();

  const dialog = page.getByRole("dialog", {
    name: "Community-Plugins durchsuchen",
  });
  const rows = dialog.locator(".plugin-catalog-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("Excalidraw");
  await expect(rows.first()).toContainText("Geprüft");
  await expect(rows.nth(1)).toContainText("Dataview");

  await dialog
    .getByRole("searchbox", { name: "Plugins suchen …" })
    .fill("daily");
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  await expect(dialog.locator(".plugin-catalog-name")).toHaveText("Calendar");
  await expect(dialog).toContainText("Nicht mit Basalt geprüft");
  await expect(
    dialog.getByRole("button", { name: "Installieren", exact: true }),
  ).toBeDisabled();
  await expect(dialog).toContainText(
    "Plugins lassen sich nur in der nativen App installieren.",
  );
  expect(errors).toEqual([]);
});
