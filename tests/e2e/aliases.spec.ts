import { expect, test } from "@playwright/test";

test("aliases complete to [[Note|Alias]] and find notes in the switcher", async ({
  page,
}) => {
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
        "Geology/Basalt.md": "---\naliases: [Lava rock]\n---\nDark rock.",
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
  await page.getByRole("textbox", { name: "Markdown-Editor" }).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nAbout [[Lava");
  const option = page.locator(".cm-tooltip-autocomplete li", {
    hasText: "Lava rock",
  });
  await expect(option).toContainText("→ Basalt");
  await option.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("basalt-demo-v1")!)["Draft.md"],
      ),
    )
    .toBe("Start\n\nAbout [[Basalt|Lava rock]]");

  await page.keyboard.press("ControlOrMeta+o");
  await page.keyboard.type("lava");
  const suggestion = page.locator(".suggestion-item", { hasText: "Lava rock" });
  await expect(suggestion).toContainText("→ Geology/Basalt");
  await suggestion.click();
  await expect(page.locator("#tab-name")).toHaveText("Basalt");
  expect(errors).toEqual([]);
});
