import { expect, test } from "@playwright/test";

test("creates daily notes in a folder from a template and steps between them", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    if (localStorage.getItem("basalt-demo-v1")) return;
    localStorage.setItem(
      "basalt-settings",
      JSON.stringify({
        language: "de",
        dailyFolder: "Journal",
        dailyFormat: "YYYY-MM-DD",
        dailyTemplate: "_templates/Tag.md",
      }),
    );
    localStorage.setItem(
      "basalt-demo-v1",
      JSON.stringify({
        "_templates/Tag.md": "# {{title}}\nTag: {{date:dddd}}\n",
        "Journal/2020-01-01.md": "Altes Jahr",
        "Journal/2020-01-05.md": "Später",
        "Start.md": "Hallo",
      }),
    );
    localStorage.setItem(
      'basalt-workspace:"basalt-demo-v1"',
      JSON.stringify({ tabs: [{ path: "Start.md" }], active: 0 }),
    );
  });
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Start");
  const palette = async (command: string) => {
    await page.keyboard.press("ControlOrMeta+p");
    await page.getByRole("textbox", { name: "Befehlspalette" }).fill(command);
    await page.keyboard.press("Enter");
  };

  await palette("Heutige Tagesnotiz öffnen");
  const today = await page.evaluate(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  });
  await expect(page.locator("#tab-name")).toHaveText(today);
  const weekday = await page.evaluate(() =>
    new Intl.DateTimeFormat("de", { weekday: "long" }).format(new Date()),
  );
  await expect
    .poll(() =>
      page.evaluate(
        (path) => JSON.parse(localStorage.getItem("basalt-demo-v1")!)[path],
        `Journal/${today}.md`,
      ),
    )
    .toBe(`# ${today}\nTag: ${weekday}\n`);

  await palette("Vorherige Tagesnotiz öffnen");
  await expect(page.locator("#tab-name")).toHaveText("2020-01-05");
  await palette("Vorherige Tagesnotiz öffnen");
  await expect(page.locator("#tab-name")).toHaveText("2020-01-01");
  await palette("Vorherige Tagesnotiz öffnen");
  await expect(
    page.getByText("Keine frühere Tagesnotiz gefunden."),
  ).toBeVisible();
  await palette("Nächste Tagesnotiz öffnen");
  await expect(page.locator("#tab-name")).toHaveText("2020-01-05");
  expect(errors).toEqual([]);
});
