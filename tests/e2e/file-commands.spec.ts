import { expect, test } from "@playwright/test";

test("moves and deletes the current file from the command palette", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    if (localStorage.getItem("basalt-demo-v1")) return;
    localStorage.setItem(
      "basalt-demo-v1",
      JSON.stringify({
        "Plan.md": "Der Plan",
        "Archiv/Alt.md": "Alt",
        "Archiv/2025/Rückblick.md": "Rückblick",
      }),
    );
    localStorage.setItem(
      'basalt-workspace:"basalt-demo-v1"',
      JSON.stringify({ tabs: [{ path: "Plan.md" }], active: 0 }),
    );
  });
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Plan");
  const palette = async (command: string) => {
    await page.keyboard.press("ControlOrMeta+p");
    await page.getByRole("textbox", { name: "Befehlspalette" }).fill(command);
    await page.keyboard.press("Enter");
  };
  const stored = () =>
    page.evaluate(() =>
      Object.keys(JSON.parse(localStorage.getItem("basalt-demo-v1")!))
        .filter((path) => !path.startsWith(".basalt/"))
        .sort(),
    );

  await palette("Aktuelle Datei verschieben nach");
  const picker = page.getByRole("dialog", { name: "Datei verschieben nach" });
  await expect(picker.locator(".suggestion-item")).toHaveText([
    "Archiv",
    "Archiv/2025",
  ]);
  await picker.getByRole("textbox").fill("2025");
  await page.keyboard.press("Enter");
  await expect
    .poll(stored)
    .toEqual([
      "Archiv/2025/Plan.md",
      "Archiv/2025/Rückblick.md",
      "Archiv/Alt.md",
    ]);
  await expect(page.locator("#tab-name")).toHaveText("Plan");

  await palette("Aktuelle Datei löschen");
  await page
    .getByRole("dialog", { name: "Datei löschen" })
    .getByRole("button", { name: "In Papierkorb verschieben", exact: true })
    .click();
  await expect
    .poll(stored)
    .toEqual(["Archiv/2025/Rückblick.md", "Archiv/Alt.md"]);
  expect(errors).toEqual([]);
});
