import { describe, expect, it, vi } from "vitest";
import { VaultIndex } from "../../src/app/vault-index";
import { validateCanvasPath } from "../../src/backend";
import {
  addEdge,
  addNode,
  bounds,
  canvasIndexText,
  CanvasFormatError,
  cssColor,
  edgeGeometry,
  emptyCanvas,
  facingSide,
  nodesInGroup,
  parseCanvas,
  removeNodes,
  serializeCanvas,
} from "../../src/canvas/model";
import { CanvasView, type CanvasHost } from "../../src/canvas/view";
import demo from "../../examples/demo-vault/Ideenboard.canvas?raw";

const SAMPLE = JSON.stringify({
  nodes: [
    {
      id: "a",
      type: "text",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      text: "Hallo [[Ziel]]",
    },
    {
      id: "b",
      type: "file",
      x: 400,
      y: 0,
      width: 200,
      height: 100,
      file: "Ziel.md",
      subpath: "#Kopf",
    },
    {
      id: "c",
      type: "link",
      x: 0,
      y: 300,
      width: 200,
      height: 100,
      url: "https://example.org",
    },
    {
      id: "g",
      type: "group",
      x: -50,
      y: -50,
      width: 700,
      height: 200,
      label: "Rahmen",
      custom: 1,
    },
  ],
  edges: [
    {
      id: "e",
      fromNode: "a",
      fromSide: "right",
      toNode: "b",
      toSide: "left",
      label: "weiter",
    },
  ],
  extra: { kept: true },
});

describe("JSON Canvas model", () => {
  it("parses all node types and keeps unknown fields on round-trip", () => {
    const data = parseCanvas(SAMPLE);
    expect(data.nodes.map((node) => node.type)).toEqual([
      "text",
      "file",
      "link",
      "group",
    ]);
    const again = JSON.parse(serializeCanvas(data));
    expect(again).toEqual(JSON.parse(SAMPLE));
    expect(serializeCanvas(data)).toContain('\n\t"nodes"');
  });

  it("treats an empty file as an empty canvas and fills missing lists", () => {
    expect(parseCanvas("")).toEqual({ nodes: [], edges: [] });
    expect(parseCanvas("{}")).toEqual({ nodes: [], edges: [] });
    expect(parseCanvas(emptyCanvas())).toEqual({ nodes: [], edges: [] });
  });

  it("rejects malformed canvases instead of guessing", () => {
    for (const text of [
      "nicht json",
      "[]",
      '{"nodes": {}}',
      '{"nodes": [{"id": "a", "type": "text", "x": 0, "y": 0, "width": 1, "height": 1}]}',
      '{"nodes": [{"id": "a", "type": "blob", "x": 0, "y": 0, "width": 1, "height": 1}]}',
      '{"nodes": [{"id": "a", "type": "text", "text": "", "x": "0", "y": 0, "width": 1, "height": 1}]}',
      '{"nodes": [{"id": "a", "type": "text", "text": "", "x": 0, "y": 0, "width": 1, "height": 1}, {"id": "a", "type": "text", "text": "", "x": 0, "y": 0, "width": 1, "height": 1}]}',
      '{"edges": [{"id": "e", "fromNode": "a", "toNode": "b", "toSide": "middle"}]}',
      '{"edges": [{"id": "e", "fromNode": "a", "toNode": "b", "toEnd": "circle"}]}',
    ])
      expect(() => parseCanvas(text), text).toThrow(CanvasFormatError);
  });

  it("parses the bundled demo canvas", () => {
    const data = parseCanvas(demo);
    expect(data.nodes.length).toBeGreaterThan(2);
    expect(data.edges.length).toBeGreaterThan(0);
  });

  it("adds nodes with fresh ids, groups at the back, and drops edges with removed nodes", () => {
    const data = parseCanvas(SAMPLE);
    const node = addNode(data, {
      type: "text",
      text: "",
      x: 1.4,
      y: 2.6,
      width: 10,
      height: 10,
    });
    expect(node.id).toMatch(/^[0-9a-f]{16}$/);
    expect(node.x).toBe(1);
    expect(node.y).toBe(3);
    expect(data.nodes.at(-1)).toBe(node);
    const group = addNode(data, {
      type: "group",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(data.nodes[0]).toBe(group);
    removeNodes(data, ["a"]);
    expect(data.edges).toEqual([]);
    expect(data.nodes.some((item) => item.id === "a")).toBe(false);
  });

  it("refuses self-loops, dangling and duplicate edges", () => {
    const data = parseCanvas(SAMPLE);
    expect(addEdge(data, { fromNode: "a", toNode: "a" })).toBeNull();
    expect(addEdge(data, { fromNode: "a", toNode: "missing" })).toBeNull();
    expect(
      addEdge(data, {
        fromNode: "a",
        fromSide: "right",
        toNode: "b",
        toSide: "left",
      }),
    ).toBeNull();
    const edge = addEdge(data, { fromNode: "b", toNode: "c" });
    expect(edge?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(data.edges).toHaveLength(2);
  });

  it("finds group members, bounds and facing sides", () => {
    const data = parseCanvas(SAMPLE);
    const group = data.nodes.find((node) => node.id === "g")!;
    expect(nodesInGroup(data, group).map((node) => node.id)).toEqual([
      "a",
      "b",
    ]);
    expect(bounds(data.nodes)).toEqual({
      x: -50,
      y: -50,
      width: 700,
      height: 450,
    });
    expect(bounds([])).toBeNull();
    const rect = { x: 0, y: 0, width: 100, height: 100 };
    expect(facingSide(rect, { x: 500, y: 50 })).toBe("right");
    expect(facingSide(rect, { x: 50, y: -500 })).toBe("top");
  });

  it("draws edges from the named sides", () => {
    const from = { x: 0, y: 0, width: 100, height: 50 };
    const to = { x: 300, y: 0, width: 100, height: 50 };
    const geometry = edgeGeometry(from, to, {
      fromSide: "right",
      toSide: "left",
    });
    expect(geometry.from).toEqual({ x: 100, y: 25 });
    expect(geometry.to).toEqual({ x: 300, y: 25 });
    expect(geometry.path.startsWith("M 100 25 C")).toBe(true);
    // Without sides the facing sides are used.
    expect(edgeGeometry(from, to, {}).fromSide).toBe("right");
  });

  it("only accepts preset or hex colors", () => {
    expect(cssColor("3")).toBe("var(--canvas-color-3)");
    expect(cssColor("#a1B2c3")).toBe("#a1B2c3");
    expect(cssColor("red; background: url(x)")).toBeNull();
    expect(cssColor(undefined)).toBeNull();
  });

  it("names new canvas files", () => {
    expect(validateCanvasPath("Board")).toBe("Board.canvas");
    expect(validateCanvasPath("Ordner/Board.canvas")).toBe(
      "Ordner/Board.canvas",
    );
    expect(() => validateCanvasPath("../Board")).toThrow();
  });
});

describe("canvas in the vault index", () => {
  it("turns file cards into backlinks and card text into searchable lines", () => {
    expect(canvasIndexText(SAMPLE).split("\n")).toEqual([
      "Hallo [[Ziel]]",
      "[[Ziel.md#Kopf]]",
      "https://example.org",
      "Rahmen",
      "weiter",
    ]);
    expect(canvasIndexText("kaputt")).toBe("");
    const index = new VaultIndex();
    index.setFiles(["Board.canvas", "Ziel.md"]);
    index.setContent("Board.canvas", SAMPLE);
    index.setContent("Ziel.md", "# Ziel");
    expect(index.backlinks("Ziel.md").map((m) => m.source)).toEqual([
      "Board.canvas",
      "Board.canvas",
    ]);
    expect(index.lower("Board.canvas")).toContain("hallo");
  });
});

function host(overrides: Partial<CanvasHost> = {}): CanvasHost & {
  changes: string[];
} {
  const changes: string[] = [];
  return {
    changes,
    files: () => ["Ziel.md"],
    resolve: (target) =>
      target === "Ziel" || target === "Ziel.md" ? "Ziel.md" : null,
    noteText: (path) => (path === "Ziel.md" ? "# Ziel\n\nInhalt" : undefined),
    openFile: vi.fn(),
    openLink: vi.fn(),
    openExternal: vi.fn(),
    onChange: (_path, text) => changes.push(text),
    ...overrides,
  };
}

describe("canvas view", () => {
  it("renders cards, previews, groups and edges", () => {
    const view = new CanvasView(host());
    document.body.append(view.el);
    view.load("Board.canvas", SAMPLE);
    const nodes = view.el.querySelectorAll(".canvas-node");
    expect(nodes).toHaveLength(4);
    expect(
      view.el.querySelector('[data-node-id="a"] .internal-link')?.textContent,
    ).toBe("Ziel");
    expect(
      view.el.querySelector('[data-node-id="b"] .canvas-file-preview h1')
        ?.textContent,
    ).toBe("Ziel");
    expect(
      view.el.querySelector('[data-node-id="g"] .canvas-group-label')
        ?.textContent,
    ).toBe("Rahmen");
    expect(view.el.querySelectorAll(".canvas-edge")).toHaveLength(1);
    expect(view.el.querySelector(".canvas-edge-label")?.textContent).toBe(
      "weiter",
    );
    // Groups render behind cards.
    const group = view.el.querySelector<HTMLElement>('[data-node-id="g"]')!;
    const card = view.el.querySelector<HTMLElement>('[data-node-id="a"]')!;
    expect(Number(group.style.zIndex)).toBeLessThan(Number(card.style.zIndex));
    view.destroy();
  });

  it("adds a card, deletes the selection and undoes it, reporting each change", () => {
    const h = host();
    const view = new CanvasView(h);
    document.body.append(view.el);
    view.load("Board.canvas", SAMPLE);
    const node = view.addTextCard(undefined, false)!;
    expect(parseCanvas(h.changes.at(-1)!).nodes.map((n) => n.id)).toContain(
      node.id,
    );
    view.deleteSelection();
    expect(parseCanvas(h.changes.at(-1)!).nodes.map((n) => n.id)).not.toContain(
      node.id,
    );
    view.undo();
    expect(parseCanvas(h.changes.at(-1)!).nodes.map((n) => n.id)).toContain(
      node.id,
    );
    view.redo();
    expect(parseCanvas(h.changes.at(-1)!).nodes.map((n) => n.id)).not.toContain(
      node.id,
    );
    view.destroy();
  });

  it("wraps the selection in a group", () => {
    const h = host();
    const view = new CanvasView(h);
    document.body.append(view.el);
    view.load("Board.canvas", emptyCanvas());
    const card = view.addTextCard({ x: 100, y: 100 }, false)!;
    view.addGroup();
    const data = parseCanvas(h.changes.at(-1)!);
    const group = data.nodes[0];
    expect(group.type).toBe("group");
    expect(group.x).toBeLessThan(card.x);
    expect(group.x + group.width).toBeGreaterThan(card.x + card.width);
    view.destroy();
  });

  it("shows unreadable files read-only and never reports changes for them", () => {
    const h = host();
    const view = new CanvasView(h);
    document.body.append(view.el);
    view.load("Kaputt.canvas", "{ kaputt");
    expect(view.el.classList.contains("is-readonly")).toBe(true);
    expect(view.el.querySelector(".canvas-error")?.textContent).toContain(
      "Ungültige Canvas-Datei",
    );
    expect(view.addTextCard(undefined, false)).toBeNull();
    view.deleteSelection();
    expect(h.changes).toEqual([]);
    view.destroy();
  });

  it("follows wiki links inside cards through the host", () => {
    const h = host();
    const view = new CanvasView(h);
    document.body.append(view.el);
    view.load("Board.canvas", SAMPLE);
    view.el
      .querySelector<HTMLElement>('[data-node-id="a"] .internal-link')!
      .click();
    expect(h.openLink).toHaveBeenCalledWith("Ziel", "Board.canvas", false);
    view.destroy();
  });
});
