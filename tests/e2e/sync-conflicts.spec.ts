import { expect, test } from "@playwright/test";

const COPY = "Notiz.sync-conflict-20261114-093000-ABCDEFG.md";

test("finds a sync conflict copy and adopts it after comparing", async ({
  page,
}) => {
  await page.addInitScript((copy) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem(
      "basalt-demo-v1",
      JSON.stringify({
        "Notiz.md": "# Notiz\n\nVom Laptop.\n",
        [copy]: "# Notiz\n\nVom Handy.\n",
      }),
    );
  }, COPY);
  await page.goto("/");
  const status = page.locator("#sync-conflicts");
  await expect(status).toHaveText("1 Sync-Konflikt");
  await expect(page.locator(".notice").first()).toContainText(
    "Sync-Konflikt gefunden",
  );

  // The status bar is hidden on phones; the command works everywhere.
  await page.keyboard.press("ControlOrMeta+p");
  await page
    .getByRole("textbox", { name: "Befehlspalette" })
    .fill("Sync-Konflikte anzeigen");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Sync-Konflikte" });
  await expect(dialog).toContainText(
    "Konfliktkopie von „Notiz.md“ (Syncthing)",
  );
  await dialog.getByRole("button", { name: "Vergleichen" }).click();
  await expect(dialog.locator(".recovery-diff-line.is-remove")).toContainText(
    "Vom Laptop.",
  );
  await expect(dialog.locator(".recovery-diff-line.is-add")).toContainText(
    "Vom Handy.",
  );

  await dialog.getByRole("button", { name: "Kopie übernehmen" }).click();
  await page
    .getByRole("dialog", { name: "Kopie übernehmen" })
    .getByRole("button", { name: "Übernehmen" })
    .click();
  await expect(dialog).toContainText("Keine Sync-Konflikte gefunden.");
  await expect(status).toHaveText("");

  const files = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("basalt-demo-v1")!) as Record<
        string,
        string
      >,
  );
  expect(files["Notiz.md"]).toBe("# Notiz\n\nVom Handy.\n");
  expect(files[COPY]).toBeUndefined();
  // Both the replaced original and the removed copy were kept as backups.
  expect(
    Object.keys(files).some((key) =>
      key.startsWith(".basalt/history/Notiz.md/"),
    ),
  ).toBe(true);
  expect(
    Object.keys(files).some(
      (key) => key.startsWith(".basalt/trash/") && key.endsWith(COPY),
    ),
  ).toBe(true);
});
