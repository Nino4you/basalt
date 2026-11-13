import { describe, expect, it } from "vitest";
import {
  buildGraph,
  defaultGraphOptions,
  ForceLayout,
  nodeRadius,
  type GraphOptions,
} from "../../src/app/graph-model";
import { GraphView, LocalGraph } from "../../src/app/graph";
import type { App } from "../../src/app/app";
import { VaultIndex } from "../../src/app/vault-index";
import { generateVault } from "../helpers/generated-vault";

function vault(files: Record<string, string>): VaultIndex {
  const index = new VaultIndex();
  index.setFiles(Object.keys(files).sort());
  for (const [path, text] of Object.entries(files))
    index.setContent(path, text);
  return index;
}

const sample = () =>
  vault({
    "A.md": "[[B]] [[B|nochmal]] [[Fehlt]] #projekt\n![[Bild.png]]",
    "B.md": "Zurück zu [[A]] und [C](Ordner/C.md)",
    "Ordner/C.md": "[[D]]",
    "D.md": "#projekt",
    "Allein.md": "Keine Links",
    "Bild.png": "",
  });

const options = (patch: Partial<GraphOptions> = {}): GraphOptions => ({
  ...defaultGraphOptions(),
  ...patch,
});

const ids = (data: { nodes: Array<{ id: string }> }) =>
  data.nodes.map((node) => node.id);
const pairs = (data: { edges: Array<{ source: string; target: string }> }) =>
  data.edges.map((edge) => `${edge.source}–${edge.target}`).sort();

type Data = ReturnType<typeof buildGraph>;

/** Nodes, edges and the group partition, independent of order and numbering. */
function describeGraph(data: Data) {
  const members = new Map<number, string[]>();
  for (const node of data.nodes)
    if (node.group >= 0)
      (
        members.get(node.group) ?? members.set(node.group, []).get(node.group)!
      ).push(node.id);
  return {
    nodes: data.nodes.map(({ group: _group, ...node }) => node),
    edges: pairs(data),
    groups: [...members.values()].map((list) => list.sort().join(",")).sort(),
  };
}

/** Reference cut: breadth-first search on the full graph, then the induced subgraph. */
function cutLocal(full: Data, center: string, depth: number): Data {
  const near = new Map<string, string[]>();
  for (const { source, target } of full.edges) {
    (near.get(source) ?? near.set(source, []).get(source)!).push(target);
    (near.get(target) ?? near.set(target, []).get(target)!).push(source);
  }
  const visible = new Set([center]);
  let frontier = [center];
  for (let d = 0; d < depth; d++) {
    frontier = frontier.flatMap((id) =>
      (near.get(id) ?? []).filter(
        (other) => !visible.has(other) && visible.add(other),
      ),
    );
  }
  const edges = full.edges.filter(
    (edge) => visible.has(edge.source) && visible.has(edge.target),
  );
  const degree = new Map<string, number>();
  for (const edge of edges)
    for (const id of [edge.source, edge.target])
      degree.set(id, (degree.get(id) ?? 0) + 1);
  // Components of the cut, numbered arbitrarily (describeGraph ignores numbers).
  const group = new Map<string, number>();
  let next = 0;
  for (const id of visible) {
    if (group.has(id) || !degree.get(id)) continue;
    const stack = [id];
    group.set(id, next);
    while (stack.length)
      for (const other of near.get(stack.pop()!) ?? [])
        if (visible.has(other) && !group.has(other)) {
          group.set(other, next);
          stack.push(other);
        }
    next++;
  }
  return {
    nodes: full.nodes
      .filter((node) => visible.has(node.id))
      .map((node) => ({
        ...node,
        degree: degree.get(node.id) ?? 0,
        group: group.get(node.id) ?? -1,
      })),
    edges,
  };
}

describe("graph data", () => {
  it("connects notes once per pair and leaves attachments out", () => {
    const data = buildGraph(sample(), options());
    expect(ids(data)).toEqual([
      "A.md",
      "Allein.md",
      "B.md",
      "D.md",
      "Ordner/C.md",
    ]);
    expect(pairs(data)).toEqual([
      "A.md–B.md",
      "B.md–Ordner/C.md",
      "D.md–Ordner/C.md",
    ]);
    const a = data.nodes.find((node) => node.id === "A.md")!;
    expect(a).toMatchObject({ label: "A", kind: "note", degree: 1 });
    expect(data.nodes.find((node) => node.id === "Ordner/C.md")!.label).toBe(
      "C",
    );
  });

  it("numbers linked groups by size and marks unlinked notes", () => {
    const index = sample();
    index.setFiles([...index.files, "X.md", "Y.md"]);
    index.setContent("X.md", "[[Y]]");
    const data = buildGraph(index, options());
    const group = (id: string) =>
      data.nodes.find((node) => node.id === id)!.group;
    expect(group("A.md")).toBe(0);
    expect(group("D.md")).toBe(0);
    expect(group("X.md")).toBe(1);
    expect(group("Y.md")).toBe(1);
    expect(group("Allein.md")).toBe(-1);
  });

  it("adds tags and unresolved links on request and hides orphans", () => {
    const data = buildGraph(
      sample(),
      options({ showTags: true, showUnresolved: true, showOrphans: false }),
    );
    expect(ids(data)).not.toContain("Allein.md");
    const tag = data.nodes.find((node) => node.id === "#projekt")!;
    expect(tag).toMatchObject({ kind: "tag", label: "#projekt", degree: 2 });
    const missing = data.nodes.find((node) => node.id === "?fehlt")!;
    expect(missing).toMatchObject({
      kind: "unresolved",
      label: "Fehlt",
      source: "A.md",
    });
    expect(pairs(data)).toContain("#projekt–A.md");
    expect(pairs(data)).toContain("?fehlt–A.md");
  });

  it("filters by path and keeps the direct neighbours of matches", () => {
    const data = buildGraph(sample(), options({ filter: "ordner/" }));
    expect(ids(data)).toEqual(["B.md", "D.md", "Ordner/C.md"]);
  });

  it("builds a local graph around one note up to the given depth", () => {
    const index = sample();
    expect(
      ids(buildGraph(index, options({ center: "A.md", depth: 1 }))),
    ).toEqual(["A.md", "B.md"]);
    expect(
      ids(buildGraph(index, options({ center: "A.md", depth: 2 }))),
    ).toEqual(["A.md", "B.md", "Ordner/C.md"]);
    expect(
      ids(buildGraph(index, options({ center: "Allein.md", depth: 2 }))),
    ).toEqual(["Allein.md"]);
    expect(buildGraph(index, options({ center: "Fehlt.md" })).nodes).toEqual(
      [],
    );
  });

  it("cuts the local graph exactly like the whole-vault graph would", () => {
    const files = generateVault({ count: 400, clusterSize: 25 });
    const index = vault(files);
    const paths = Object.keys(files).sort();
    for (const patch of [
      {},
      { showTags: true },
      { showUnresolved: true, showOrphans: false },
    ])
      for (const center of [paths[0], paths[7], paths[123], paths[399]])
        for (const depth of [1, 2, 3])
          expect(
            describeGraph(
              buildGraph(index, options({ ...patch, center, depth })),
            ),
          ).toEqual(
            describeGraph(
              cutLocal(
                buildGraph(index, options({ ...patch, showOrphans: true })),
                center,
                depth,
              ),
            ),
          );
  });

  it("follows edits, renames and removed links without a full rebuild", () => {
    const index = sample();
    const local = (center: string) =>
      pairs(buildGraph(index, options({ center, depth: 1, showTags: true })));
    expect(local("D.md")).toEqual(["#projekt–D.md", "D.md–Ordner/C.md"]);
    // The note graph is now built; edits update it in place.
    index.setContent("Ordner/C.md", "Kein Link mehr");
    expect(local("D.md")).toEqual(["#projekt–D.md"]);
    index.setContent("Allein.md", "Jetzt mit [[D]] und #Projekt");
    // Tags match case-insensitively; edges between visible nodes are kept.
    expect(local("D.md")).toEqual([
      "#projekt–Allein.md",
      "#projekt–D.md",
      "Allein.md–D.md",
    ]);
    expect(
      buildGraph(index, options({ center: "#projekt", depth: 1 })).nodes,
    ).toEqual([]);
    // A new file list changes link resolution and rebuilds the note graph.
    index.setFiles([...index.files, "Fehlt.md"]);
    index.setContent("Fehlt.md", "");
    expect(local("Fehlt.md")).toEqual(["A.md–Fehlt.md"]);
  });
});

describe("force layout", () => {
  it("settles linked nodes closer together than unlinked ones", () => {
    const layout = new ForceLayout();
    layout.setGraph(buildGraph(sample(), options()));
    for (let i = 0; i < 400 && !layout.settled; i++) layout.tick();
    expect(layout.settled).toBe(true);
    const distance = (a: string, b: string) => {
      const p = layout.get(a)!;
      const q = layout.get(b)!;
      return Math.hypot(p.x - q.x, p.y - q.y);
    };
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
    expect(distance("A.md", "B.md")).toBeLessThan(
      distance("A.md", "Allein.md"),
    );
    // Nodes never collapse onto each other.
    expect(distance("A.md", "B.md")).toBeGreaterThan(60);
  });

  it("keeps positions of nodes that survive a rebuild", () => {
    const index = sample();
    const layout = new ForceLayout();
    layout.setGraph(buildGraph(index, options()));
    for (let i = 0; i < 50; i++) layout.tick();
    const before = { ...layout.get("A.md")! };
    layout.setGraph(buildGraph(index, options({ showTags: true })));
    expect(layout.get("A.md")).toMatchObject({ x: before.x, y: before.y });
    expect(layout.get("#projekt")).toBeDefined();
  });

  it("places a new note next to its neighbour and only nudges the layout", () => {
    const index = sample();
    const layout = new ForceLayout();
    layout.setGraph(buildGraph(index, options()));
    for (let i = 0; i < 400 && !layout.settled; i++) layout.tick();
    index.setFiles([...index.files, "Neu.md"]);
    index.setContent("Neu.md", "[[D]]");
    layout.setGraph(buildGraph(index, options()));
    expect(layout.alpha).toBeLessThan(0.5);
    const added = layout.get("Neu.md")!;
    const anchor = layout.get("D.md")!;
    expect(Math.hypot(added.x - anchor.x, added.y - anchor.y)).toBeLessThan(40);
  });

  it("separates linked clusters, keeps orphans on an outer ring and stays bounded", () => {
    const files: Record<string, string> = {};
    // Two hubs with 30 leaves each, joined by a single link, plus 12 orphans.
    for (const hub of ["Nord", "Süd"]) {
      files[`${hub}.md`] = hub === "Nord" ? "[[Süd]]" : "";
      for (let i = 0; i < 30; i++) files[`${hub} ${i}.md`] = `[[${hub}]]`;
    }
    for (let i = 0; i < 12; i++) files[`Allein ${i}.md`] = "";
    const data = buildGraph(vault(files), options());
    const layout = new ForceLayout();
    layout.setGraph(data);
    let ticks = 0;
    while (!layout.settled && ticks < 600) {
      layout.tick();
      ticks++;
    }
    expect(layout.settled).toBe(true);
    const at = (id: string) => layout.get(id)!;
    const gap = (a: string, b: string) =>
      Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y);
    const mean = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const leaves = (hub: string) =>
      Array.from({ length: 30 }, (_, i) => `${hub} ${i}.md`);
    // Leaves gather around their own hub, far from the other one.
    expect(mean(leaves("Nord").map((id) => gap(id, "Nord.md")))).toBeLessThan(
      mean(leaves("Nord").map((id) => gap(id, "Süd.md"))) * 0.6,
    );
    // No leaf sits on top of another one.
    const all = leaves("Nord");
    for (const a of all)
      for (const b of all)
        if (a < b) expect(gap(a, b)).toBeGreaterThan(nodeRadius(1) * 2);
    // Orphans ring the linked notes instead of mixing with them.
    const radius = (id: string) => Math.hypot(at(id).x, at(id).y);
    const linked = data.nodes.filter((n) => n.degree).map((n) => n.id);
    const orphans = data.nodes.filter((n) => !n.degree).map((n) => n.id);
    expect(Math.min(...orphans.map(radius))).toBeGreaterThan(
      Math.max(...linked.map(radius)),
    );
    // ...but close enough that fitting the view does not shrink everything.
    expect(Math.max(...orphans.map(radius))).toBeLessThan(
      Math.max(...linked.map(radius)) * 2,
    );
  });

  it("sizes hubs by link count within limits", () => {
    expect(nodeRadius(0)).toBeGreaterThan(3);
    expect(nodeRadius(9)).toBeGreaterThan(nodeRadius(1));
    expect(nodeRadius(10_000)).toBeLessThanOrEqual(24);
  });

  it("handles many nodes on the same spot without NaN", () => {
    const layout = new ForceLayout();
    layout.setGraph({
      nodes: Array.from({ length: 300 }, (_, i) => ({
        id: `n${i}`,
        label: `n${i}`,
        kind: "note" as const,
        degree: 0,
        group: -1,
      })),
      edges: [],
    });
    for (const node of layout.nodes) node.x = node.y = 0;
    for (let i = 0; i < 20; i++) layout.tick();
    for (const node of layout.nodes) expect(Number.isNaN(node.x)).toBe(false);
    const spread = layout.bounds();
    expect(spread.x1 - spread.x0).toBeGreaterThan(1);
  });
});

describe("graph view", () => {
  it("shows the empty state even when the first graph has no nodes", () => {
    const view = new GraphView({ activate() {} }, "Graph", "Leer");
    view.setData({ nodes: [], edges: [] });
    expect(view.el.querySelector<HTMLElement>(".graph-empty")!.hidden).toBe(
      false,
    );
    view.destroy();
  });

  it("retains keyboard focus when a live update adds nodes", () => {
    const view = new GraphView({ activate() {} }, "Graph", "Leer");
    document.body.append(view.el);
    view.setData(buildGraph(sample(), options()));
    const node = view.el.querySelector<SVGGElement>('[data-id="B.md"]')!;
    node.focus();
    view.setData(buildGraph(sample(), options({ showTags: true })));
    expect(document.activeElement).toBe(node);
    expect(node.classList.contains("is-focused")).toBe(true);
    view.destroy();
    view.el.remove();
  });

  it("places labels below nodes and highlights only the focused node in accent", () => {
    const view = new GraphView({ activate() {} }, "Graph", "Leer");
    view.setData(buildGraph(sample(), options()));
    const node = view.el.querySelector<SVGGElement>('[data-id="A.md"]')!;
    const label = node.querySelector("text")!;
    expect(Number(label.getAttribute("y"))).toBeGreaterThan(
      Number(node.querySelector("circle")!.getAttribute("r")),
    );
    expect(node.dataset.tier).toBe("0");
    node.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(node.classList.contains("is-focused")).toBe(true);
    expect(view.el.querySelectorAll(".is-highlighted")).toHaveLength(3);
    node.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(view.el.querySelectorAll(".is-focused")).toHaveLength(0);
    view.destroy();
  });

  it("pans and zooms by keyboard without intercepting modified app shortcuts", () => {
    const view = new GraphView({ activate() {} }, "Graph", "Leer");
    view.setData(buildGraph(sample(), options()));
    const canvas = view.el.querySelector<SVGSVGElement>(".graph-canvas")!;
    const viewport = view.el.querySelector(".graph-viewport")!;
    expect(canvas.getAttribute("tabindex")).toBe("0");
    expect(canvas.querySelector(".graph-hit-area")).not.toBeNull();
    const press = (key: string, extra: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...extra,
      });
      canvas.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const before = viewport.getAttribute("transform");
    expect(press("ArrowRight")).toBe(true);
    expect(viewport.getAttribute("transform")).not.toBe(before);
    const panned = viewport.getAttribute("transform");
    expect(press("+", { ctrlKey: true })).toBe(false);
    expect(viewport.getAttribute("transform")).toBe(panned);
    expect(press("+")).toBe(true);
    expect(viewport.getAttribute("transform")).not.toBe(panned);
    for (let i = 0; i < 60; i++) press("-", { shiftKey: true });
    expect(viewport.getAttribute("transform")).toContain("scale(0.100)");
    for (let i = 0; i < 60; i++) press("+", { shiftKey: true });
    expect(viewport.getAttribute("transform")).toContain("scale(6.000)");
    view.destroy();
  });

  it("keeps connected-component colors opt-in without rebuilding the layout", () => {
    const view = new GraphView({ activate() {} }, "Graph", "Leer");
    view.setData(buildGraph(sample(), options()));
    const node = view.el.querySelector(".graph-node");
    expect(view.el.classList.contains("graph-color-groups")).toBe(false);
    view.setGroupColors(true);
    expect(view.el.classList.contains("graph-color-groups")).toBe(true);
    expect(view.el.querySelector(".graph-node")).toBe(node);
    view.setGroupColors(false);
    expect(view.el.classList.contains("graph-color-groups")).toBe(false);
    view.destroy();
  });

  it("renders every node as a named button and activates it by keyboard", () => {
    const activated: string[] = [];
    const view = new GraphView(
      { activate: (node) => activated.push(node.id) },
      "Graph",
      "Leer",
    );
    document.body.append(view.el);
    view.setData(buildGraph(sample(), options()), "A.md");
    const buttons = view.el.querySelectorAll<SVGGElement>(".graph-node");
    expect([...buttons].map((el) => el.getAttribute("aria-label"))).toEqual([
      "A",
      "Allein",
      "B",
      "D",
      "C",
    ]);
    expect(buttons[0].classList.contains("is-active")).toBe(true);
    expect(view.el.querySelectorAll(".graph-edge")).toHaveLength(3);
    buttons[2].dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(activated).toEqual(["B.md"]);
    // Same links again (e.g. an edit that changed only text): nothing rebuilt.
    view.setData(buildGraph(sample(), options()), "B.md");
    expect(view.el.querySelectorAll(".graph-node")[0]).toBe(buttons[0]);
    expect(buttons[0].classList.contains("is-active")).toBe(false);
    expect(buttons[2].classList.contains("is-active")).toBe(true);
    view.setData({ nodes: [], edges: [] });
    expect(view.el.querySelector<HTMLElement>(".graph-empty")!.hidden).toBe(
      false,
    );
    view.destroy();
    view.el.remove();
  });

  it("keeps the local graph settings behind a closed gear", () => {
    const pane = document.createElement("div");
    document.body.append(pane);
    const app = { index: sample(), activePath: "A.md" } as unknown as App;
    const local = new LocalGraph(app, pane);
    local.render("A.md");
    // The graph view is the panel's only child, so it gets the full height.
    expect(pane.children).toHaveLength(1);
    const settings = pane.querySelector<HTMLDetailsElement>(
      ".graph-local-settings",
    )!;
    expect(settings.open).toBe(false);
    expect(settings.querySelector("summary")!.getAttribute("aria-label")).toBe(
      "Graph-Einstellungen",
    );
    expect(settings.querySelector('input[type="range"]')).not.toBeNull();
    settings.open = true;
    pane
      .querySelector(".graph-canvas")!
      .dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(settings.open).toBe(false);
    pane.remove();
  });
});
