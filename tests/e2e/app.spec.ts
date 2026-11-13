import { expect, test, type Locator, type Page } from "@playwright/test";

const isMobile = () => test.info().project.name === "android-layout";

const editorOf = (page: Page) =>
  page.getByRole("textbox", { name: "Markdown-Editor" });

/** The ribbon is desktop-only; on phones settings live in the navbar menu. */
async function openSettings(page: Page) {
  if (isMobile()) {
    await page.getByRole("button", { name: "Menü", exact: true }).click();
    await page.getByRole("menuitem", { name: "Einstellungen" }).click();
  } else
    await page
      .getByRole("button", { name: "Einstellungen", exact: true })
      .click();
  await expect(
    page.getByRole("dialog", { name: "Einstellungen" }),
  ).toBeVisible();
}

async function createNote(page: Page, name: string) {
  await page.getByRole("button", { name: "Neue Notiz", exact: true }).click();
  await page.locator("#new-name").fill(name);
  await page
    .getByRole("button", { name: "Notiz anlegen", exact: true })
    .click();
  await expect(page.locator("#tab-name")).toHaveText(name.split("/").pop()!);
}

/** HTML drag of a panel tab; drop zones only appear once the drag is running. */
type DragTarget = Locator | { x: number; y: number };

/** Picks a tab up and holds it over `target`: an element or a viewport point. */
async function dragPanelOver(
  page: Page,
  source: Locator,
  target: DragTarget,
  position?: { x: number; y: number },
) {
  await source.hover();
  await page.mouse.down();
  const box = (await source.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, {
    steps: 4,
  });
  if ("x" in target) await page.mouse.move(target.x, target.y, { steps: 6 });
  else await target.hover({ position });
}

async function dragPanel(
  page: Page,
  source: Locator,
  target: DragTarget,
  position?: { x: number; y: number },
) {
  await dragPanelOver(page, source, target, position);
  await page.mouse.up();
}

/** A point on the editor region, given as fractions of its width and height. */
async function editorPoint(page: Page, fx: number, fy: number) {
  const box = (await page.locator(".workspace-split.mod-root").boundingBox())!;
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

async function quickOpen(page: Page, query: string) {
  await page
    .getByRole("button", { name: "Schnellauswahl öffnen", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Schnellauswahl" }).fill(query);
  await page.locator(".suggestion-item").first().click();
}

test("opens notes, switches to reading view, follows links and exposes honest plugin status", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(editorOf(page)).toContainText("Platz für deine Gedanken");
  await page.getByRole("button", { name: "Leseansicht", exact: true }).click();
  await expect(page.locator("#preview h1")).toHaveText(
    "Platz für deine Gedanken.",
  );
  await page.locator('#preview [data-note="Ideensammlung"]').first().click();
  await expect(page.locator("#tab-name")).toHaveText("Ideensammlung");
  await openSettings(page);
  await page.getByRole("tab", { name: "Community-Plugins" }).click();
  await expect(page.locator("#plugin-bundles")).toBeVisible();
  await expect(page.locator(".settings-note")).toContainText(
    "noch unvollständig",
  );
  await expect(page.locator("#compat-status")).toContainText(
    "nur in der nativen App",
  );
  expect(errors).toEqual([]);
});

test("shows page previews for internal links in editor and reading view", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const editorLink = editorOf(page)
    .locator(".cm-internal-link", { hasText: "Ideensammlung" })
    .first();
  await editorLink.hover();
  await expect(page.locator(".link-preview-title")).toHaveText("Ideensammlung");
  await expect(page.locator(".link-preview-body")).toContainText(
    "Nicht jede Idee muss sofort fertig sein.",
  );
  await page.mouse.move(2, 2);
  await expect(page.locator(".link-preview")).toHaveCount(0);

  await page.getByRole("button", { name: "Leseansicht", exact: true }).click();
  await page.locator('#preview [data-note="Ideensammlung"]').first().hover();
  await expect(page.locator(".link-preview-title")).toHaveText("Ideensammlung");
  await expect(page.locator(".link-preview")).toBeVisible();
  expect(errors).toEqual([]);
});

test("renders inline and block formulas in reading view", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await createNote(page, "Formelsammlung");
  await editorOf(page).fill(
    "Satz des Pythagoras: $a^2 + b^2 = c^2$.\n\n$$\\frac{1}{2} \\cdot 4 = 2$$\n\n`$inline code$` bleibt Code.",
  );
  await page.getByRole("button", { name: "Leseansicht", exact: true }).click();
  await expect(page.locator("#preview .katex").first()).toBeVisible();
  await expect(page.locator("#preview .katex-display")).toContainText("1");
  await expect(page.locator("#preview code", { hasText: "$inline code$" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("renders Mermaid diagrams without replacing the source on failure", async ({ page }) => {
  await page.goto("/");
  await createNote(page, "Netzplan");
  await editorOf(page).fill(
    "```mermaid\nflowchart LR\n  Client -->|HTTPS| Server\n```\n\n```mermaid\nnot a diagram\n```",
  );
  await page.getByRole("button", { name: "Leseansicht", exact: true }).click();
  await expect(page.locator("#preview .mermaid-diagram svg").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#preview .mermaid-error")).toContainText("not a diagram");
});

test("preserves diagram source when its lazy renderer cannot be downloaded", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let blocked = 0;
  await page.route("**/mermaid.js*", route => { blocked++; return route.abort(); });
  await page.goto("/");
  await createNote(page, "Offline-Netzplan");
  await editorOf(page).fill("```mermaid\nflowchart LR\n  Client --> Server\n```");
  await page.getByRole("button", { name: "Leseansicht", exact: true }).click();
  await expect(page.locator("#preview .mermaid-error")).toContainText("Client --> Server");
  expect(blocked).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("inserts a vault template with title and date", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("basalt-demo-v1", JSON.stringify({
      "Meine Notiz.md": "Anfang\n",
      "_templates/Seitenvorlage.md": "# {{title}}\nDatum: {{date:YYYY-MM-DD}}\n",
    }));
    localStorage.setItem('basalt-workspace:"basalt-demo-v1"', JSON.stringify({
      tabs: [{ path: "Meine Notiz.md", reading: false }],
      active: 0,
    }));
  });
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Meine Notiz");
  await editorOf(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("textbox", { name: "Befehlspalette" }).fill("Vorlage einfügen");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Vorlage einfügen" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Seitenvorlage.md" }).click();
  await expect(editorOf(page)).toContainText("Anfang");
  await expect(editorOf(page)).toContainText(/Meine Notiz\s*Datum: \d{4}-\d{2}-\d{2}/);
});

test("folds solution callouts and opens them on click", async ({ page }) => {
  await page.goto("/");
  await createNote(page, "Loesung");
  await editorOf(page).fill("> [!success]- Lösung\n> Versteckter Rechenweg");
  await page.getByRole("button", { name: "Leseansicht", exact: true }).click();
  const callout = page.locator("#preview .callout").first();
  await expect(callout).toHaveClass(/is-collapsed/);
  await expect(callout.locator(".callout-content")).toBeHidden();
  await callout.locator(".callout-title").click();
  await expect(callout).not.toHaveClass(/is-collapsed/);
  await expect(callout.locator(".callout-content")).toContainText("Versteckter Rechenweg");
});

test("toggles reading-view tasks from the keyboard", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Leseansicht", exact: true }).click();
  const boxes = page.locator("#preview .task-box");
  await expect(boxes.nth(1)).toHaveAttribute("aria-checked", "false");
  await boxes.nth(1).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#preview .task-box").nth(1)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.locator("#preview .task-box").nth(1).focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#preview .task-box").nth(1)).toHaveAttribute(
    "aria-checked",
    "false",
  );
});

test("opens binary attachments outside the text editor", async ({ page }) => {
  test.skip(isMobile(), "The explorer lives in the mobile drawer.");
  await page.addInitScript(() => localStorage.setItem("basalt-demo-v1", JSON.stringify({
    "Willkommen.md": "# Willkommen",
    "Handbuch.pdf": "%PDF-1.4",
  })));
  await page.goto("/");
  await page.getByRole("treeitem", { name: /Handbuch\.pdf/ }).click();
  await expect(page.locator("#tab-name")).toHaveText("Handbuch.pdf");
  await expect(page.locator(".attachment-host")).toBeVisible();
  await expect(page.locator(".attachment-host")).toContainText("nur in der nativen App");
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#preview")).toBeHidden();
});

test("creates, autosaves and restores a Markdown note", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await createNote(page, "Ein Testgedanke");
  const editor = editorOf(page);
  await editor.fill("# Ein Testgedanke\n\nLinux und Android gehören zusammen.");
  await expect(page.locator("#save-status")).toHaveAttribute(
    "aria-label",
    "Alle Änderungen gespeichert",
  );
  // The workspace comes back with the same note open.
  await page.reload();
  await expect(page.locator("#tab-name")).toHaveText("Ein Testgedanke");
  await expect(editor).toContainText("Linux und Android gehören zusammen.");
  await quickOpen(page, "Willk");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await quickOpen(page, "Testgedanke");
  await expect(editor).toContainText("Linux und Android gehören zusammen.");
});

test("confirms file deletion, backs up edits and does not restore deleted tabs", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await createNote(page, "Zum Löschen");
  await editorOf(page).fill("Letzter Entwurf");
  await page
    .getByRole("button", { name: "Weitere Optionen", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "In Papierkorb verschieben" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Datei löschen" });
  await expect(dialog).toContainText("Zum Löschen.md");
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map((a) => a.finished),
    );
  });
  await page.screenshot({
    path: `test-results/delete-confirm-${test.info().project.name}.png`,
  });
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(editorOf(page)).toContainText("Letzter Entwurf");
  await page
    .getByRole("button", { name: "Weitere Optionen", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "In Papierkorb verschieben" })
    .click();
  await dialog
    .getByRole("button", { name: "In Papierkorb verschieben", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(editorOf(page)).toBeHidden();
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("basalt-demo-v1")!),
  );
  expect(stored["Zum Löschen.md"]).toBeUndefined();
  expect(
    Object.entries(stored).filter(
      ([path]) =>
        path.startsWith(".basalt/trash/") && path.endsWith("/Zum Löschen.md"),
    ),
  ).toEqual([[expect.any(String), "Letzter Entwurf"]]);
  await page.reload();
  await expect(page.locator("#tab-name")).not.toHaveText("Zum Löschen");
  expect(errors).toEqual([]);
});

test("keeps a changed file when deletion conflicts with an external edit", async ({
  page,
}) => {
  await page.goto("/");
  await createNote(page, "Konflikt beim Löschen");
  await page.evaluate(() => {
    const files = JSON.parse(localStorage.getItem("basalt-demo-v1")!);
    files["Konflikt beim Löschen.md"] = "Extern geändert";
    localStorage.setItem("basalt-demo-v1", JSON.stringify(files));
  });
  await page
    .getByRole("button", { name: "Weitere Optionen", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "In Papierkorb verschieben" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Datei löschen" });
  await dialog
    .getByRole("button", { name: "In Papierkorb verschieben", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("außerhalb");
  await expect(page.locator("#tab-name")).toHaveText("Konflikt beim Löschen");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("basalt-demo-v1")!)[
          "Konflikt beim Löschen.md"
        ],
    ),
  ).toBe("Extern geändert");
});

test("uses one editor caret with the normal blink period", async ({ page }) => {
  await page.goto("/");
  await expect(editorOf(page)).toContainText("Platz für deine Gedanken");
  await editorOf(page).click();
  await expect(page.locator(".cm-cursorLayer")).toHaveCSS(
    "animation-duration",
    "1.2s",
  );
  await expect(editorOf(page)).toHaveCSS("caret-color", "rgba(0, 0, 0, 0)");
});

test("does not loop the cursor animation at high speed with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(editorOf(page)).toContainText("Platz für deine Gedanken");
  await editorOf(page).click();
  const cursor = page.locator(".cm-cursorLayer");
  await expect(cursor).toHaveCSS("animation-duration", "1e-05s");
  await expect(cursor).toHaveCSS("animation-iteration-count", "1");
  await expect(cursor).toHaveCSS("opacity", "1");
  await editorOf(page).press("ArrowRight");
  await expect(cursor).toHaveCSS("animation-iteration-count", "1");
  await expect(cursor).toHaveCSS("opacity", "1");
});

test("layout and reading view stay usable without horizontal overflow", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await page.getByRole("button", { name: "Leseansicht", exact: true }).click();
  await expect(page.locator("#preview h1")).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    window: innerWidth,
  }));
  expect(dimensions.page).toBeLessThanOrEqual(dimensions.window);
  await page.screenshot({
    path: `test-results/basalt-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("handles an empty vault without accepting unsaved phantom edits", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("basalt-demo-v1", "{}");
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Dein nächster Gedanke." }),
  ).toBeVisible();
  await expect(editorOf(page)).toBeHidden();
  await expect(page.locator("#save-status")).toHaveAttribute(
    "aria-label",
    "Leerer Vault · neue Notiz anlegen",
  );
  await page.getByRole("button", { name: "Erste Notiz anlegen" }).click();
  await page.locator("#new-name").fill("Der Anfang");
  await page
    .getByRole("button", { name: "Notiz anlegen", exact: true })
    .click();
  await expect(page.locator("#tab-name")).toHaveText("Der Anfang");
  await expect(editorOf(page)).toBeVisible();
});

test("rejects invalid note names inside the dialog", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await page.getByRole("button", { name: "Neue Notiz", exact: true }).click();
  await page.locator("#new-name").fill("../ausbruch");
  await page
    .getByRole("button", { name: "Notiz anlegen", exact: true })
    .click();
  await expect(page.locator("#new-error")).toBeVisible();
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
});

test("tolerates a fractional active-tab index in saved workspace data", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'basalt-workspace:"basalt-demo-v1"',
      JSON.stringify({
        tabs: [{ path: "Willkommen.md", reading: false }],
        active: 0.5,
      }),
    );
  });
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await expect(editorOf(page)).toContainText("Platz für deine Gedanken");
});

test("keeps local changes when another writer modifies the note", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await createNote(page, "Konflikt");
  const editor = editorOf(page);
  await editor.fill("Meine lokale Fassung");
  await page.evaluate(() => {
    const files = JSON.parse(localStorage.getItem("basalt-demo-v1")!);
    files["Konflikt.md"] = "Die externe Fassung";
    localStorage.setItem("basalt-demo-v1", JSON.stringify(files));
  });
  await expect(page.locator("#save-warning")).toBeVisible();
  await expect(editor).toContainText("Meine lokale Fassung");
  await page.getByRole("button", { name: "Dateistand laden" }).click();
  await expect(editor).toContainText("Die externe Fassung");
  await expect(page.locator("#save-warning")).toBeHidden();
  await openSettings(page);
  await page.getByRole("tab", { name: "Dateien und Links" }).click();
  await expect(page.locator("#recovery-list")).toContainText(
    "Archivierter Entwurf: Konflikt",
  );
});

test("mobile drawers open notes and close again", async ({ page }) => {
  test.skip(!isMobile(), "phone layout only");
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await expect(page.locator("#left-split")).not.toBeInViewport();
  await page
    .getByRole("button", { name: "Seitenleiste öffnen", exact: true })
    .click();
  const row = page.locator(".nav-file-title", { hasText: "Ideensammlung" });
  await expect(row).toBeInViewport();
  await row.click();
  await expect(page.locator("#tab-name")).toHaveText("Ideensammlung");
  await expect(page.locator("#left-split")).not.toBeInViewport();
});

test("phones show bottom-docked panels in the right drawer", async ({
  page,
}) => {
  test.skip(!isMobile(), "phone layout only");
  await page.addInitScript(() => {
    localStorage.setItem(
      "basalt-layout",
      JSON.stringify({
        dock: {
          left: { panels: ["files", "search", "bookmarks"], active: "files" },
          right: { panels: ["backlinks", "tags"], active: "backlinks" },
          bottom: { panels: ["outline", "outgoing"], active: "outline" },
        },
        bottomOpen: true,
      }),
    );
  });
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await expect(page.locator("#bottom-split")).toBeHidden();
  await page.getByRole("button", { name: "Menü", exact: true }).click();
  await page.getByRole("menuitem", { name: "Gliederung" }).click();
  const right = page.locator("#right-split");
  await expect(right).toBeInViewport();
  await expect(
    right.getByRole("tabpanel", { name: "Gliederung" }),
  ).toBeVisible();
  await expect(right.getByRole("tab")).toHaveCount(5);
});

test("phones fold lower-left views into the left drawer", async ({ page }) => {
  test.skip(!isMobile(), "phone layout only");
  await page.addInitScript(() => localStorage.setItem("basalt-layout", JSON.stringify({
    dock: {
      left: { panels: ["files", "search"], active: "files" },
      "left-bottom": { panels: ["bookmarks"], active: "bookmarks" },
    },
  })));
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await page.getByRole("button", { name: "Seitenleiste öffnen", exact: true }).click();
  await expect(page.locator("#left-bottom-split")).toBeHidden();
  await expect(page.getByRole("separator", { name: "Höhe links unten" })).toBeHidden();
  await page.locator("#left-split").getByRole("tab", { name: "Lesezeichen" }).click();
  await expect(page.locator("#left-split").getByRole("tabpanel", { name: "Lesezeichen" })).toBeVisible();
});

test("phones show one editor group of a split workspace at a time", async ({
  page,
}) => {
  test.skip(!isMobile(), "phone layout only");
  await page.addInitScript(() => {
    localStorage.setItem(
      'basalt-workspace:"basalt-demo-v1"',
      JSON.stringify({
        tabs: [{ path: "Ideensammlung.md", reading: false }],
        active: 0,
        groups: [
          { tabs: [{ path: "Willkommen.md", reading: false }], active: 0 },
          { tabs: [{ path: "Ideensammlung.md", reading: false }], active: 0 },
        ],
        split: {
          direction: "row",
          children: [{ group: 0 }, { group: 1 }],
          sizes: [1, 1],
        },
        group: 1,
      }),
    );
  });
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Ideensammlung");
  await expect(page.locator(".workspace-group")).toHaveCount(2);
  await expect(page.locator(".workspace-group:visible")).toHaveCount(1);
  // Every tab stays reachable through the tab list.
  await page.getByRole("button", { name: "Tabs", exact: true }).click();
  await page.getByRole("menuitem", { name: "Willkommen" }).click();
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await expect(page.locator(".workspace-group:visible")).toHaveCount(1);
});

test.describe("desktop workspace", () => {
  test.beforeEach(() => {
    test.skip(isMobile(), "desktop layout only");
  });

  test("docks views above the vault name and persists their resizable height", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#tab-name")).toHaveText("Willkommen");
    const lower = page.locator("#left-bottom-split");
    await expect(lower).toBeVisible();
    expect((await lower.boundingBox())!.height).toBeLessThan(80);
    await dragPanel(page, page.getByRole("tab", { name: "Lesezeichen" }), lower);
    await expect(lower.getByRole("tabpanel", { name: "Lesezeichen" })).toBeVisible();
    await expect(page.locator('#left-split > .workspace-split-inner > [data-dock-area="left"]').getByRole("tabpanel", { name: "Dateiexplorer" })).toBeVisible();
    const initial = (await lower.boundingBox())!;
    expect(initial.height).toBeCloseTo(180, 0);
    const separator = page.getByRole("separator", { name: "Höhe links unten" });
    const handle = (await separator.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y - 65, { steps: 5 });
    await page.mouse.up();
    expect((await lower.boundingBox())!.height).toBeGreaterThan(initial.height + 50);
    await separator.focus();
    await page.keyboard.press("ArrowUp");
    const resized = (await lower.boundingBox())!.height;
    await page.reload();
    await expect(lower.getByRole("tabpanel", { name: "Lesezeichen" })).toBeVisible();
    expect((await lower.boundingBox())!.height).toBeCloseTo(resized, 0);
    const vault = (await page.locator("#choose-vault").boundingBox())!;
    expect((await lower.boundingBox())!.y + resized).toBeLessThanOrEqual(vault.y);
    await page.setViewportSize({ width: 1440, height: 400 });
    await expect(page.locator("#choose-vault")).toBeInViewport();
    expect((await lower.boundingBox())!.height).toBeLessThanOrEqual(220);
    await page.screenshot({ path: "test-results/lower-left-dock.png" });
  });

  test("resizes the lower-left dock from its visible height after the viewport shrinks", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("basalt-layout", JSON.stringify({
      leftBottomHeight: 600,
      dock: { "left-bottom": { panels: ["bookmarks"], active: "bookmarks" } },
    })));
    await page.goto("/");
    const lower = page.locator("#left-bottom-split");
    await expect(lower.getByRole("tabpanel", { name: "Lesezeichen" })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 480 });
    const before = (await lower.boundingBox())!.height;
    const separator = page.getByRole("separator", { name: "Höhe links unten" });
    const handle = (await separator.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 45, { steps: 5 });
    await page.mouse.up();
    expect((await lower.boundingBox())!.height).toBeLessThan(before - 30);
  });

  test("reports the lower-left separator's effective range after viewport changes", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("basalt-layout", JSON.stringify({
      leftBottomHeight: 600,
      dock: { "left-bottom": { panels: ["bookmarks"], active: "bookmarks" } },
    })));
    await page.goto("/");
    const lower = page.locator("#left-bottom-split");
    const separator = page.getByRole("separator", { name: "Höhe links unten" });
    await expect(lower.getByRole("tabpanel", { name: "Lesezeichen" })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 400 });
    const before = Math.round((await lower.boundingBox())!.height);
    const max = Math.max(80, Math.round((await page.locator("#left-split").boundingBox())!.height - 180));
    await expect(separator).toHaveAttribute("aria-valuemin", "80");
    await expect(separator).toHaveAttribute("aria-valuemax", String(max));
    await expect(separator).toHaveAttribute("aria-valuenow", String(before));
    await separator.focus();
    await page.keyboard.press("ArrowDown");
    expect((await lower.boundingBox())!.height).toBeCloseTo(before - 10, 0);
    await expect(separator).toHaveAttribute("aria-valuenow", String(before - 10));
  });

  test("docks side panels anywhere by drag and drop and keeps the layout", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("#tab-name")).toHaveText("Willkommen");
    const left = page.locator("#left-split");
    const bottom = page.locator("#bottom-split");
    const explorerTab = page.getByRole("tab", { name: "Dateiexplorer" });

    // Dropping on the editor's lower border opens the closed bottom area.
    await expect(bottom).toHaveAttribute("inert");
    await dragPanel(page, explorerTab, await editorPoint(page, 0.5, 0.92));
    await expect(bottom).not.toHaveAttribute("inert");
    await expect(
      bottom.getByRole("tabpanel", { name: "Dateiexplorer" }),
    ).toBeVisible();
    await expect(
      bottom.locator(".nav-file-title", { hasText: "Ideensammlung" }),
    ).toBeVisible();
    await expect(left.getByRole("tab", { name: "Dateiexplorer" })).toHaveCount(
      0,
    );

    // The layout survives a reload.
    await page.reload();
    await expect(
      bottom.getByRole("tabpanel", { name: "Dateiexplorer" }),
    ).toBeVisible();

    // The context menu moves panels without dragging (keyboard and touch).
    await explorerTab.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "In rechte Seitenleiste verschieben" })
      .click();
    const right = page.locator("#right-split");
    await expect(right).toBeInViewport();
    await expect(
      right.getByRole("tabpanel", { name: "Dateiexplorer" }),
    ).toBeVisible();
    await expect(bottom.locator(".dock-empty")).toBeVisible();

    // Dropping on a tab strip inserts at that position.
    await dragPanel(
      page,
      page.getByRole("tab", { name: "Lesezeichen" }),
      right.getByRole("tab", { name: "Rückverweise" }),
      { x: 2, y: 10 },
    );
    expect(
      await right
        .getByRole("tab")
        .evaluateAll((tabs) =>
          tabs.map((tab) => tab.getAttribute("aria-label")),
        ),
    ).toEqual([
      "Lesezeichen",
      "Rückverweise",
      "Ausgehende Links",
      "Tags",
      "Gliederung",
      "Lokaler Graph",
      "Dateiexplorer",
    ]);
    await expect(left.getByRole("tab")).toHaveCount(1);

    // Backlinks render in whichever area they are docked.
    await right.getByRole("tab", { name: "Rückverweise" }).click({
      button: "right",
    });
    await page
      .getByRole("menuitem", { name: "In unteren Bereich verschieben" })
      .click();
    await expect(
      bottom.getByRole("tabpanel", { name: "Rückverweise" }),
    ).toContainText("Verlinkte Erwähnungen");

    await page.keyboard.press("ControlOrMeta+p");
    await page
      .getByRole("textbox", { name: "Befehlspalette" })
      .fill("Ansichten-Layout zurücksetzen");
    await page.keyboard.press("Enter");
    await expect(left.getByRole("tab")).toHaveCount(3);
    await expect(
      left.getByRole("tabpanel", { name: "Dateiexplorer" }),
    ).toBeVisible();
  });

  test("closes panels and reopens them where they were", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#tab-name")).toHaveText("Willkommen");
    const left = page.locator("#left-split");
    const addButton = left
      .locator('[data-dock-area="left"]')
      .getByRole("button", { name: "Geschlossene Ansicht öffnen" });
    await expect(addButton).toBeHidden();

    // The context menu closes the active panel; its neighbour takes over.
    await left.getByRole("tab", { name: "Suche" }).click();
    await left.getByRole("tab", { name: "Suche" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Ansicht schließen" }).click();
    await expect(left.getByRole("tab", { name: "Suche" })).toHaveCount(0);
    await expect(
      left.getByRole("tabpanel", { name: "Dateiexplorer" }),
    ).toBeVisible();

    // Middle click closes too, and closed panels survive a reload.
    await left.getByRole("tab", { name: "Lesezeichen" }).click({
      button: "middle",
    });
    await expect(left.getByRole("tab")).toHaveCount(1);
    await page.reload();
    await expect(left.getByRole("tab")).toHaveCount(1);

    // The "+" button lists closed panels and reopens one in its old place.
    await addButton.click();
    await page.getByRole("menuitem", { name: "Suche öffnen" }).click();
    expect(
      await left
        .getByRole("tab")
        .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label"))),
    ).toEqual(["Dateiexplorer", "Suche"]);
    await expect(left.getByRole("tabpanel", { name: "Suche" })).toBeVisible();

    // Its command brings a closed panel back as well.
    await page.keyboard.press("ControlOrMeta+p");
    await page
      .getByRole("textbox", { name: "Befehlspalette" })
      .fill("Lesezeichen anzeigen");
    await page.keyboard.press("Enter");
    await expect(left.getByRole("tab")).toHaveCount(3);
    await expect(addButton).toBeHidden();
  });

  test("previews the dock target under the pointer while dragging a panel", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("#tab-name")).toHaveText("Willkommen");
    const tab = page.getByRole("tab", { name: "Dateiexplorer" });
    const overlay = page.locator(".dock-drop-overlay");
    const line = page.locator(".tab-drop-indicator");
    const right = page.locator("#right-split");
    if ((await right.getAttribute("inert")) === null)
      await page.locator(".mod-root .sidebar-toggle-button.mod-right").click();
    await expect(right).toHaveAttribute("inert");

    // Closed areas are reached through the matching border of the editor;
    // the preview covers the strip the area is going to occupy.
    await dragPanelOver(page, tab, await editorPoint(page, 0.5, 0.92));
    await expect(overlay).toHaveClass(/is-visible/);
    await expect(overlay).toHaveAttribute("data-dock-area", "bottom");
    const editor = (await page
      .locator(".workspace-split.mod-root")
      .boundingBox())!;
    await expect
      .poll(async () => (await overlay.boundingBox())!.width)
      .toBeCloseTo(editor.width, 0);
    const preview = (await overlay.boundingBox())!;
    expect(preview.y + preview.height).toBeCloseTo(editor.y + editor.height, 0);
    expect(preview.height).toBeLessThan(editor.height / 2);

    const edge = await editorPoint(page, 0.95, 0.4);
    await page.mouse.move(edge.x, edge.y, { steps: 6 });
    await expect(overlay).toHaveAttribute("data-dock-area", "right");

    // The middle of the editor is no target, and an open area needs no border.
    const middle = await editorPoint(page, 0.5, 0.4);
    await page.mouse.move(middle.x, middle.y, { steps: 6 });
    await expect(overlay).not.toHaveClass(/is-visible/);
    const near = await editorPoint(page, 0.03, 0.4);
    await page.mouse.move(near.x, near.y, { steps: 6 });
    await expect(overlay).not.toHaveClass(/is-visible/);

    // An open area is previewed as a whole, its tab strip by an insertion line.
    const leftBox = (await page.locator("#left-split").boundingBox())!;
    await page.mouse.move(
      leftBox.x + leftBox.width / 2,
      leftBox.y + leftBox.height / 2,
      { steps: 6 },
    );
    await expect(overlay).toHaveAttribute("data-dock-area", "left");
    await expect(overlay).toHaveClass(/is-visible/);
    await expect(line).not.toHaveClass(/is-visible/);
    await page.getByRole("tab", { name: "Lesezeichen" }).hover();
    await expect(line).toHaveClass(/is-visible/);
    await expect(overlay).not.toHaveClass(/is-visible/);

    // Dropping outside every target leaves the layout alone.
    await page.mouse.move(middle.x, middle.y, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator("body")).not.toHaveClass(/is-dragging-panel/);
    await expect(line).not.toHaveClass(/is-visible/);
    await expect(page.locator("#left-split").getByRole("tab")).toHaveCount(3);

    await dragPanel(page, tab, edge);
    await expect(right).not.toHaveAttribute("inert");
    await expect(
      right.getByRole("tabpanel", { name: "Dateiexplorer" }),
    ).toBeVisible();
    await expect(overlay).not.toHaveClass(/is-visible/);
  });

  test("clears the panel drag overlay when the window loses focus", async ({
    page,
  }) => {
    await page.goto("/");
    const tab = page.getByRole("tab", { name: "Dateiexplorer" });
    const overlay = page.locator(".dock-drop-overlay");
    await dragPanelOver(page, tab, await editorPoint(page, 0.5, 0.92));
    await expect(page.locator("body")).toHaveClass(/is-dragging-panel/);
    await expect(overlay).toHaveClass(/is-visible/);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(page.locator("body")).not.toHaveClass(/is-dragging-panel/);
    await expect(overlay).not.toHaveClass(/is-visible/);
    await expect(tab).not.toHaveClass(/is-dragging/);
    await page.mouse.up();
  });

  test("reorders editor tabs by dragging and marks the insertion point", async ({
    page,
  }) => {
    await page.goto("/");
    const tabs = page.locator(".mod-root .workspace-tab-header");
    await page
      .locator(".nav-file-title", { hasText: "Ideensammlung" })
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(tabs).toHaveCount(2);
    const indicator = page.locator(".tab-drop-indicator");
    await expect(indicator).not.toHaveClass(/is-visible/);
    const dragTo = async (index: number, x: number, y: number) => {
      const tab = tabs.nth(index);
      await tab.hover();
      const from = (await tab.boundingBox())!;
      await page.mouse.down();
      await page.mouse.move(
        from.x + from.width / 2 + 12,
        from.y + from.height / 2,
        { steps: 4 },
      );
      await page.mouse.move(x, y, { steps: 6 });
      await page.mouse.up();
    };

    const source = tabs.nth(1);
    const first = (await tabs.nth(0).boundingBox())!;
    await source.hover();
    await page.mouse.down();
    const box = (await source.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, {
      steps: 4,
    });
    await page.mouse.move(first.x + 4, first.y + first.height / 2, {
      steps: 6,
    });
    await expect(indicator).toHaveClass(/is-visible/);
    await page.mouse.up();
    await expect(indicator).not.toHaveClass(/is-visible/);
    await expect(tabs.nth(0)).toContainText("Ideensammlung");

    // Move forward past the other tab, then drop on the source's own edge.
    const end = (await tabs.nth(1).boundingBox())!;
    await dragTo(0, end.x + end.width * 0.6, end.y + end.height / 2);
    await expect(tabs.nth(0)).toContainText("Willkommen");
    await expect(tabs.nth(1)).toContainText("Ideensammlung");
    await expect(indicator).not.toHaveClass(/is-visible/);
    const own = (await tabs.nth(1).boundingBox())!;
    await dragTo(1, own.x + own.width * 0.6, own.y + own.height / 2);
    await expect(tabs.nth(0)).toContainText("Willkommen");
    await expect(tabs.nth(1)).toContainText("Ideensammlung");
  });

  test("splits the editor by dragging a tab and edits in either group", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(page.locator("#tab-name")).toHaveText("Willkommen");
    await page
      .locator(".nav-file-title", { hasText: "Ideensammlung" })
      .click({ modifiers: ["ControlOrMeta"] });
    const groups = page.locator(".workspace-group");
    const overlay = page.locator(".dock-drop-overlay");
    const tab = (name: string) =>
      page.locator(".mod-root .workspace-tab-header", { hasText: name });
    await expect(groups).toHaveCount(1);

    // The outer third of a group previews the half the new group will take.
    await dragPanelOver(
      page,
      tab("Ideensammlung"),
      await editorPoint(page, 0.9, 0.5),
    );
    await expect(overlay).toHaveClass(/is-visible/);
    await expect(overlay).toHaveAttribute("data-drop-side", "right");
    // Dropping a tab on the middle of its own group would change nothing.
    const middle = await editorPoint(page, 0.5, 0.5);
    await page.mouse.move(middle.x, middle.y, { steps: 6 });
    await expect(overlay).not.toHaveClass(/is-visible/);
    const edge = await editorPoint(page, 0.9, 0.5);
    await page.mouse.move(edge.x, edge.y, { steps: 6 });
    await page.mouse.up();

    await expect(groups).toHaveCount(2);
    await expect(overlay).not.toHaveClass(/is-visible/);
    const left = groups.nth(0);
    const right = groups.nth(1);
    await expect(right).toHaveClass(/is-active/);
    await expect(page.locator("#tab-name")).toHaveText("Ideensammlung");
    await expect(left.getByRole("tab")).toHaveCount(1);
    await expect(right.getByRole("tab")).toHaveCount(1);
    // The window buttons stay in the upper right corner.
    await expect(
      right.getByRole("button", { name: "Rechte Seitenleiste umschalten" }),
    ).toBeVisible();

    // The other group mirrors its note; a click there continues editing.
    const mirror = left.locator(".workspace-leaf.mod-mirror");
    await expect(mirror).toContainText("Platz für deine Gedanken.");
    await mirror.locator(".cm-line", { hasText: "Manche Ideen" }).click();
    await expect(left).toHaveClass(/is-active/);
    await expect(page.locator("#tab-name")).toHaveText("Willkommen");
    await expect(left.locator("#editor .cm-content")).toBeFocused();
    await expect(right.locator(".workspace-leaf.mod-mirror")).toContainText(
      "Nicht jede Idee muss sofort fertig sein.",
    );
    await page.keyboard.type("Geteilt ");
    await expect(left.locator("#editor")).toContainText("Geteilt");

    // The same note in two groups stays in sync.
    await page.keyboard.press("ControlOrMeta+p");
    await page
      .getByRole("textbox", { name: "Befehlspalette" })
      .fill("Editor nach unten teilen");
    await page.keyboard.press("Enter");
    await expect(groups).toHaveCount(3);
    await expect(page.locator(".workspace-group-split.mod-column")).toHaveCount(
      1,
    );
    await page.keyboard.type("Synchron ");
    await expect(
      page.locator(".workspace-leaf.mod-mirror", { hasText: "Synchron" }),
    ).toHaveCount(1);

    // The split survives a reload.
    await expect(page.locator("#save-status")).toHaveAttribute(
      "data-state",
      "saved",
    );
    await page.reload();
    await expect(groups).toHaveCount(3);
    await expect(page.locator(".workspace-group-split.mod-column")).toHaveCount(
      1,
    );
    await expect(page.locator("#tab-name")).toHaveText("Willkommen");
    await expect(
      page.locator(".workspace-leaf.mod-mirror", { hasText: "Synchron" }),
    ).toHaveCount(1);

    // A group goes away with its last tab.
    await page.keyboard.press("ControlOrMeta+w");
    await expect(groups).toHaveCount(2);
    await expect(page.locator(".workspace-group-split.mod-column")).toHaveCount(
      0,
    );

    // Dropping a tab on another group's strip moves it there and merges back.
    await dragPanel(page, tab("Ideensammlung"), tab("Willkommen"), {
      x: 4,
      y: 10,
    });
    await expect(groups).toHaveCount(1);
    await expect(page.locator("#tab-name")).toHaveText("Ideensammlung");
    expect(
      await page
        .locator(".mod-root .workspace-tab-header")
        .evaluateAll((tabs) => tabs.map((el) => el.textContent)),
    ).toEqual(["Ideensammlung", "Willkommen"]);
    expect(errors).toEqual([]);
  });

  test("resizes editor groups and closes background tabs without stealing focus", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("#tab-name")).toHaveText("Willkommen");
    const groups = page.locator(".workspace-group");
    await page
      .locator(".mod-root .workspace-tab-header", { hasText: "Willkommen" })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Nach rechts teilen" }).click();
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(1)).toHaveClass(/is-active/);

    const sash = page.locator(".workspace-group-sash");
    const before = (await groups.nth(0).boundingBox())!;
    const grip = (await sash.boundingBox())!;
    await page.mouse.move(grip.x, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x - 150, grip.y + grip.height / 2, { steps: 5 });
    await page.mouse.up();
    const after = (await groups.nth(0).boundingBox())!;
    expect(after.width).toBeCloseTo(before.width - 150, -1);

    // A new tab from the strip of a background group lands in that group.
    await groups.nth(0).getByRole("button", { name: "Neuer Tab" }).click();
    await expect(groups.nth(0)).toHaveClass(/is-active/);
    await expect(groups.nth(0).getByRole("tab")).toHaveCount(2);
    await expect(page.locator("#tab-name")).toHaveText("Neuer Tab");

    // Closing a tab of the other group leaves the focus where it is.
    await groups.nth(1).getByRole("tab").hover();
    await groups.nth(1).getByRole("button", { name: "Tab schließen" }).click();
    await expect(groups).toHaveCount(1);
    await expect(page.locator("#tab-name")).toHaveText("Neuer Tab");
    await page.reload();
    await expect(groups).toHaveCount(1);
    await expect(page.locator(".mod-root .workspace-tab-header")).toHaveCount(
      2,
    );
  });

  test("moves files between folders in the explorer", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(page.locator("#tab-name")).toHaveText("Willkommen");
    await createNote(page, "Projekte/Plan");
    const tree = page.locator(".nav-files-container");
    const folder = tree.locator(".nav-folder-title", { hasText: "Projekte" });
    const file = (name: string) =>
      tree.locator(".nav-file-title", { hasText: name });
    const stored = () =>
      page.evaluate(() =>
        Object.keys(JSON.parse(localStorage.getItem("basalt-demo-v1")!))
          .filter((path) => !path.startsWith(".basalt/"))
          .sort(),
      );
    await file("Willkommen").click();
    await expect(page.locator("#tab-name")).toHaveText("Willkommen");
    await page.locator("#editor .cm-content").click();
    await page.keyboard.type("Vor dem Umzug ");

    // Dropping a file on a folder moves it there; the open tab follows.
    await dragPanelOver(page, file("Willkommen"), folder);
    await expect(tree.locator(".nav-folder.is-drop-target")).toHaveCount(1);
    await page.mouse.up();
    await expect(tree.locator(".is-drop-target")).toHaveCount(0);
    await expect(
      tree.locator(".nav-folder-children .nav-file-title", {
        hasText: "Willkommen",
      }),
    ).toBeVisible();
    expect(await stored()).toContain("Projekte/Willkommen.md");
    expect(await stored()).not.toContain("Willkommen.md");
    await expect(page.locator("#tab-name")).toHaveText("Willkommen");
    await expect(page.locator(".view-header-breadcrumb")).toHaveText(
      "Projekte/",
    );
    // Unsaved typing went along, and the note keeps saving to its new place.
    await page.locator("#editor .cm-content").click();
    await page.keyboard.type("Nach dem Umzug ");
    await expect(page.locator("#save-status")).toHaveAttribute(
      "data-state",
      "saved",
    );
    const text = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("basalt-demo-v1")!)[
          "Projekte/Willkommen.md"
        ] as string,
    );
    expect(text).toContain("Vor dem Umzug");
    expect(text).toContain("Nach dem Umzug");
    // Links by name still resolve.
    await page.reload();
    await expect(page.locator("#tab-name")).toHaveText("Willkommen");
    await expect(page.locator(".view-header-breadcrumb")).toHaveText(
      "Projekte/",
    );

    // The free space of the list is the vault root.
    const box = (await tree.boundingBox())!;
    await dragPanel(page, file("Plan"), {
      x: box.x + box.width / 2,
      y: box.y + box.height - 12,
    });
    await expect(file("Plan")).toBeVisible();
    expect(await stored()).toContain("Plan.md");

    // The context menu moves files without dragging.
    await file("Plan").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Verschieben nach …" }).click();
    await page.getByRole("menuitem", { name: "Projekte" }).click();
    await expect.poll(stored).toContain("Projekte/Plan.md");

    // A file of the same name at the destination is never overwritten.
    await createNote(page, "Plan");
    await file("Plan").last().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Verschieben nach …" }).click();
    await page.getByRole("menuitem", { name: "Projekte" }).click();
    await expect(page.locator(".notice")).toContainText("gibt es in");
    expect(await stored()).toEqual(
      expect.arrayContaining(["Plan.md", "Projekte/Plan.md"]),
    );
    expect(errors).toEqual([]);
  });

  test("renames files while keeping unsaved edits and their extension", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await createNote(page, "Projekte/Plan");
    await page.locator("#editor .cm-content").click();
    await page.keyboard.type("Noch nicht gespeichert ");
    const tree = page.locator(".nav-files-container");
    const file = (name: string) =>
      tree.locator(".nav-file-title", { hasText: name });
    const stored = () =>
      page.evaluate(() =>
        Object.entries(JSON.parse(localStorage.getItem("basalt-demo-v1")!))
          .filter(([path]) => !path.startsWith(".basalt/"))
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    await tree.locator(".nav-folder-title", { hasText: "Projekte" }).click();

    await file("Plan").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Umbenennen" }).click();
    await page.getByLabel("Neuer Dateiname").fill("Entwurf");
    await page.getByRole("button", { name: "Umbenennen" }).click();
    await expect(page.locator("#tab-name")).toHaveText("Entwurf");
    await expect(page.locator(".view-header-breadcrumb")).toHaveText("Projekte/");
    await expect.poll(stored).toContainEqual([
      "Projekte/Entwurf.md",
      expect.stringContaining("Noch nicht gespeichert"),
    ]);
    expect((await stored()).map(([path]) => path)).not.toContain("Projekte/Plan.md");

    // A name can never escape its folder.
    await file("Entwurf").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Umbenennen" }).click();
    await page.getByLabel("Neuer Dateiname").fill("../Ausbruch");
    await page.getByRole("button", { name: "Umbenennen" }).click();
    await expect(page.getByRole("alert")).toContainText("Ordnerpfade");
    expect((await stored()).map(([path]) => path)).toContain("Projekte/Entwurf.md");

    await page.getByRole("button", { name: "Abbrechen" }).click();
    await page.keyboard.press("F2");
    await expect(page.getByLabel("Neuer Dateiname")).toHaveValue("Entwurf.md");
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Neuer Dateiname")).toBeHidden();
    expect(errors).toEqual([]);
  });

  test("works with tabs, history and the file tree", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#tab-name")).toHaveText("Willkommen");
    const tabs = page.locator(".mod-root .workspace-tab-header");
    await expect(tabs).toHaveCount(1);

    // Ctrl-click opens a second tab; a plain click reuses the active one.
    await page
      .locator(".nav-file-title", { hasText: "Ideensammlung" })
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(tabs).toHaveCount(2);
    await expect(page.locator("#tab-name")).toHaveText("Ideensammlung");
    await page.locator(".nav-file-title", { hasText: "Plugins" }).click();
    await expect(tabs).toHaveCount(2);
    await expect(page.locator("#tab-name")).toHaveText("Plugins");

    await page.getByRole("button", { name: "Zurück", exact: true }).click();
    await expect(page.locator("#tab-name")).toHaveText("Ideensammlung");
    await page.getByRole("button", { name: "Vorwärts", exact: true }).click();
    await expect(page.locator("#tab-name")).toHaveText("Plugins");

    // A note that is already open is focused instead of duplicated.
    await page.locator(".nav-file-title", { hasText: "Willkommen" }).click();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.first()).toHaveClass(/is-active/);

    await tabs.nth(1).getByRole("button", { name: "Tab schließen" }).click();
    await expect(tabs).toHaveCount(1);
    await tabs.first().getByRole("button", { name: "Tab schließen" }).click();
    await expect(tabs).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Keine Datei geöffnet" }),
    ).toBeVisible();

    // Notes in folders show up as a collapsible tree.
    await createNote(page, "Projekte/Basalt/Roadmap");
    const folder = page.locator(".nav-folder-title", { hasText: "Projekte" });
    await expect(folder).toBeVisible();
    await expect(page.locator(".view-header-breadcrumb")).toHaveText(
      "Projekte/Basalt/",
    );
    await folder.click();
    await page.locator(".nav-folder-title", { hasText: "Basalt" }).click();
    await expect(
      page.locator(".nav-file-title", { hasText: "Roadmap" }),
    ).toHaveClass(/is-active/);
  });

  test("live preview hides Markdown syntax away from the cursor", async ({
    page,
  }) => {
    await page.goto("/");
    const heading = page.locator(".cm-line.HyperMD-header-1");
    await expect(heading).toHaveText("Platz für deine Gedanken.");
    await heading.click();
    await expect(heading).toHaveText("# Platz für deine Gedanken.");
    // A rendered wikilink navigates on a plain click.
    await page.locator(".cm-internal-link", { hasText: "Tagebuch" }).click();
    await expect(page.locator("#tab-name")).toHaveText("Tagesnotiz");
    // Checkboxes toggle the underlying Markdown.
    await page.getByRole("button", { name: "Zurück", exact: true }).click();
    await expect(page.locator("#tab-name")).toHaveText("Willkommen");
    const box = page.locator(".task-list-item-checkbox").nth(1);
    await expect(box).not.toBeChecked();
    await box.click();
    await expect(page.locator(".task-list-item-checkbox").nth(1)).toBeChecked();
    await expect(page.locator("#save-status")).toHaveAttribute(
      "aria-label",
      "Alle Änderungen gespeichert",
    );
    const stored = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("basalt-demo-v1")!)["Willkommen.md"],
    );
    expect(stored).toContain("- [x] Die erste eigene Notiz anlegen");
  });

  test("searches the vault and shows backlinks, outline and commands", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("#tab-name")).toHaveText("Willkommen");
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await page
      .getByRole("searchbox", { name: "Im Vault suchen" })
      .fill("Fremdkörper");
    const match = page.locator(".search-result-file-match").first();
    await expect(match).toContainText("Fremdkörper");
    await page
      .getByRole("searchbox", { name: "Im Vault suchen" })
      .press("ArrowDown");
    await expect(
      page.locator(".search-result-file-title").first(),
    ).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(match).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#tab-name")).toHaveText("Ideensammlung");

    await page.keyboard.press("ControlOrMeta+Shift+f");
    await page
      .getByRole("searchbox", { name: "Im Vault suchen" })
      .fill("Fremdkörper -Ideensammlung");
    await expect(page.locator(".search-results-info")).toHaveText(
      "Keine Treffer gefunden.",
    );

    const tabs = page.locator(".mod-root .workspace-tab-header");
    const tabsBefore = await tabs.count();
    await page
      .getByRole("searchbox", { name: "Im Vault suchen" })
      .fill("Fremdkörper");
    await expect(
      page.locator(".search-result-file-match").first(),
    ).toContainText("Fremdkörper");
    await page
      .getByRole("searchbox", { name: "Im Vault suchen" })
      .press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(
      page.locator(".search-result-file-match").first(),
    ).toBeFocused();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(tabs).toHaveCount(tabsBefore + 1);
    await expect(page.locator("#tab-name")).toHaveText("Ideensammlung");

    await page.keyboard.press("ControlOrMeta+p");
    await page
      .getByRole("textbox", { name: "Befehlspalette" })
      .fill("Rückverweise");
    await page.keyboard.press("Enter");
    const backlinks = page.getByRole("tabpanel", { name: "Rückverweise" });
    await expect(backlinks).toContainText("Verlinkte Erwähnungen");
    await expect(backlinks.locator(".pane-file-row")).toContainText([
      "Tagesnotiz",
      "Willkommen",
    ]);

    await page.getByRole("tab", { name: "Gliederung" }).click();
    const outline = page.getByRole("tabpanel", { name: "Gliederung" });
    await expect(outline.locator(".outline-item")).toHaveText([
      "Ideensammlung",
      "Als Nächstes",
    ]);

    // Settings persist and apply immediately.
    await openSettings(page);
    await page.getByRole("tab", { name: "Darstellung" }).click();
    await page.getByLabel("Grundfarbschema").selectOption("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});

/** Raw `.canvas` text the browser demo stored for `path`. */
const storedCanvas = (page: Page, path = "Ideenboard.canvas") =>
  page.evaluate(
    (path) =>
      JSON.parse(localStorage.getItem("basalt-demo-v1") ?? "{}")[path] as
        string | undefined,
    path,
  );

test("edits a JSON canvas and keeps it after a reload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await quickOpen(page, "Ideenboard");
  await expect(page.locator("#tab-name")).toHaveText("Ideenboard");
  const board = page.getByRole("application", { name: "Canvas-Fläche" });
  await expect(board).toBeVisible();
  await expect(board.locator(".canvas-node")).toHaveCount(4);
  await expect(board.locator(".canvas-edge")).toHaveCount(2);
  await expect(
    page.getByRole("textbox", { name: "Markdown-Editor" }),
  ).toBeHidden();

  await page
    .getByRole("button", { name: "Karte hinzufügen", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "Kartentext" });
  await expect(editor).toBeFocused();
  await editor.fill("Neue **Idee** mit [[Plugins]]");
  await editor.press("Escape");
  await expect(board.locator(".canvas-node")).toHaveCount(5);
  await expect(
    board.locator(".canvas-node strong", { hasText: "Idee" }),
  ).toBeVisible();
  await expect
    .poll(async () => (await storedCanvas(page)) ?? "")
    .toContain("Neue **Idee** mit [[Plugins]]");

  // A canvas linking a note counts as a backlink for it.
  await page.reload();
  await quickOpen(page, "Ideenboard");
  await expect(board.locator(".canvas-node")).toHaveCount(5);
  await board.locator(".internal-link", { hasText: "Plugins" }).click();
  await expect(page.locator("#tab-name")).toHaveText("Plugins");
  expect(errors).toEqual([]);
});

test.describe("desktop canvas", () => {
  test.beforeEach(() => {
    test.skip(isMobile(), "desktop layout only");
  });

  test("shows a canvas and a note side by side, also after a reload", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(page.locator("#tab-name")).toHaveText("Willkommen");
    await page.keyboard.press("ControlOrMeta+p");
    await page
      .getByRole("textbox", { name: "Befehlspalette" })
      .fill("Editor nach rechts teilen");
    await page.keyboard.press("Enter");
    const groups = page.locator(".workspace-group");
    await expect(groups).toHaveCount(2);
    await page.locator(".nav-file-title", { hasText: "Ideenboard" }).click();
    await expect(page.locator("#tab-name")).toHaveText("Ideenboard");
    const left = groups.nth(0);
    const right = groups.nth(1);
    const card = "Willkommen auf der Canvas";
    await expect(right.locator("#canvas-view")).toContainText(card);
    // The unfocused group keeps showing its note.
    await expect(left.locator(".mod-mirror")).toContainText(
      "Platz für deine Gedanken.",
    );

    // Focusing the note leaves the canvas visible, read-only.
    await left.locator(".mod-mirror .cm-line", { hasText: "Manche Ideen" }).click();
    await expect(left).toHaveClass(/is-active/);
    const mirrored = right.locator(".mod-mirror .canvas-wrapper");
    await expect(mirrored).toBeVisible();
    await expect(mirrored).toContainText(card);
    await expect(mirrored).toHaveClass(/is-readonly/);
    await expect(right.locator(".group-placeholder")).toBeHidden();

    // Both groups load their file after a reload.
    await page.reload();
    await expect(groups).toHaveCount(2);
    await expect(left).toHaveClass(/is-active/);
    await expect(left.locator("#editor")).toContainText(
      "Platz für deine Gedanken.",
    );
    await expect(mirrored).toContainText(card);

    // Edits on the live canvas reach a mirror of the same file.
    await right.locator(".mod-mirror").click();
    await expect(right).toHaveClass(/is-active/);
    await expect(left.locator(".mod-mirror")).toContainText(
      "Platz für deine Gedanken.",
    );
    await page.locator(".mod-root .workspace-tab-header", { hasText: "Willkommen" }).click();
    await expect(left).toHaveClass(/is-active/);
    await page.locator(".nav-file-title", { hasText: "Ideenboard" }).click();
    await expect(left.locator("#canvas-view")).toContainText(card);
    await expect(mirrored).toContainText(card);
    const board = left.getByRole("application", { name: "Canvas-Fläche" });
    const box = (await board.boundingBox())!;
    await page.mouse.dblclick(box.x + 40, box.y + 40);
    await page.getByRole("textbox", { name: "Kartentext" }).fill("Gespiegelt");
    await page.keyboard.press("Escape");
    await expect(mirrored).toContainText("Gespiegelt");
    expect(errors).toEqual([]);
  });

  test("creates, moves, connects and deletes cards with the mouse", async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Neue Canvas", exact: true })
      .click();
    await expect(page.locator("#tab-name")).toHaveText("Unbenannt");
    await expect(
      page.locator(".nav-file-title", { hasText: "Unbenannt" }),
    ).toBeVisible();
    const board = page.getByRole("application", { name: "Canvas-Fläche" });
    const box = (await board.boundingBox())!;

    // Double-clicking empty space adds a card and starts editing it.
    await page.mouse.dblclick(box.x + 300, box.y + 300);
    await page.getByRole("textbox", { name: "Kartentext" }).fill("Erste");
    await page.mouse.dblclick(box.x + 800, box.y + 300);
    await page.getByRole("textbox", { name: "Kartentext" }).fill("Zweite");
    await page.keyboard.press("Escape");
    const cards = board.locator(".canvas-node");
    await expect(cards).toHaveCount(2);

    // Drag the first card down.
    const first = cards.filter({ hasText: "Erste" });
    const before = (await first.boundingBox())!;
    await page.mouse.move(before.x + 20, before.y + 20);
    await page.mouse.down();
    await page.mouse.move(before.x + 20, before.y + 140, { steps: 5 });
    await page.mouse.up();
    const after = (await first.boundingBox())!;
    expect(after.y - before.y).toBeGreaterThan(100);

    // Drag from the right handle of the first card onto the second.
    await first.click();
    const handle = (await first
      .locator(".canvas-connect-handle.mod-right")
      .boundingBox())!;
    const second = (await cards.filter({ hasText: "Zweite" }).boundingBox())!;
    await page.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(second.x + 40, second.y + second.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await expect(board.locator(".canvas-edge")).toHaveCount(1);

    await expect
      .poll(async () => {
        const text = (await storedCanvas(page, "Unbenannt.canvas")) ?? "{}";
        const data = JSON.parse(text);
        return [data.nodes?.length, data.edges?.length];
      })
      .toEqual([2, 1]);

    // Deleting a card removes its connections; undo brings both back.
    await first.click();
    await page.keyboard.press("Delete");
    await expect(cards).toHaveCount(1);
    await expect(board.locator(".canvas-edge")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(cards).toHaveCount(2);
    await expect(board.locator(".canvas-edge")).toHaveCount(1);
  });

  test("zooms with Ctrl and the mouse wheel", async ({ page }) => {
    await page.goto("/");
    await page.locator(".nav-file-title", { hasText: "Ideenboard" }).click();
    const wrapper = page.locator("#canvas-view");
    const zoom = Number(await wrapper.getAttribute("data-zoom"));
    const box = (await page
      .getByRole("application", { name: "Canvas-Fläche" })
      .boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -400);
    await page.keyboard.up("Control");
    await expect
      .poll(async () => Number(await wrapper.getAttribute("data-zoom")))
      .toBeGreaterThan(zoom);
  });
});

test("canvas responds to touch: double tap, one-finger pan and pinch", async ({
  page,
}) => {
  test.skip(!isMobile(), "touch layout only");
  await page.goto("/");
  await quickOpen(page, "Ideenboard");
  const board = page.getByRole("application", { name: "Canvas-Fläche" });
  const wrapper = page.locator("#canvas-view");
  const box = (await board.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height - 160;
  const cdp = await page.context().newCDPSession(page);
  const touch = (
    type: "touchStart" | "touchMove" | "touchEnd",
    points: Array<[number, number]>,
  ) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map(([px, py], id) => ({ x: px, y: py, id })),
    });

  // Pinch out: two fingers moving apart zoom in.
  const zoom = Number(await wrapper.getAttribute("data-zoom"));
  await touch("touchStart", [
    [x - 40, y],
    [x + 40, y],
  ]);
  for (let step = 1; step <= 5; step++)
    await touch("touchMove", [
      [x - 40 - step * 20, y],
      [x + 40 + step * 20, y],
    ]);
  await touch("touchEnd", []);
  await expect
    .poll(async () => Number(await wrapper.getAttribute("data-zoom")))
    .toBeGreaterThan(zoom * 1.5);

  // One finger on empty space pans the board instead of scrolling the page.
  const group = board.locator(".canvas-node-group");
  const before = (await group.boundingBox())!;
  await touch("touchStart", [[x, y]]);
  for (let step = 1; step <= 5; step++)
    await touch("touchMove", [[x, y - step * 20]]);
  await touch("touchEnd", []);
  const after = (await group.boundingBox())!;
  expect(before.y - after.y).toBeGreaterThan(60);

  // Double tap on empty space creates a card.
  const cards = board.locator(".canvas-node");
  const count = await cards.count();
  await page.touchscreen.tap(x, y);
  await page.touchscreen.tap(x, y);
  await expect(cards).toHaveCount(count + 1);
  await expect(page.getByRole("textbox", { name: "Kartentext" })).toBeFocused();
});
test("graph view shows linked notes and opens them", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  if (isMobile()) {
    await page.getByRole("button", { name: "Menü", exact: true }).click();
    await page.getByRole("menuitem", { name: "Graphansicht öffnen" }).click();
  } else
    await page
      .getByRole("button", { name: "Graphansicht öffnen", exact: true })
      .click();
  const dialog = page.getByRole("dialog", { name: "Graphansicht" });
  await expect(dialog).toBeVisible();
  const graph = dialog.getByRole("group", { name: "Graph aller Notizen" });
  await expect(graph.locator(".graph-node")).toHaveCount(4);
  await expect(graph.locator(".graph-edge")).toHaveCount(5);
  await expect(dialog.locator(".graph-node.is-active")).toHaveAttribute(
    "aria-label",
    "Willkommen",
  );

  // The filter keeps matching notes and their direct neighbours.
  await dialog.getByRole("searchbox", { name: "Graph filtern" }).fill("plug");
  await expect(graph.locator(".graph-node")).toHaveCount(3);
  await dialog.getByRole("searchbox", { name: "Graph filtern" }).fill("");
  await expect(graph.locator(".graph-node")).toHaveCount(4);

  // The graph stays inside the screen.
  const box = (await dialog.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);

  await graph
    .getByRole("button", { name: "Ideensammlung", exact: true })
    .locator("circle")
    .click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#tab-name")).toHaveText("Ideensammlung");

  // The local graph follows the active note and works by keyboard.
  if (isMobile()) {
    await page.getByRole("button", { name: "Menü", exact: true }).click();
    await page.getByRole("menuitem", { name: "Lokaler Graph" }).click();
  } else {
    await page.keyboard.press("ControlOrMeta+p");
    await page
      .getByRole("textbox", { name: "Befehlspalette" })
      .fill("Lokalen Graph");
    await page.keyboard.press("Enter");
  }
  const local = page
    .getByRole("tabpanel", { name: "Lokaler Graph" })
    .getByRole("group", { name: "Lokaler Graph" });
  await expect(local.locator(".graph-node.is-active")).toHaveAttribute(
    "aria-label",
    "Ideensammlung",
  );
  await expect(local.locator(".graph-node")).toHaveCount(4);
  await local.getByRole("button", { name: "Plugins", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#tab-name")).toHaveText("Plugins");
  expect(errors).toEqual([]);
});
