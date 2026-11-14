import { expect, test } from "@playwright/test";

test("links an unlinked mention from the backlinks panel", async ({ page }) => {
  test.skip(
    test.info().project.name === "android-layout",
    "The phone layout keeps side panels in a drawer; the logic is shared.",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    if (localStorage.getItem("basalt-demo-v1")) return;
    localStorage.setItem(
      "basalt-demo-v1",
      JSON.stringify({
        "Basalt.md": "Basalt is a volcanic rock.",
        "Trip.md": "We saw basalt columns. [[Basalt]] is linked already.",
      }),
    );
    localStorage.setItem(
      'basalt-workspace:"basalt-demo-v1"',
      JSON.stringify({ tabs: [{ path: "Basalt.md" }], active: 0 }),
    );
  });
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Basalt");
  await page
    .getByRole("button", { name: "Rechte Seitenleiste umschalten" })
    .click();
  const pane = page.getByRole("tabpanel", { name: "Rückverweise" });
  const toggle = pane.getByRole("button", { name: "Unverlinkte Erwähnungen" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  // The same line is also a linked mention, because of [[Basalt]] at its end.
  const link = page.getByRole("button", { name: "Verknüpfen" });
  const match = pane.locator(".search-result-file-match", { has: link });
  await expect(match).toHaveCount(1);
  await match.getByRole("button", { name: "Verknüpfen" }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("basalt-demo-v1")!)["Trip.md"],
      ),
    )
    .toBe("We saw [[Basalt|basalt]] columns. [[Basalt]] is linked already.");
  await expect(
    pane.getByText("Keine unverlinkten Erwähnungen gefunden."),
  ).toBeVisible();
  await expect(pane.locator(".search-result")).toHaveCount(1);
  expect(errors).toEqual([]);
});
