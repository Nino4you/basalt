import { expect, test, type Page } from "@playwright/test";

const editorOf = (page: Page) =>
  page.getByRole("textbox", { name: "Markdown-Editor" });

async function createNote(page: Page, name: string) {
  await page.getByRole("button", { name: "Neue Notiz", exact: true }).click();
  await page.locator("#new-name").fill(name);
  await page
    .getByRole("button", { name: "Notiz anlegen", exact: true })
    .click();
  await expect(page.locator("#tab-name")).toHaveText(name);
}

async function fileMenu(page: Page, item: string) {
  await page
    .getByRole("button", { name: "Weitere Optionen", exact: true })
    .click();
  await page.getByRole("menuitem", { name: item }).click();
}

/** Autosave runs 800 ms after the last edit; the status turns to "saved". */
async function typeAndSave(page: Page, text: string) {
  // fill() can append right after a reload; select everything and replace it.
  await editorOf(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("basalt-demo-v1")!)["Verlauf.md"],
      ),
    )
    .toBe(text);
}

test("restores an earlier version without losing the current one", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await createNote(page, "Verlauf");
  await typeAndSave(page, "Erste Fassung");
  // A quick correction of the app's own autosave gets no version of its own.
  await typeAndSave(page, "Erste Fassung, korrigiert");
  // A new session backs up what it finds on disk before replacing it.
  const reopen = async (loaded: string) => {
    await page.reload();
    await expect(page.locator("#tab-name")).toHaveText("Verlauf");
    await expect(editorOf(page)).toContainText(loaded);
  };
  await reopen("Erste Fassung, korrigiert");
  await typeAndSave(page, "Zweite Fassung");
  await reopen("Zweite Fassung");
  await typeAndSave(page, "Dritte Fassung");

  await fileMenu(page, "Versionsverlauf");
  const dialog = page.getByRole("dialog", { name: "Dateiwiederherstellung" });
  await expect(dialog).toBeVisible();
  // Opened on this note, with the newest version selected and compared.
  await expect(dialog.locator(".recovery-diff-line.is-add")).toHaveText(
    "+ Zweite Fassung",
  );
  await expect(dialog.locator(".recovery-diff-line.is-remove")).toHaveText(
    "− Dritte Fassung",
  );

  const back = dialog.getByRole("button", { name: "Zurück", exact: true });
  if (await back.isVisible()) await back.click();
  const rows = dialog.locator(".recovery-row");
  await expect(rows).toHaveCount(3);
  await rows.nth(1).click();
  await dialog.getByRole("button", { name: "Inhalt", exact: true }).click();
  await expect(dialog.locator(".recovery-text")).toHaveText(
    "Erste Fassung, korrigiert",
  );
  await dialog
    .getByRole("button", { name: "Wiederherstellen", exact: true })
    .click();

  await expect(dialog).toBeHidden();
  // The editor also shows the inline title.
  await expect(editorOf(page)).toContainText("Erste Fassung, korrigiert");
  await expect(editorOf(page)).not.toContainText("Dritte Fassung");
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("basalt-demo-v1")!)["Verlauf.md"],
      ),
    )
    .toBe("Erste Fassung, korrigiert");

  // The replaced content is a version itself now.
  await fileMenu(page, "Versionsverlauf");
  if (await back.isVisible()) await back.click();
  await expect(rows).toHaveCount(4);
  await rows.first().click();
  await dialog.getByRole("button", { name: "Inhalt", exact: true }).click();
  await expect(dialog.locator(".recovery-text")).toHaveText("Dritte Fassung");
  expect(errors).toEqual([]);
});

test("brings a deleted note back, as a copy when the name is taken", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await createNote(page, "Weg");
  await editorOf(page).fill("Nicht vergessen");
  await fileMenu(page, "In Papierkorb verschieben");
  await page
    .getByRole("dialog", { name: "Datei löschen" })
    .getByRole("button", { name: "In Papierkorb verschieben", exact: true })
    .click();
  await expect(editorOf(page)).toBeHidden();

  await page.keyboard.press("ControlOrMeta+p");
  await page
    .getByRole("textbox", { name: "Befehlspalette" })
    .fill("Dateiwiederherstellung öffnen");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Dateiwiederherstellung" });
  await dialog.getByRole("tab", { name: "Gelöschte Dateien" }).click();
  await dialog.locator(".recovery-row", { hasText: "Weg" }).click();
  await expect(dialog.locator(".recovery-text")).toHaveText("Nicht vergessen");
  await dialog
    .getByRole("button", { name: "Wiederherstellen", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#tab-name")).toHaveText("Weg");
  await expect(editorOf(page)).toContainText("Nicht vergessen");

  // A new "Weg.md" with other content: the backup comes back as a copy.
  await editorOf(page).fill("Neuer Inhalt");
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("basalt-demo-v1")!)["Weg.md"],
      ),
    )
    .toBe("Neuer Inhalt");
  await page.keyboard.press("ControlOrMeta+p");
  await page
    .getByRole("textbox", { name: "Befehlspalette" })
    .fill("Dateiwiederherstellung öffnen");
  await page.keyboard.press("Enter");
  await dialog.getByRole("tab", { name: "Gelöschte Dateien" }).click();
  await dialog.locator(".recovery-row", { hasText: "Weg" }).click();
  await dialog
    .getByRole("button", { name: "Als Kopie wiederherstellen", exact: true })
    .click();
  await expect(page.locator("#tab-name")).toHaveText("Weg (wiederhergestellt)");
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("basalt-demo-v1")!),
  );
  expect(stored["Weg.md"]).toBe("Neuer Inhalt");
  expect(stored["Weg (wiederhergestellt).md"]).toBe("Nicht vergessen");
  expect(errors).toEqual([]);
});
