import { expect, test, type Page } from "@playwright/test";

test.skip(
  () => test.info().project.name === "android-layout",
  "Workspaces and pop-out windows are desktop features",
);

async function seed(page: Page) {
  await page.addInitScript(() => {
    if (localStorage.getItem("basalt-demo-v1")) return;
    localStorage.setItem(
      "basalt-demo-v1",
      JSON.stringify({
        "Plan.md": "# Plan\n\nDer Plan",
        "Ideen.md": "# Ideen\n\nViele Ideen",
        "Notizen/Meeting.md": "# Meeting\n\nProtokoll",
      }),
    );
    localStorage.setItem(
      'basalt-workspace:"basalt-demo-v1"',
      JSON.stringify({ tabs: [{ path: "Plan.md" }], active: 0 }),
    );
  });
}

async function palette(page: Page, command: string) {
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("textbox", { name: "Befehlspalette" }).fill(command);
  await page.keyboard.press("Enter");
}

const tabTitles = (page: Page) =>
  page
    .locator(".workspace-tab-header-inner-title")
    .evaluateAll((tabs) => tabs.map((el) => el.textContent));

test("saves the layout as a named workspace and loads it again", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seed(page);
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Plan");

  // Two groups side by side: Plan | Ideen.
  await page
    .locator(".mod-root .workspace-tab-header", { hasText: "Plan" })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Nach rechts teilen" }).click();
  await expect(page.locator(".workspace-group")).toHaveCount(2);
  await palette(page, "Schnellauswahl öffnen");
  await page.getByRole("textbox", { name: "Schnellauswahl" }).fill("Ideen");
  await page.keyboard.press("Enter");
  await expect(page.locator("#tab-name")).toHaveText("Ideen");

  await palette(page, "Workspaces verwalten");
  const dialog = page.getByRole("dialog", { name: "Workspaces" });
  await expect(dialog).toContainText("Noch keine Workspaces gespeichert.");
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(dialog.locator(".field-error")).toHaveText(
    "Gib einen Namen ein.",
  );
  await dialog
    .getByRole("textbox", { name: "Name des Workspace" })
    .fill("Recherche");
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(dialog.locator(".workspace-item")).toHaveCount(1);
  await expect(dialog.locator(".workspace-item.is-active")).toContainText(
    "Recherche",
  );
  await page.keyboard.press("Escape");

  // Change everything: one group with a different note, left sidebar closed.
  await page
    .locator(".workspace-group")
    .first()
    .locator(".workspace-tab-header")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Schließen", exact: true }).click();
  await expect(page.locator(".workspace-group")).toHaveCount(1);
  await palette(page, "Schnellauswahl öffnen");
  await page.getByRole("textbox", { name: "Schnellauswahl" }).fill("Meeting");
  await page.keyboard.press("Enter");
  await expect(page.locator("#tab-name")).toHaveText("Meeting");

  await palette(page, "Workspace laden");
  await page.getByRole("textbox", { name: "Workspace laden" }).fill("rech");
  await page.keyboard.press("Enter");
  await expect(page.locator(".workspace-group")).toHaveCount(2);
  await expect.poll(() => tabTitles(page)).toEqual(["Plan", "Ideen"]);
  await expect(page.locator("#tab-name")).toHaveText("Ideen");

  // Survives a reload, including which workspace is active.
  await page.reload();
  await palette(page, "Workspaces verwalten");
  await expect(
    page.getByRole("dialog", { name: "Workspaces" }).locator(".is-active"),
  ).toContainText("Recherche");
  await page
    .getByRole("button", { name: "Workspace „Recherche“ löschen" })
    .click();
  await page.getByRole("button", { name: "Löschen", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Workspaces" })).toContainText(
    "Noch keine Workspaces gespeichert.",
  );
  expect(errors).toEqual([]);
});

test("opens a note in a pop-out window that syncs saves both ways", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seed(page);
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Plan");

  const opened = context.waitForEvent("page");
  await page
    .locator(".mod-root .workspace-tab-header", { hasText: "Plan" })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "In neuem Fenster öffnen" }).click();
  const popup = await opened;
  popup.on("pageerror", (error) => errors.push(error.message));
  await expect(popup.locator("#tab-name")).toHaveText("Plan");
  await expect(popup).toHaveTitle(/^Plan/);
  await expect(popup.locator(".workspace-ribbon")).toBeHidden();
  await expect(popup.locator(".mod-root .workspace-tab-header")).toHaveCount(1);

  // Typing in the pop-out reaches the main window after the autosave.
  const popupEditor = popup.getByRole("textbox", { name: "Markdown-Editor" });
  await popupEditor.click();
  await popup.keyboard.press("ControlOrMeta+End");
  await popup.keyboard.type(" aus dem Fenster");
  await expect(
    page.getByRole("textbox", { name: "Markdown-Editor" }),
  ).toContainText("Der Plan aus dem Fenster", { timeout: 10_000 });

  // The pop-out never replaces the main window's saved tabs.
  const workspace = await page.evaluate(() =>
    localStorage.getItem('basalt-workspace:"basalt-demo-v1"'),
  );
  expect(workspace).not.toContain("popout");
  expect(errors).toEqual([]);
});
