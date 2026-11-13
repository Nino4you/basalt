import { expect, test, type Page } from "@playwright/test";

async function openGraph(page: Page) {
  if (test.info().project.name === "android-layout") {
    await page.getByRole("button", { name: "Menü", exact: true }).click();
    await page.getByRole("menuitem", { name: "Graphansicht öffnen" }).click();
  } else {
    await page
      .getByRole("button", { name: "Graphansicht öffnen", exact: true })
      .click();
  }
  return page.getByRole("dialog", { name: "Graphansicht" });
}

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      errors.push(message.text());
  });
  return errors;
}

test("graph settings keep filters and group colors accessible and persistent", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const dialog = await openGraph(page);
  const graph = dialog.getByRole("group", { name: "Graph aller Notizen" });
  await expect(graph.locator(".graph-node")).toHaveCount(4);
  const filter = dialog.getByRole("searchbox", { name: "Graph filtern" });
  await expect(filter).toBeVisible();
  await filter.fill("plug");
  await expect(graph.locator(".graph-node")).toHaveCount(3);
  await filter.fill("kein treffer");
  await expect(dialog.locator(".graph-empty")).toBeVisible();
  await filter.fill("");
  await expect(graph.locator(".graph-node")).toHaveCount(4);
  await expect(dialog.locator(".graph-view")).not.toHaveClass(
    /graph-color-groups/,
  );

  await dialog.locator("summary", { hasText: "Darstellung" }).click();
  const colors = dialog.getByRole("checkbox", { name: "Gruppen einfärben" });
  await colors.check();
  await expect(dialog.locator(".graph-view")).toHaveClass(/graph-color-groups/);
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  await openGraph(page);
  await expect(dialog.locator(".graph-view")).toHaveClass(/graph-color-groups/);
  await dialog.locator("summary", { hasText: "Darstellung" }).click();
  await expect(colors).toBeChecked();
  await colors.uncheck();
  await dialog.locator("summary", { hasText: "Darstellung" }).click();

  // The overlay leaves the graph controls reachable even on a narrow phone.
  const settings = dialog.getByLabel("Graph-Einstellungen", { exact: true });
  await settings.click();
  await expect(filter).toBeHidden();
  await settings.focus();
  await page.keyboard.press("Enter");
  await expect(filter).toBeVisible();
  const viewport = page.viewportSize()!;
  for (const element of [
    dialog,
    settings,
    dialog.getByRole("button", { name: "Ansicht einpassen" }),
  ]) {
    const box = (await element.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  }
  await page.screenshot({
    path: `test-results/graph-reference/basalt-graph-settings-${test.info().project.name}.png`,
  });
  await graph
    .getByRole("button", { name: "Ideensammlung", exact: true })
    .locator("circle")
    .click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#tab-name")).toHaveText("Ideensammlung");
  expect(errors).toEqual([]);
});

test("graph uses neutral nodes, highlights neighbours and supports keyboard camera controls", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Only this isolated browser context's demo data is seeded, never a real vault.
  await page.addInitScript(() => {
    const files: Record<string, string> = {
      "Willkommen.md":
        "# Wissensnetz\n[[Projekte]] [[Lernen]] [[Schreiben]] [[Werkzeuge]]",
      "Projekte.md":
        "[[Planung]] [[Zusammenarbeit]] [[Entscheidungen]] [[Willkommen]] #arbeit",
      "Lernen.md":
        "[[Leseliste]] [[Notizen]] [[Karteikarten]] [[Willkommen]] #wissen",
      "Schreiben.md":
        "[[Ideen]] [[Entwürfe]] [[Veröffentlichen]] [[Willkommen]]",
      "Werkzeuge.md": "[[Markdown]] [[Linux]] [[Android]] [[Willkommen]]",
      "Planung.md": "[[Entscheidungen]]",
      "Zusammenarbeit.md": "[[Planung]]",
      "Entscheidungen.md": "[[Notizen]]",
      "Leseliste.md": "[[Notizen]]",
      "Notizen.md": "[[Ideen]]",
      "Karteikarten.md": "[[Notizen]]",
      "Ideen.md": "[[Entwürfe]]",
      "Entwürfe.md": "[[Veröffentlichen]]",
      "Veröffentlichen.md": "[[Noch offen]]",
      "Markdown.md": "[[Notizen]]",
      "Linux.md": "[[Android]]",
      "Android.md": "[[Markdown]]",
      "Ein neuer Gedanke.md": "Noch ohne Verbindungen.",
    };
    localStorage.setItem("basalt-demo-v1", JSON.stringify(files));
  });
  await page.goto("/");
  const dialog = await openGraph(page);
  const graph = dialog.getByRole("group", { name: "Graph aller Notizen" });
  await expect(graph.locator(".graph-node")).toHaveCount(18);
  await dialog.getByLabel("Graph-Einstellungen", { exact: true }).click();
  const viewport = graph.locator(".graph-viewport");
  await graph.focus();
  const original = await viewport.getAttribute("transform");
  await page.keyboard.press("ArrowRight");
  await expect(viewport).not.toHaveAttribute("transform", original!);
  const panned = await viewport.getAttribute("transform");
  await page.keyboard.press("+");
  await expect(viewport).not.toHaveAttribute("transform", panned!);
  await dialog.getByRole("button", { name: "Ansicht einpassen" }).click();

  const hub = graph.getByRole("button", { name: "Projekte", exact: true });
  const neutral = graph.getByRole("button", { name: "Lernen", exact: true });
  await expect(neutral.locator("circle")).not.toHaveCSS(
    "fill",
    await graph
      .getByRole("button", { name: "Willkommen", exact: true })
      .locator("circle")
      .evaluate((el) => getComputedStyle(el).fill),
  );
  await hub.focus();
  await expect(hub).toHaveClass(/is-focused/);
  await expect(graph.locator(".graph-edge.is-highlighted")).toHaveCount(4);
  await expect(neutral).not.toHaveClass(/is-highlighted/);
  await expect(hub.locator("circle")).toHaveCSS(
    "fill",
    await graph
      .getByRole("button", { name: "Willkommen", exact: true })
      .locator("circle")
      .evaluate((el) => getComputedStyle(el).fill),
  );
  await page.screenshot({
    path: `test-results/graph-reference/basalt-graph-focus-${test.info().project.name}.png`,
  });
  await graph.focus();
  await page.screenshot({
    path: `test-results/graph-reference/basalt-graph-overview-${test.info().project.name}.png`,
  });

  await hub.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#tab-name")).toHaveText("Projekte");
  expect(errors).toEqual([]);
});

test("graph retains pointer dragging, wheel zoom and mobile pinch navigation", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const dialog = await openGraph(page);
  await dialog.getByLabel("Graph-Einstellungen", { exact: true }).click();
  const graph = dialog.getByRole("group", { name: "Graph aller Notizen" });
  const viewport = graph.locator(".graph-viewport");
  const box = (await graph.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height - 100;
  const before = await viewport.getAttribute("transform");
  const scale = async () =>
    Number(
      (await viewport.getAttribute("transform"))!.match(
        /scale\(([\d.]+)\)/,
      )![1],
    );

  if (test.info().project.name === "android-layout") {
    const cdp = await page.context().newCDPSession(page);
    const touch = (
      type: "touchStart" | "touchMove" | "touchEnd",
      points: Array<[number, number]>,
    ) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: points.map(([px, py], id) => ({ x: px, y: py, id })),
      });
    await touch("touchStart", [[x, y]]);
    await touch("touchMove", [[x + 40, y - 40]]);
    await touch("touchEnd", []);
    await expect(viewport).not.toHaveAttribute("transform", before!);
    const zoom = await scale();
    await touch("touchStart", [
      [x - 30, y],
      [x + 30, y],
    ]);
    await touch("touchMove", [
      [x - 65, y],
      [x + 65, y],
    ]);
    await touch("touchEnd", []);
    await expect.poll(scale).toBeGreaterThan(zoom * 1.5);
    await cdp.detach();
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y - 40, { steps: 5 });
    await page.mouse.up();
    await expect(viewport).not.toHaveAttribute("transform", before!);
    const zoom = await scale();
    await page.mouse.wheel(0, -200);
    await expect.poll(scale).toBeGreaterThan(zoom);
    await dialog.getByRole("button", { name: "Ansicht einpassen" }).click();
    const node = graph.getByRole("button", { name: "Willkommen", exact: true });
    await node.locator("circle").hover();
    const position = (await node.locator("circle").boundingBox())!;
    const original = await node.getAttribute("transform");
    await page.mouse.down();
    await page.mouse.move(position.x + 70, position.y + 50, { steps: 5 });
    await expect(node).not.toHaveAttribute("transform", original!);
    await page.mouse.up();
  }
  await expect(dialog).toBeVisible();
  expect(errors).toEqual([]);
});

test("local graph fits a small dock before and after resizing, with settings collapsed", async ({
  page,
}) => {
  test.skip(
    test.info().project.name !== "desktop",
    "Desktop dock resize regression",
  );
  const errors = watchConsole(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() =>
    localStorage.setItem(
      "basalt-layout",
      JSON.stringify({
        leftBottomHeight: 180,
        dock: { "left-bottom": { panels: ["graph"], active: "graph" } },
      }),
    ),
  );
  await page.goto("/");
  const pane = page.getByRole("tabpanel", { name: "Lokaler Graph" });
  const graph = pane.getByRole("group", { name: "Lokaler Graph" });
  await expect(graph.locator(".graph-node")).toHaveCount(4);
  const checkBounds = async () => {
    // Measure in one frame: the dock animates while its height changes.
    const { box, children } = await pane.evaluate((el) => ({
      box: el.getBoundingClientRect().toJSON(),
      children: [
        ...el.querySelectorAll(".graph-view, .graph-canvas, .graph-controls"),
      ].map((child) => child.getBoundingClientRect().toJSON()),
    }));
    for (const child of children) {
      expect(child.height).toBeGreaterThan(0);
      expect(child.y).toBeGreaterThanOrEqual(box.y);
      expect(child.y + child.height).toBeLessThanOrEqual(
        box.y + box.height + 1,
      );
    }
  };
  await checkBounds();
  const depth = pane.getByRole("slider", { name: "Tiefe", exact: true });
  await expect(depth).toBeHidden();
  const settings = pane.getByLabel("Graph-Einstellungen", { exact: true });
  await settings.focus();
  await page.keyboard.press("Enter");
  await expect(depth).toBeVisible();
  await pane.getByRole("checkbox", { name: "Ganzer Vault" }).check();
  await expect(depth).toBeHidden();
  await pane.getByRole("checkbox", { name: "Ganzer Vault" }).uncheck();
  await expect(depth).toBeVisible();
  await checkBounds();
  await settings.click();
  const separator = page.getByRole("separator", { name: "Höhe links unten" });
  await separator.focus();
  await page.keyboard.press("ArrowUp");
  await checkBounds();
  await page.keyboard.press("ArrowDown");
  await checkBounds();

  await graph.getByRole("button", { name: "Plugins", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#tab-name")).toHaveText("Plugins");
  expect(errors).toEqual([]);
});
