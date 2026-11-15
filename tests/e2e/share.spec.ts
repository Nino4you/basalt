import { expect, test, type Page } from "@playwright/test";

/**
 * The browser demo has no Android activity; this stands in for its
 * `BasaltAndroid.takeShare()` bridge so the share dialog can be driven.
 */
async function withShareBridge(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem("basalt-demo-v1")) {
      localStorage.setItem(
        "basalt-demo-v1",
        JSON.stringify({ "Einkauf.md": "# Einkauf\n\n- Brot" }),
      );
      localStorage.setItem(
        'basalt-workspace:"basalt-demo-v1"',
        JSON.stringify({ tabs: [{ path: "Einkauf.md" }], active: 0 }),
      );
    }
    const queue: string[] = [];
    (window as unknown as { BasaltAndroid: object }).BasaltAndroid = {
      insets: () => "{}",
      takeShare: () => queue.shift() ?? null,
    };
    (window as unknown as { share: (value: object) => void }).share = (
      value,
    ) => {
      queue.push(JSON.stringify(value));
      window.dispatchEvent(new CustomEvent("basalt-share", { detail: null }));
    };
  });
}

const share = (page: Page, value: object) =>
  page.evaluate(
    (data) => (window as unknown as { share: (v: object) => void }).share(data),
    value,
  );

test("saves text shared from another app as a new note", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await withShareBridge(page);
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Einkauf");

  await share(page, {
    subject: "Sauerteigbrot",
    text: "500 g Mehl\n350 g Wasser\n100 g Anstellgut",
    files: [],
    skipped: ["video.mp4"],
  });
  const dialog = page.getByRole("dialog", { name: "Mit Basalt teilen" });
  await expect(dialog).toContainText("500 g Mehl");
  await expect(dialog).toContainText("1 Datei wurde nicht übernommen");
  await expect(
    dialog.getByRole("textbox", { name: "Name der Notiz" }),
  ).toHaveValue("Sauerteigbrot");
  await dialog
    .getByRole("button", { name: "Als neue Notiz speichern" })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#tab-name")).toHaveText("Sauerteigbrot");
  await expect(
    page.getByRole("textbox", { name: "Markdown-Editor" }),
  ).toContainText("350 g Wasser");

  // The same name again gets a free one instead of failing.
  await share(page, { subject: "Sauerteigbrot", text: "Variante", files: [] });
  await page
    .getByRole("dialog", { name: "Mit Basalt teilen" })
    .getByRole("button", { name: "Als neue Notiz speichern" })
    .click();
  await expect(page.locator("#tab-name")).toHaveText("Sauerteigbrot 1");
  expect(errors).toEqual([]);
});

test("appends a shared link to the open note", async ({ page }) => {
  await withShareBridge(page);
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Einkauf");
  await share(page, {
    subject: "Brot backen – Anleitung",
    text: "https://example.org/brot",
    files: [],
  });
  const dialog = page.getByRole("dialog", { name: "Mit Basalt teilen" });
  await dialog.getByRole("button", { name: "An „Einkauf“ anhängen" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#tab-name")).toHaveText("Einkauf");
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("basalt-demo-v1")!)["Einkauf.md"],
      ),
    )
    .toBe(
      "# Einkauf\n\n- Brot\n\n[Brot backen – Anleitung](https://example.org/brot)\n",
    );
});
