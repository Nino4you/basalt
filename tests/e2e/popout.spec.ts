import { expect, test, type Page } from "@playwright/test";

test.skip(
  () => test.info().project.name === "android-layout",
  "Pop-out windows are a desktop feature",
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
