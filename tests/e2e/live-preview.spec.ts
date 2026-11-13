import { expect, test, type Page } from "@playwright/test";

const doc =
  "Anfang $x^2$.\n\n$$\\frac{1}{2}$$\n\n| Name | Wert |\n| :--- | ---: |\n| **Alpha** | $x$ |\n| Beta | Ende |\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nSchluss";
async function open(page: Page, text = doc) {
  await page.addInitScript((text) => {
    if (!localStorage.getItem("basalt-demo-v1")) {
      localStorage.setItem(
        "basalt-demo-v1",
        JSON.stringify({ "Live.md": text }),
      );
      localStorage.setItem(
        'basalt-workspace:"basalt-demo-v1"',
        JSON.stringify({
          tabs: [{ path: "Live.md", reading: false }],
          active: 0,
        }),
      );
    }
  }, text);
  await page.goto("/");
}
test("renders rich content in the editor and reveals only the active source", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await expect(page.locator("#editor .katex").first()).toBeVisible();
  await expect(page.locator("#editor .katex-display")).toBeVisible();
  await expect(page.locator("#editor .mermaid-diagram svg")).toBeVisible({
    timeout: 20000,
  });
  await page.locator("#editor .cm-rich-math").first().click();
  await expect(page.locator("#editor .cm-content")).toContainText("$x^2$");
  await page.keyboard.type("y");
  await page.keyboard.press("Escape");
  await expect(page.locator("#editor .cm-rich-math").first()).toContainText(
    "y",
  );
  await page.locator("#editor .cm-rich-mermaid").click();
  await expect(page.locator("#editor .cm-content")).toContainText(
    "flowchart LR",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator("#editor .mermaid-diagram svg")).toBeVisible();
  expect(errors).toEqual([]);
});

test("keeps composition, paste and table-edge navigation inside the same editor", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await page.locator("#editor .cm-live-table td").first().click();
  const input = page.getByRole("textbox", { name: "Tabellenzelle 2, 1" });
  await input.evaluate((el: HTMLInputElement) => {
    (window as unknown as { cellInput: HTMLInputElement }).cellInput = el;
    el.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    el.value = "日本語";
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing: true }),
    );
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  await expect(input).toBeFocused();
  expect(
    await input.evaluate(
      (el) => el === (window as unknown as { cellInput: Element }).cellInput,
    ),
  ).toBe(true);
  await input.evaluate((el: HTMLInputElement) => {
    el.select();
    const data = new DataTransfer();
    data.setData("text/plain", "eins\nzwei|drei");
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(input).toHaveValue("eins zwei\\|drei");
  await page.keyboard.press("Escape");
  await expect(page.locator("#editor .cm-live-table td").first()).toHaveText(
    "eins zwei|drei",
  );
  await page.locator("#editor .cm-live-table th").first().click();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#editor .cm-table-cell-input")).toHaveCount(0);
  await page.locator("#editor .cm-live-table td").last().click();
  await page.keyboard.press("Tab");
  await expect(page.locator("#editor .cm-table-cell-input")).toHaveCount(0);
  await expect(page.locator("#editor .cm-live-table tr")).toHaveCount(3);
  expect(errors).toEqual([]);
});

test("edits only one table cell with history and keyboard navigation", async ({
  page,
}) => {
  await open(page);
  const cells = page.locator("#editor .cm-live-table td");
  await expect(cells.first()).toContainText("Alpha");
  await cells.first().click();
  const input = page.getByRole("textbox", { name: "Tabellenzelle 2, 1" });
  await expect(input).toHaveValue("**Alpha**");
  await input.fill("");
  await input.pressSequentially("Neu mit Abstand ");
  await expect(input).toHaveValue("Neu mit Abstand ");
  await input.fill("Neu");
  await expect(input).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("textbox", { name: "Tabellenzelle 2, 2" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(input).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(cells.first()).toHaveText("Neu");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(cells.first()).toHaveText("Alpha");
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+Shift+z" : "Control+y",
  );
  await expect(cells.first()).toHaveText("Neu");
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("basalt-demo-v1")!)["Live.md"],
      ),
    )
    .toContain("| Neu | $x$ |");
  await page.reload();
  await expect(cells.first()).toHaveText("Neu");
});

test("preserves header focus, TeX backslashes and code-cell boundaries while typing", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, "A | B\n--- | ---\nx | `y`\n\nEnde");
  await page.locator("#editor .cm-live-table th").first().click();
  const header = page.getByRole("textbox", { name: "Tabellenzelle 1, 1" });
  await header.fill("Titel");
  await expect(header).toBeFocused();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(header).toHaveValue("A");
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+Shift+z" : "Control+y",
  );
  await expect(header).toHaveValue("Titel");
  await page.keyboard.press("Enter");
  await page.locator("#editor .cm-live-table td").first().click();
  const cell = page.getByRole("textbox", { name: "Tabellenzelle 2, 1" });
  await cell.fill("");
  await cell.pressSequentially("$\\frac{1}{2}$");
  await expect(cell).toHaveValue("$\\frac{1}{2}$");
  await cell.fill("");
  await cell.pressSequentially("`code`");
  await expect(cell).toHaveValue("`code`");
  await expect(cell).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#editor .cm-live-table td code")).toHaveText([
    "code",
    "y",
  ]);
  expect(errors).toEqual([]);
});

test("keeps tables and rich widgets usable at narrow and wide viewports", async ({
  page,
}) => {
  await open(page);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    // Crossing a layout breakpoint slides sidebars; tap once they settle.
    await page.waitForFunction(
      () =>
        !document
          .getAnimations()
          .some((animation) => animation instanceof CSSTransition),
    );
    await expect(page.locator("#editor .cm-live-table")).toBeVisible();
    await expect(page.locator("#editor .katex").first()).toBeVisible();
    await expect(page.locator("#editor .mermaid-diagram svg")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.locator("#editor .cm-live-table td").first().click();
    await expect(
      page.getByRole("textbox", { name: "Tabellenzelle 2, 1" }),
    ).toBeFocused();
    await page.screenshot({
      path: `test-results/seamless-live-preview/table-${width}.png`,
    });
    await page.keyboard.press("Escape");
  }
});
