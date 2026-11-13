import { expect, test } from "@playwright/test";

test("completes headings and block ids after [[Note#", async ({ page }) => {
  test.skip(
    test.info().project.name === "android-layout",
    "Phones open notes in reading view; completion is the same code.",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    if (localStorage.getItem("basalt-demo-v1")) return;
    localStorage.setItem(
      "basalt-demo-v1",
      JSON.stringify({
        "Rocks.md":
          "# Rocks\n\n## Basalt columns\n\nHexagons. ^hexagons\n\n## Obsidian glass\n",
        "Draft.md": "Start\n",
      }),
    );
    localStorage.setItem(
      'basalt-workspace:"basalt-demo-v1"',
      JSON.stringify({ tabs: [{ path: "Draft.md" }], active: 0 }),
    );
  });
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Draft");
  const editor = page.getByRole("textbox", { name: "Markdown-Editor" });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nSee [[Rocks#Obs");
  const options = page.locator(".cm-tooltip-autocomplete li");
  await expect(options).toHaveText(["Obsidian glassH2"]);
  // Enter is ignored for a moment after the list opens; a click is not.
  await options.first().click();
  await page.keyboard.type(" and [[Rocks#^");
  await expect(options.first()).toContainText("hexagons");
  await options.first().click();
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("basalt-demo-v1")!)["Draft.md"],
      ),
    )
    .toBe("Start\n\nSee [[Rocks#Obsidian glass]] and [[Rocks#^hexagons]]");
  expect(errors).toEqual([]);
});
