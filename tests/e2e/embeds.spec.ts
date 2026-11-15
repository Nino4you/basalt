import { expect, test } from "@playwright/test";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#4f6bd8"/></svg>';

test("live preview renders image, section and block embeds", async ({
  page,
}) => {
  test.skip(
    test.info().project.name === "android-layout",
    "Phones open notes in reading view; the editor code is the same.",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((svg) => {
    if (localStorage.getItem("basalt-demo-v1")) return;
    localStorage.setItem(
      "basalt-demo-v1",
      JSON.stringify({
        "Media/Blue.svg": svg,
        "Source.md":
          "# Source\n\nIntro\n\n## Goals\n\n- Fast\n- Local\n\n## Risks\n\nWrites are not atomic. ^risk\n",
        "Embeds.md":
          "Start\n\n![[Blue.svg|120]]\n\n![[Source#Goals]]\n\n![[Source#^risk]]\n\n![[Source#Missing]]\n",
      }),
    );
    localStorage.setItem(
      'basalt-workspace:"basalt-demo-v1"',
      JSON.stringify({ tabs: [{ path: "Embeds.md" }], active: 0 }),
    );
  }, SVG);
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Embeds");
  const editor = page.locator(".cm-content");

  const image = editor.locator(".cm-embed-image img");
  await expect(image).toHaveAttribute("src", /^data:image\/svg\+xml/);
  await expect(image).toHaveAttribute("width", "120");
  const sections = editor.locator(".cm-embed-note .markdown-embed-content");
  await expect(sections.nth(0)).toContainText("Goals");
  await expect(sections.nth(0)).toContainText("Local");
  await expect(sections.nth(0)).not.toContainText("Writes");
  await expect(sections.nth(1)).toHaveText("Writes are not atomic.");
  await expect(sections.nth(2)).toHaveText("Abschnitt „Missing“ nicht gefunden.");
  await expect(editor).not.toContainText("![[Blue.svg|120]]");

  // A click on the image shows its source and keeps the image below it.
  await image.click();
  await expect(editor).toContainText("![[Blue.svg|120]]");
  await expect(editor.locator(".cm-embed-image img")).toBeVisible();

  // Links inside an embedded section open the note.
  await editor.locator(".cm-embed-note .markdown-embed-link").first().click();
  await expect(page.locator("#tab-name")).toHaveText("Source");
  expect(errors).toEqual([]);
});
