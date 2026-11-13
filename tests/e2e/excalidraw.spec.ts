import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginDirectories } from "../helpers/plugin-fixtures";

const id = "obsidian-excalidraw-plugin";
const directory = pluginDirectories().find(path => JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")).id === id);
const csp = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).app.security.csp as string;

for (const enforceCsp of [false, true]) test(`unchanged Excalidraw creates, draws, saves, reloads and disables${enforceCsp ? " under Tauri CSP" : ""}`, async ({ page }, info) => {
  test.skip(!directory, "Set BASALT_PLUGIN_DIRS to an official Excalidraw bundle");
  test.setTimeout(90_000);
  const errors: string[] = [];
  const blockedFonts: string[] = [];
  page.on("pageerror", error => { errors.push(error.stack ?? String(error)); });
  page.on("console", message => {
    // Chromium disallows Excalidraw's third-party unload hook; not a canvas failure.
    if (message.type() !== "error" || message.text().includes("Permissions policy violation: unload")) return;
    const text = message.text();
    // Keep the host policy: this optional upstream CJK font CDN is intentionally unavailable.
    if (enforceCsp && /^Loading the font 'https:\/\/esm\.sh\/@zsviczian\/excalidraw@[^']+\/fonts\/Xiaolai\/[^']+\.woff2' violates/.test(text)) blockedFonts.push(text);
    else errors.push(text.slice(0, 2000));
  });
  const contents = Object.fromEntries(["main.js", "manifest.json", "styles.css"].map(name => [`Basalt/Plugins/${id}/${name}`, readFileSync(join(directory!, name), "utf8")]));
  if (enforceCsp) await page.route("**/tests/fixtures/excalidraw.html", async route => {
    const response = await route.fetch();
    // A native build has no HMR client to be cloned into the plugin's measurement iframe.
    const body = (await response.text()).replace(/<script type="module" src="\/@vite\/client"><\/script>/g, "");
    await route.fulfill({ response, body, headers: { ...response.headers(), "content-security-policy": csp } });
  });
  await page.goto("/tests/fixtures/excalidraw.html");
  await page.evaluate(async contents => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [{ App }, { CompatibilitySession }, { MemoryPort }] = await Promise.all([
      load("/src/app/app.ts"), load("/src/compat/session.ts"), load("/tests/helpers/vault-store.ts"),
    ]);
    localStorage.clear();
    const app = new App(document.querySelector("#app"));
    await app.start();
    const port = new MemoryPort(contents);
    const session = await CompatibilitySession.create({ vaultId: port.vaultId, name: "Excalidraw browser test", mobile: false, port,
      editor: app.editor.compat, extensions: app.editor.extensions, container: app.shell.viewContent,
      navigate: (path: string) => app.openPath(path), ribbonEl: app.shell.pluginRibbon, statusBarEl: app.shell.pluginStatus,
    });
    app.compatibility = session;
    app.bindPluginWorkspace(session);
    (window as any).excalidrawTest = { app, session, port };
    const plugin = await session.bundleHost.enable("obsidian-excalidraw-plugin");
    if (!plugin.isReady || session.services.getCommandsFor(plugin.manifest.id).length < 70) throw new Error("Incomplete plugin startup");
    app.refreshPluginUi();
  }, contents);

  await page.locator(".modal").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "New drawing", exact: true }).click();
  await expect(page.locator(".excalidraw canvas").first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).excalidrawTest.session.workspace.getLeavesOfType("excalidraw")[0]?.view.excalidrawAPI))).toBe(true);
  await page.screenshot({ path: info.outputPath("01-open.png"), fullPage: true });

  const canvas = page.locator(".excalidraw canvas").first();
  const box = (await canvas.boundingBox())!;
  await page.keyboard.press("r");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await expect(page.getByRole("button", { name: "Text", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.7);
  const textInput = page.locator("textarea:visible");
  await expect(textInput).toBeVisible();
  await textInput.fill("Basalt text");
  await textInput.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => (window as any).excalidrawTest.session.workspace
    .getLeavesOfType("excalidraw")[0].view.excalidrawAPI.getSceneElements()
    .some((element: { text?: string }) => element.text === "Basalt text"))).toBe(true);
  const drawn = await page.evaluate(() => {
    const t = (window as any).excalidrawTest;
    const view = t.session.workspace.getLeavesOfType("excalidraw")[0].view;
    const elements = view.excalidrawAPI.getSceneElements();
    return {
      id: elements[0]?.id ?? null,
      count: elements.length,
      path: view.file?.path as string,
      commands: t.session.services.getCommandsFor("obsidian-excalidraw-plugin").map((command: { name: string }) => command.name) as string[],
      text: elements.find((element: { type: string }) => element.type === "text")?.text,
    };
  });
  expect(drawn.count).toBeGreaterThan(0);
  expect(drawn.id).toBeTruthy();
  expect(drawn.text).toBe("Basalt text");
  expect(drawn.commands).toContain("Excalidraw: Save (will also update transclusions)");
  await page.screenshot({ path: info.outputPath("02-drawn.png"), fullPage: true });

  // The plugin's own command is fire-and-forget; accelerate its real autosave loop instead.
  await page.evaluate(() => {
    const t = (window as any).excalidrawTest;
    const view = t.session.workspace.getLeavesOfType("excalidraw")[0].view;
    view.plugin.settings.autosaveIntervalDesktop = 250;
    view.saveCoordinator.resetAutosaveTimer();
  });
  await expect.poll(() => page.evaluate(() => {
    const t = (window as any).excalidrawTest;
    const view = t.session.workspace.getLeavesOfType("excalidraw")[0].view;
    return view.saveCoordinator.savedRevision;
  }), { timeout: 10_000 }).toBeGreaterThan(0);
  const saved = await page.evaluate(async path => {
    const t = (window as any).excalidrawTest;
    const file = t.session.vault.getFileByPath(path);
    return file ? await t.session.vault.read(file) : "";
  }, drawn.path);
  expect(saved.length).toBeGreaterThan(500);
  expect(saved).toContain("excalidraw-plugin: parsed");
  expect(saved).toContain("```");
  await page.screenshot({ path: info.outputPath("03-saved.png"), fullPage: true });

  // A change after the last autosave must survive the immediate close/save path.
  const beforeCloseRevision = await page.evaluate(() => {
    const t = (window as any).excalidrawTest;
    const view = t.session.workspace.getLeavesOfType("excalidraw")[0].view;
    view.plugin.settings.autosaveIntervalDesktop = 60_000;
    view.saveCoordinator.resetAutosaveTimer();
    return view.saveCoordinator.savedRevision as number;
  });
  await page.keyboard.press("r");
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.78, box.y + box.height * 0.75, { steps: 6 });
  await page.mouse.up();
  const ids = await page.evaluate(() => {
    const t = (window as any).excalidrawTest;
    const view = t.session.workspace.getLeavesOfType("excalidraw")[0].view;
    return view.excalidrawAPI.getSceneElements().map((element: { id: string }) => element.id) as string[];
  });
  expect(ids.length).toBeGreaterThan(drawn.count);
  expect(await page.evaluate(() => (window as any).excalidrawTest.session.workspace
    .getLeavesOfType("excalidraw")[0].view.saveCoordinator.savedRevision)).toBe(beforeCloseRevision);

  // Close the view, reopen the same file from the vault, and check the scene survived the round trip.
  await page.locator('.workspace-tab-header.is-active').getByRole("button", { name: "Tab schließen", exact: true }).click();
  await page.evaluate(async path => {
    const t = (window as any).excalidrawTest;
    await t.session.workspace.flushPending();
    if (t.session.workspace.getLeavesOfType("excalidraw").length) throw new Error("Closing the tab left its plugin view open");
    await t.app.openPath(path, { newTab: true, pluginState: { type: "excalidraw" } });
  }, drawn.path);
  await expect.poll(async () => page.evaluate(async ([path, expected]) => {
    const t = (window as any).excalidrawTest;
    const leaves = t.session.workspace.getLeavesOfType("excalidraw");
    const view = leaves[leaves.length - 1]?.view;
    if (!view?.excalidrawAPI || view.file?.path !== path) return null;
    const elements = view.excalidrawAPI.getSceneElements();
    return expected.every((id: string) => elements.some((element: { id: string }) => element.id === id))
      ? elements.length
      : null;
  }, [drawn.path, ids] as const).catch(() => null), { timeout: 30_000 }).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath("04-reloaded.png"), fullPage: true });

  const exported = await page.evaluate(async () => {
    const t = (window as any).excalidrawTest;
    const view = t.session.workspace.getLeavesOfType("excalidraw")[0].view;
    const svg = await view.getSVG(false, false);
    await view.saveSVG({ embedScene: false });
    const file = t.session.vault.getFiles().find((file: { path: string }) => file.path.endsWith(".svg"));
    return {
      tag: svg.tagName.toLowerCase(), text: svg.textContent,
      shapes: svg.querySelectorAll("path, rect").length,
      saved: file ? await t.session.vault.read(file) : null,
    };
  });
  expect(exported.tag).toBe("svg");
  expect(exported.text).toContain("Basalt text");
  expect(exported.shapes).toBeGreaterThan(0);
  expect(exported.saved).toContain("<svg");
  expect(exported.saved).toContain("Basalt text");
  expect(exported.saved).toContain("data:font/woff2;base64,");

  const png = await page.evaluate(async () => {
    const t = (window as any).excalidrawTest;
    const view = t.session.workspace.getLeavesOfType("excalidraw")[0].view;
    await view.savePNG({ embedScene: false });
    const file = t.session.vault.getFiles().find((file: { path: string }) => file.path.endsWith(".png"));
    if (!file) throw new Error("PNG export did not create a vault file");
    const data = await t.session.vault.readBinary(file);
    const image = await createImageBitmap(new Blob([data], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i + 3] > 128 && pixels[i] + pixels[i + 1] + pixels[i + 2] < 300) ink++;
    const result = { width: image.width, height: image.height, ink, bytes: data.byteLength,
      signature: Array.from(new Uint8Array(data, 0, 8)) };
    image.close();
    return result;
  });
  expect(png.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.width).toBeGreaterThan(100);
  expect(png.height).toBeGreaterThan(100);
  expect(png.ink).toBeGreaterThan(100);
  expect(png.bytes).toBeGreaterThan(500);

  const downloadReady = page.waitForEvent("download");
  await page.evaluate(async () => {
    const t = (window as any).excalidrawTest;
    await t.session.workspace.getLeavesOfType("excalidraw")[0].view.exportPNG(false, false);
  });
  const download = await downloadReady;
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  expect(await download.failure()).toBeNull();
  const downloadPath = (await download.path())!;
  expect(Array.from(readFileSync(downloadPath).subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

  await page.evaluate(async path => {
    const t = (window as any).excalidrawTest;
    const text = `Vor der Zeichnung\n\n![[${path}]]\n\nNach der Zeichnung`;
    await t.session.vault.create("Embed.md", text);
    t.app.index.setFiles([...t.app.index.files, path, "Embed.md"]);
    t.app.index.setContent(path, await t.session.vault.read(t.session.vault.getFileByPath(path)));
    const el = t.app.shell.previewEl;
    t.app.shell.pluginView.hidden = true;
    el.hidden = false;
    el.classList.add("excalidraw-embed-test");
    t.reading = t.app.reading;
    t.reading.render("Embed.md", text);
  }, drawn.path);
  const embed = page.locator(".excalidraw-embed-test");
  await expect(embed.locator(".excalidraw-embedded-img")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => embed.locator(".excalidraw-embedded-img").evaluate(element =>
    element instanceof HTMLImageElement ? element.naturalWidth : element.querySelectorAll("svg path, svg rect").length,
  )).toBeGreaterThan(0);
  await expect(embed).toContainText("Vor der Zeichnung");
  await expect(embed).toContainText("Nach der Zeichnung");
  await expect(embed.locator("code.language-compressed-json")).toHaveCount(0);
  await expect(embed.locator('.excalidraw-embed-toolbar')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("05-embedded.png"), fullPage: true });
  await embed.locator('.excalidraw-embed-controls-frame').hover();
  await embed.locator('[data-excalidraw-embed-action="preview"]').click();
  await expect(page.locator('.modal')).toBeVisible();
  const released = await page.evaluate(async () => {
    const t = (window as any).excalidrawTest;
    const children = [...t.reading.children];
    const image = t.app.shell.previewEl.querySelector('.excalidraw-embedded-img');
    const toolbar = t.app.shell.previewEl.querySelector('.excalidraw-embed-toolbar');
    const modal = document.querySelector('.modal');
    const before = { children: children.length, loaded: children.every((child: { _loaded: boolean }) => child._loaded) };
    // Follow the Settings toggle's order, not an unrelated test-only teardown.
    t.app.releasePluginUi();
    await t.session.workspace.flushPending();
    t.app.shell.previewEl.classList.remove("excalidraw-embed-test");
    return { before, loaded: children.some((child: { _loaded: boolean }) => child._loaded),
      remainingChildren: t.reading.children.length, attached: image?.isConnected,
      toolbarAttached: toolbar?.isConnected, modalAttached: modal?.isConnected };
  });
  expect(released.before.children).toBeGreaterThan(0);
  expect(released.before.loaded).toBe(true);
  expect(released).toMatchObject({ loaded: false, remainingChildren: 0, attached: false, toolbarAttached: false, modalAttached: false });

  const shutdown = await page.evaluate(async () => {
    const t = (window as any).excalidrawTest;
    const flatten = (error: any): string[] => [
      String(error?.stack ?? error?.message ?? error),
      ...(Array.isArray(error?.errors) ? error.errors.flatMap(flatten) : []),
      ...(error?.cause ? flatten(error.cause) : []),
    ];
    const errors: string[] = [];
    try {
      await t.session.bundleHost.disable("obsidian-excalidraw-plugin");
    } catch (error) {
      errors.push(...flatten(error));
    }
    try {
      await t.session.workspace.flushPending();
    } catch (error) {
      errors.push(...flatten(error));
    }
    return {
      enabled: t.session.bundleHost.isEnabled("obsidian-excalidraw-plugin"),
      views: t.session.services.getViewsFor("obsidian-excalidraw-plugin"),
      commands: t.session.services.getCommandsFor("obsidian-excalidraw-plugin").length,
      leaves: t.session.workspace.getLeavesOfType("excalidraw").length,
      styles: document.querySelectorAll('[data-basalt-plugin="obsidian-excalidraw-plugin"]').length,
      ribbon: t.session.services.getRibbonIconCount("obsidian-excalidraw-plugin"),
      status: t.session.services.getStatusBarItemCount("obsidian-excalidraw-plugin"),
      errors,
    };
  });
  expect(shutdown).toEqual({ enabled: false, views: [], commands: 0, leaves: 0, styles: 0, ribbon: 0, status: 0, errors: [] });
  expect(errors).toEqual([]);
  if (blockedFonts.length) await info.attach("blocked-optional-cjk-fonts", {
    body: JSON.stringify({ count: blockedFonts.length, example: blockedFonts[0] }), contentType: "application/json",
  });
});
