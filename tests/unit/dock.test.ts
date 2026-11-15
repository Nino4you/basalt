import { describe, expect, it } from "vitest";
import {
  activatePanel,
  areaOf,
  defaultDock,
  type DockArea,
  type DockGeometry,
  dropTargetAt,
  effectiveDock,
  movePanel,
  normalizeDock,
  type PanelSpec,
  withoutPanels,
} from "../../src/app/dock";

const specs: PanelSpec[] = [
  { id: "files", label: "Dateien", icon: "folder", area: "left" },
  { id: "search", label: "Suche", icon: "search", area: "left" },
  { id: "backlinks", label: "Rückverweise", icon: "link", area: "right" },
  { id: "outline", label: "Gliederung", icon: "list", area: "right" },
];

describe("dock layout", () => {
  it("keeps the stored place of dynamic plugin panels", () => {
    const raw = {
      left: { panels: ["files", "plugin:calendar", "bogus"], active: "plugin:calendar" },
      right: { panels: ["plugin:calendar"], active: null },
    };
    const dock = normalizeDock(raw, specs, (id) => id.startsWith("plugin:"));
    expect(dock.left).toEqual({
      panels: ["files", "plugin:calendar", "search"],
      active: "plugin:calendar",
    });
    expect(dock.right.panels).toEqual(["backlinks", "outline"]);
    expect(normalizeDock(raw, specs).left.panels).toEqual(["files", "search"]);
  });

  it("starts with every panel in its default area", () => {
    const dock = defaultDock(specs);
    expect(dock.left).toEqual({ panels: ["files", "search"], active: "files" });
    expect(dock.right).toEqual({
      panels: ["backlinks", "outline"],
      active: "backlinks",
    });
    expect(dock.bottom).toEqual({ panels: [], active: null });
  });

  it("moves a panel to another area and activates it there", () => {
    const start = defaultDock(specs);
    const dock = movePanel(start, "files", "bottom");
    expect(dock.left).toEqual({ panels: ["search"], active: "search" });
    expect(dock.bottom).toEqual({ panels: ["files"], active: "files" });
    expect(start.left.panels).toEqual(["files", "search"]);
  });

  it("moves panels into the lower-left dock and migrates old layouts", () => {
    const start = defaultDock(specs);
    expect(start["left-bottom"]).toEqual({ panels: [], active: null });
    const moved = movePanel(start, "search", "left-bottom");
    expect(moved["left-bottom"]).toEqual({ panels: ["search"], active: "search" });
    expect(moved.left.panels).toEqual(["files"]);
    expect(normalizeDock({ left: start.left, right: start.right, bottom: start.bottom }, specs)).toEqual(start);
    expect(normalizeDock(moved, specs)).toEqual(moved);
  });

  it("folds lower-left panels into the left drawer without changing stored placement", () => {
    const dock = movePanel(defaultDock(specs), "search", "left-bottom");
    const shown = effectiveDock(dock, true);
    expect(shown.left.panels).toEqual(["files", "search"]);
    expect(shown["left-bottom"]).toEqual({ panels: [], active: null });
    expect(dock["left-bottom"].panels).toEqual(["search"]);
  });

  it("inserts at a tab strip position and keeps the source's active panel", () => {
    const dock = movePanel(defaultDock(specs), "search", "right", 1);
    expect(dock.right.panels).toEqual(["backlinks", "search", "outline"]);
    expect(dock.left.active).toBe("files");
  });

  it("reorders inside an area using indices of the visible strip", () => {
    const start = defaultDock(specs);
    expect(movePanel(start, "files", "left", 2).left.panels).toEqual([
      "search",
      "files",
    ]);
    expect(movePanel(start, "search", "left", 0).left.panels).toEqual([
      "search",
      "files",
    ]);
    expect(movePanel(start, "files", "left", 1).left.panels).toEqual([
      "files",
      "search",
    ]);
  });

  it("leaves an area empty when its last panel moves away", () => {
    let dock = movePanel(defaultDock(specs), "files", "right");
    dock = movePanel(dock, "search", "right");
    expect(dock.left).toEqual({ panels: [], active: null });
    expect(areaOf(dock, "search")).toBe("right");
  });

  it("repairs stored layouts", () => {
    const dock = normalizeDock(
      {
        left: { panels: ["outline", "gone", "outline", 3], active: "files" },
        right: { panels: ["files"], active: "files" },
        bottom: "nonsense",
      },
      specs,
    );
    expect(dock.left).toEqual({
      panels: ["outline", "search"],
      active: "outline",
    });
    expect(dock.right).toEqual({
      panels: ["files", "backlinks"],
      active: "files",
    });
    expect(dock.bottom).toEqual({ panels: [], active: null });
    expect(normalizeDock(null, specs)).toEqual(defaultDock(specs));
  });

  it("folds the bottom area into the right drawer on phones", () => {
    let dock = movePanel(defaultDock(specs), "outline", "bottom");
    dock = movePanel(dock, "backlinks", "bottom");
    const shown = effectiveDock(dock, true);
    expect(shown.bottom.panels).toEqual([]);
    expect(shown.right).toEqual({
      panels: ["outline", "backlinks"],
      active: "backlinks",
    });
    expect(effectiveDock(dock, false)).toEqual(dock);
    expect(activatePanel(dock, "outline").bottom.active).toBe("outline");
  });
});

describe("dock drop targets", () => {
  // 1000×600 workspace; the left sidebar is 200 wide, the others vary.
  const geometry = (open: DockArea[] = ["left"]): DockGeometry => {
    const left = open.includes("left") ? 200 : 0;
    const right = open.includes("right") ? 760 : 1000;
    const bottom = open.includes("bottom") ? 400 : 600;
    return {
      open: {
        ...(open.includes("left") && {
          left: {
            box: { left: 0, top: 0, right: 200, bottom: 600 },
            strip: { left: 0, top: 0, right: 200, bottom: 40 },
          },
        }),
        ...(open.includes("right") && {
          right: {
            box: { left: 760, top: 0, right: 1000, bottom: 600 },
            strip: { left: 760, top: 0, right: 1000, bottom: 40 },
          },
        }),
        ...(open.includes("bottom") && {
          bottom: {
            box: { left, top: 400, right, bottom: 600 },
            strip: { left, top: 400, right, bottom: 440 },
          },
        }),
      },
      editor: { left, top: 0, right, bottom },
      sizes: { left: 280, "left-bottom": 180, right: 240, bottom: 220 },
    };
  };

  it("takes drops on an open area as a whole and on its strip by position", () => {
    expect(dropTargetAt(100, 20, geometry())).toMatchObject({
      area: "left",
      kind: "strip",
    });
    expect(dropTargetAt(100, 300, geometry())).toEqual({
      area: "left",
      kind: "area",
      rect: { left: 0, top: 0, right: 200, bottom: 600 },
    });
    expect(dropTargetAt(500, 500, geometry(["left", "bottom"]))).toMatchObject({
      area: "bottom",
      kind: "area",
    });
  });

  it("prioritizes the lower-left dock over its containing sidebar", () => {
    const g = geometry();
    g.open["left-bottom"] = {
      box: { left: 0, top: 400, right: 200, bottom: 570 },
      strip: { left: 0, top: 400, right: 200, bottom: 440 },
    };
    expect(dropTargetAt(100, 420, g)).toMatchObject({ area: "left-bottom", kind: "strip" });
    expect(dropTargetAt(100, 500, g)).toMatchObject({ area: "left-bottom", kind: "area" });
    expect(dropTargetAt(100, 300, g)).toMatchObject({ area: "left" });
  });

  it("opens closed areas from the editor border, previewing their size", () => {
    expect(dropTargetAt(990, 300, geometry())).toEqual({
      area: "right",
      kind: "edge",
      rect: { left: 760, top: 0, right: 1000, bottom: 600 },
    });
    expect(dropTargetAt(600, 590, geometry())).toEqual({
      area: "bottom",
      kind: "edge",
      rect: { left: 200, top: 400, right: 1000, bottom: 600 },
    });
    // Full-height sidebars win the lower corners.
    expect(dropTargetAt(990, 590, geometry())).toMatchObject({ area: "right" });
    // A wide sidebar is capped at a third of the editor.
    expect(
      dropTargetAt(100, 300, {
        ...geometry([]),
        sizes: { left: 600, "left-bottom": 180, right: 240, bottom: 220 },
      })?.rect.right,
    ).toBeCloseTo(1000 / 3);
  });

  it("offers no target in the middle, at open borders or outside", () => {
    expect(dropTargetAt(600, 200, geometry())).toBeNull();
    expect(dropTargetAt(210, 200, geometry())).toBeNull();
    expect(
      dropTargetAt(750, 390, geometry(["left", "right", "bottom"])),
    ).toBeNull();
    expect(dropTargetAt(600, 700, geometry())).toBeNull();
  });
});

describe("withoutPanels", () => {
  const specs = [
    { id: "a", label: "A", icon: "x", area: "left" },
    { id: "b", label: "B", icon: "x", area: "left" },
    { id: "c", label: "C", icon: "x", area: "left" },
    { id: "d", label: "D", icon: "x", area: "bottom" },
  ] as const;

  it("drops closed panels and falls back to the panel before the active one", () => {
    const layout = activatePanel(defaultDock(specs), "c");
    const shown = withoutPanels(layout, ["c", "d"]);
    expect(shown.left).toEqual({ panels: ["a", "b"], active: "b" });
    expect(shown.bottom).toEqual({ panels: [], active: null });
    // The stored layout is untouched, so reopening restores the old place.
    expect(layout.left.panels).toEqual(["a", "b", "c"]);
  });

  it("keeps an active panel that is still open", () => {
    const layout = activatePanel(defaultDock(specs), "b");
    expect(withoutPanels(layout, ["a"]).left).toEqual({
      panels: ["b", "c"],
      active: "b",
    });
    expect(withoutPanels(layout, ["b"]).left.active).toBe("a");
  });
});
