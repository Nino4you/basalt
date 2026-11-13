import { expect, test } from "@playwright/test";

test("renders vault PDFs locally and releases attachment resources on switch", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/tests/fixtures/vault.html");
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [{ App }, { CompatibilitySession }, { MemoryPort }] = await Promise.all([
      load("/src/app/app.ts"), load("/src/compat/session.ts"), load("/tests/helpers/vault-store.ts"),
    ]);
    localStorage.clear();
    const app = new App(document.querySelector("#app"));
    await app.start();
    const text = "BT /F1 12 Tf 72 720 Td (Basalt attachment test) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
      "<< /Length 52 >>\nstream\nBT /F1 12 Tf 72 720 Td (Second attachment page) Tj ET\nendstream",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((object, index) => {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
    pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
    pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const port = new MemoryPort({ "Handbuch.pdf": pdf, "Kaputt.pdf": "not a PDF", "Kaputt.png": "not an image", "Folien.pptx": "binary" });
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2;
    canvas.getContext("2d")!.fillRect(0, 0, 2, 2);
    const png = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
    await port.create("Bild.png", new Uint8Array(await png.arrayBuffer()));
    const session = await CompatibilitySession.create({
      vaultId: port.vaultId, name: "Anhänge", mobile: false, port,
      editor: app.editor.compat, extensions: app.editor.extensions,
      container: app.shell.viewContent, navigate: (path: string) => app.openPath(path),
    });
    app.compatibility = session;
    app.syncVisibleFiles();
    (window as any).attachmentTest = { app, session, port, files: app.index.files, revoked: [] as string[] };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      (window as any).attachmentTest.revoked.push(url);
      revoke(url);
    };
    await app.openPath("Handbuch.pdf");
  });

  // PDF.js is a lazily loaded chunk plus a worker; a slow CI runner needs
  // well over the default 5 s for the first page.
  await expect(page.locator(".attachment-host .pdf-view canvas")).toBeVisible({ timeout: 20000 });
  await expect(page.locator(".attachment-host .textLayer")).toContainText("Basalt attachment test", { timeout: 20000 });
  await page.screenshot({ path: testInfo.outputPath("pdf-view.png") });
  const canvasWidth = await page.locator(".attachment-host canvas").evaluate(canvas => canvas.getBoundingClientRect().width);
  await page.getByRole("combobox", { name: "PDF-Vergrößerung" }).selectOption("2");
  await expect.poll(() => page.locator(".attachment-host canvas").evaluate(canvas => canvas.getBoundingClientRect().width)).toBe(1224);
  await expect(page.locator(".attachment-host .textLayer")).toContainText("Basalt attachment test");
  expect(await page.locator(".attachment-host canvas").evaluate(canvas => {
    const raster = canvas as HTMLCanvasElement;
    return raster.width * raster.height;
  })).toBeLessThanOrEqual(8_000_000);
  await page.screenshot({ path: testInfo.outputPath("pdf-zoom.png") });
  await page.getByRole("combobox", { name: "PDF-Vergrößerung" }).selectOption("width");
  await expect.poll(() => page.locator(".attachment-host canvas").evaluate(canvas => canvas.getBoundingClientRect().width)).toBe(canvasWidth);
  await expect(page.locator(".attachment-host .pdf-page-number")).toHaveValue("1");
  await page.getByRole("button", { name: "Nächste PDF-Seite" }).click();
  await expect(page.locator(".attachment-host .textLayer")).toContainText("Second attachment page");
  await expect(page.locator(".attachment-host .pdf-page-number")).toHaveValue("2");
  await page.getByRole("button", { name: "Vorherige PDF-Seite" }).click();
  await expect(page.locator(".attachment-host .textLayer")).toContainText("Basalt attachment test");
  await page.locator(".attachment-host .pdf-page-number").evaluate(input => {
    for (const number of [2, 1, 2, 1]) {
      (input as HTMLInputElement).value = String(number);
      input.dispatchEvent(new Event("change"));
    }
  });
  await expect(page.locator(".attachment-host .pdf-status")).toHaveText("Seite 1 von 2");
  await expect(page.locator(".attachment-host .textLayer")).toContainText("Basalt attachment test");
  await expect(page.locator(".attachment-host canvas")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).attachmentTest.files)).toEqual(
    expect.arrayContaining(["Bild.png", "Folien.pptx", "Handbuch.pdf"]),
  );
  await expect(page.locator(".attachment-host iframe")).toHaveCount(0);
  await expect(page.locator("#editor")).toBeHidden();

  await page.evaluate(() => (window as any).attachmentTest.app.openPath("Bild.png"));
  const image = page.locator(".attachment-host img");
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(2);
  await expect(page.locator(".attachment-host .pdf-view")).toHaveCount(0);
  const imageUrl = await image.getAttribute("src");
  await page.evaluate(() => {
    const app = (window as any).attachmentTest.app;
    app.showActive();
    app.showActive();
  });
  await expect(image).toHaveAttribute("src", imageUrl!);
  expect(await page.evaluate(() => (window as any).attachmentTest.revoked)).not.toContain(imageUrl);

  await page.evaluate(() => (window as any).attachmentTest.app.openPath("Kaputt.png"));
  await expect(page.getByRole("alert")).toContainText("Bild konnte nicht geladen werden");
  await expect(page.locator(".attachment-host img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).attachmentTest.revoked)).toContain(imageUrl);
  await page.evaluate(async () => {
    const { port } = (window as any).attachmentTest;
    const { bytes } = await port.read("Bild.png");
    const { version } = await port.read("Kaputt.png");
    await port.write("Kaputt.png", bytes, version);
  });
  await page.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(2);
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.evaluate(() => (window as any).attachmentTest.app.openPath("Kaputt.pdf"));
  await expect(page.locator(".attachment-host")).toContainText("PDF konnte nicht angezeigt werden");

  await page.evaluate(() => (window as any).attachmentTest.app.openPath("Folien.pptx"));
  await expect(page.locator(".attachment-host")).toContainText("nicht angezeigt");
  await expect(page.locator(".attachment-host iframe, .attachment-host img")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("shows an image next to a note in a split editor", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "android-layout", "phones show one editor group at a time");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/tests/fixtures/vault.html");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [{ App }, { CompatibilitySession }, { MemoryPort }] = await Promise.all([
      load("/src/app/app.ts"), load("/src/compat/session.ts"), load("/tests/helpers/vault-store.ts"),
    ]);
    localStorage.clear();
    const app = new App(document.querySelector("#app"));
    await app.start();
    const port = new MemoryPort({});
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2;
    canvas.getContext("2d")!.fillRect(0, 0, 2, 2);
    const png = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
    await port.create("Bild.png", new Uint8Array(await png.arrayBuffer()));
    app.compatibility = await CompatibilitySession.create({
      vaultId: port.vaultId, name: "Anhänge", mobile: false, port,
      editor: app.editor.compat, extensions: app.editor.extensions,
      container: app.shell.viewContent, navigate: (path: string) => app.openPath(path),
    });
    app.syncVisibleFiles();
    await app.openPath("Bild.png");
    app.splitActive("right");
    await app.openPath("Willkommen.md");
  });
  const groups = page.locator(".workspace-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(1)).toHaveClass(/is-active/);
  await expect(groups.nth(1).locator("#editor")).toContainText("Platz für deine Gedanken.");
  // The unfocused group still shows its image instead of a placeholder.
  const image = groups.nth(0).locator(".mod-mirror .attachment-host img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(2);
  await expect(groups.nth(0).locator(".group-placeholder")).toBeHidden();
  // Re-rendering the groups keeps the same image instead of reloading it.
  const url = await image.getAttribute("src");
  await page.keyboard.type("x");
  await expect(groups.nth(1).locator("#editor")).toContainText("x");
  await expect(image).toHaveAttribute("src", url!);
  expect(errors).toEqual([]);
});
