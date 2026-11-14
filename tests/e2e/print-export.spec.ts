import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function command(page: import("@playwright/test").Page, name: string) {
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("textbox", { name: "Befehlspalette" }).fill(name);
  await page.keyboard.press("Enter");
}

test("prints only the rendered note, in light colours", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  // Record what the print dialog would get instead of opening it.
  await page.evaluate(() => {
    window.print = () => {
      const root = document.getElementById("print-root");
      (window as unknown as Record<string, unknown>).printed = {
        text: root?.textContent ?? "",
        theme: document.documentElement.dataset.theme,
        printing: document.body.classList.contains("is-printing"),
        title: document.title,
      };
      setTimeout(() => window.dispatchEvent(new Event("afterprint")));
    };
  });
  await command(page, "Drucken oder als PDF speichern");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as Record<string, unknown>).printed,
      ),
    )
    .toMatchObject({ theme: "light", printing: true, title: "Willkommen" });
  const printed = await page.evaluate(
    () => (window as unknown as { printed: { text: string } }).printed.text,
  );
  expect(printed).toContain("Platz für deine Gedanken.");
  // Afterwards the app is back to normal.
  await expect(page.locator("#print-root")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).not.toHaveClass(/is-printing/);
});

test("exports a standalone HTML file", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  const download = page.waitForEvent("download");
  await command(page, "Aktuelle Notiz als HTML exportieren");
  const file = await download;
  expect(file.suggestedFilename()).toBe("Willkommen.html");
  const html = await readFile((await file.path())!, "utf8");
  expect(html).toMatch(/^<!doctype html>/);
  expect(html).toContain("<title>Willkommen</title>");
  expect(html).toContain("Platz für deine Gedanken.");
  expect(html).toContain("<style>");
  expect(html).not.toContain('class="copy-code-button"');
});
