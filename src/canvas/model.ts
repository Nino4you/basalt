/**
 * JSON Canvas 1.0 (https://jsoncanvas.org), the format of Obsidian `.canvas`
 * files. Parsing is strict about structure but keeps every unknown field, so a
 * canvas written by another app round-trips without losing data.
 */

export type CanvasColor = string;
export type CanvasSide = "top" | "right" | "bottom" | "left";
export type CanvasEnd = "none" | "arrow";

interface NodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
}

export interface TextNode extends NodeBase {
  type: "text";
  text: string;
}

export interface FileNode extends NodeBase {
  type: "file";
  file: string;
  subpath?: string;
}

export interface LinkNode extends NodeBase {
  type: "link";
  url: string;
}

export interface GroupNode extends NodeBase {
  type: "group";
  label?: string;
  background?: string;
  backgroundStyle?: "cover" | "ratio" | "repeat";
}

export type CanvasNode = TextNode | FileNode | LinkNode | GroupNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: CanvasSide;
  fromEnd?: CanvasEnd;
  toNode: string;
  toSide?: CanvasSide;
  toEnd?: CanvasEnd;
  color?: CanvasColor;
  label?: string;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [key: string]: unknown;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const SIDES: readonly CanvasSide[] = ["top", "right", "bottom", "left"];
export const NODE_TYPES = ["text", "file", "link", "group"] as const;
/** The six preset colors of the spec, in Obsidian's order. */
export const PRESET_COLORS = ["1", "2", "3", "4", "5", "6"] as const;

export class CanvasFormatError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function fail(message: string): never {
  throw new CanvasFormatError(`Ungültige Canvas-Datei: ${message}`);
}

function finite(value: unknown, field: string, id: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`„${field}“ von Knoten „${id}“ ist keine Zahl.`);
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  owner: string,
): void {
  if (record[field] !== undefined && typeof record[field] !== "string")
    fail(`„${field}“ von „${owner}“ ist kein Text.`);
}

/** An empty or whitespace-only file is a new, empty canvas (as in Obsidian). */
export function parseCanvas(text: string): CanvasData {
  if (!text.trim()) return { nodes: [], edges: [] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("kein gültiges JSON.");
  }
  if (!isRecord(value)) fail("die oberste Ebene ist kein Objekt.");
  const nodes = value.nodes ?? [];
  const edges = value.edges ?? [];
  if (!Array.isArray(nodes)) fail("„nodes“ ist keine Liste.");
  if (!Array.isArray(edges)) fail("„edges“ ist keine Liste.");
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!isRecord(node)) fail("ein Knoten ist kein Objekt.");
    if (typeof node.id !== "string" || !node.id)
      fail("ein Knoten hat keine ID.");
    if (ids.has(node.id)) fail(`die Knoten-ID „${node.id}“ ist doppelt.`);
    ids.add(node.id);
    if (!NODE_TYPES.includes(node.type as (typeof NODE_TYPES)[number]))
      fail(
        `Knoten „${node.id}“ hat den unbekannten Typ „${String(node.type)}“.`,
      );
    for (const field of ["x", "y", "width", "height"])
      finite(node[field], field, node.id);
    optionalString(node, "color", node.id);
    if (node.type === "text" && typeof node.text !== "string")
      fail(`Textknoten „${node.id}“ hat keinen Text.`);
    if (node.type === "file" && typeof node.file !== "string")
      fail(`Dateiknoten „${node.id}“ hat keine Datei.`);
    if (node.type === "link" && typeof node.url !== "string")
      fail(`Linkknoten „${node.id}“ hat keine URL.`);
    for (const field of ["subpath", "label", "background"])
      optionalString(node, field, node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (!isRecord(edge)) fail("eine Verbindung ist kein Objekt.");
    if (typeof edge.id !== "string" || !edge.id)
      fail("eine Verbindung hat keine ID.");
    if (edgeIds.has(edge.id))
      fail(`die Verbindungs-ID „${edge.id}“ ist doppelt.`);
    edgeIds.add(edge.id);
    for (const field of ["fromNode", "toNode"])
      if (typeof edge[field] !== "string")
        fail(`Verbindung „${edge.id}“ hat kein „${field}“.`);
    for (const field of ["fromSide", "toSide"])
      if (
        edge[field] !== undefined &&
        !SIDES.includes(edge[field] as CanvasSide)
      )
        fail(`Verbindung „${edge.id}“ hat eine ungültige Seite.`);
    for (const field of ["fromEnd", "toEnd"])
      if (
        edge[field] !== undefined &&
        edge[field] !== "none" &&
        edge[field] !== "arrow"
      )
        fail(`Verbindung „${edge.id}“ hat ein ungültiges Ende.`);
    optionalString(edge, "color", edge.id);
    optionalString(edge, "label", edge.id);
  }
  return { ...value, nodes, edges } as CanvasData;
}

/** Tab-indented like Obsidian, so files stay diff-friendly in both apps. */
export function serializeCanvas(data: CanvasData): string {
  return JSON.stringify(data, null, "\t");
}

export function emptyCanvas(): string {
  return serializeCanvas({ nodes: [], edges: [] });
}

/** 16 hex characters, the shape Obsidian uses for node and edge IDs. */
export function createId(taken: (id: string) => boolean = () => false): string {
  for (;;) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!taken(id)) return id;
  }
}

export function nodeById(data: CanvasData, id: string): CanvasNode | undefined {
  return data.nodes.find((node) => node.id === id);
}

export function hasId(data: CanvasData, id: string): boolean {
  return (
    data.nodes.some((node) => node.id === id) ||
    data.edges.some((edge) => edge.id === id)
  );
}

type NewNode =
  | Omit<TextNode, "id">
  | Omit<FileNode, "id">
  | Omit<LinkNode, "id">
  | Omit<GroupNode, "id">;

export function addNode(data: CanvasData, node: NewNode): CanvasNode {
  const created = {
    ...node,
    id: createId((id) => hasId(data, id)),
    x: Math.round(node.x),
    y: Math.round(node.y),
    width: Math.round(node.width),
    height: Math.round(node.height),
  } as CanvasNode;
  // Groups sit behind the cards they contain: lower index means further back.
  if (created.type === "group") data.nodes.unshift(created);
  else data.nodes.push(created);
  return created;
}

/** Removes nodes and every edge touching them. */
export function removeNodes(data: CanvasData, ids: Iterable<string>): void {
  const gone = new Set(ids);
  data.nodes = data.nodes.filter((node) => !gone.has(node.id));
  data.edges = data.edges.filter(
    (edge) => !gone.has(edge.fromNode) && !gone.has(edge.toNode),
  );
}

export function removeEdges(data: CanvasData, ids: Iterable<string>): void {
  const gone = new Set(ids);
  data.edges = data.edges.filter((edge) => !gone.has(edge.id));
}

export function addEdge(
  data: CanvasData,
  edge: Omit<CanvasEdge, "id">,
): CanvasEdge | null {
  if (
    edge.fromNode === edge.toNode ||
    !nodeById(data, edge.fromNode) ||
    !nodeById(data, edge.toNode)
  )
    return null;
  const duplicate = data.edges.find(
    (other) =>
      other.fromNode === edge.fromNode &&
      other.toNode === edge.toNode &&
      (other.fromSide ?? null) === (edge.fromSide ?? null) &&
      (other.toSide ?? null) === (edge.toSide ?? null),
  );
  if (duplicate) return null;
  const created: CanvasEdge = {
    ...edge,
    id: createId((id) => hasId(data, id)),
  };
  data.edges.push(created);
  return created;
}

/** Nodes lying completely inside `group`, which move along with it. */
export function nodesInGroup(
  data: CanvasData,
  group: CanvasNode,
): CanvasNode[] {
  return data.nodes.filter(
    (node) =>
      node !== group &&
      node.x >= group.x &&
      node.y >= group.y &&
      node.x + node.width <= group.x + group.width &&
      node.y + node.height <= group.y + group.height,
  );
}

export function bounds(nodes: readonly Rect[]): Rect | null {
  if (!nodes.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const node of nodes) {
    left = Math.min(left, node.x);
    top = Math.min(top, node.y);
    right = Math.max(right, node.x + node.width);
    bottom = Math.max(bottom, node.y + node.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function sideAnchor(
  rect: Rect,
  side: CanvasSide,
): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: rect.x + rect.width / 2, y: rect.y };
    case "bottom":
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
    case "left":
      return { x: rect.x, y: rect.y + rect.height / 2 };
    case "right":
      return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
  }
}

/** The side of `rect` that faces `point`, used when an edge omits its side. */
export function facingSide(
  rect: Rect,
  point: { x: number; y: number },
): CanvasSide {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = (point.x - cx) / Math.max(1, rect.width);
  const dy = (point.y - cy) / Math.max(1, rect.height);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "bottom" : "top";
}

const NORMALS: Record<CanvasSide, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export interface EdgeGeometry {
  from: { x: number; y: number };
  to: { x: number; y: number };
  fromSide: CanvasSide;
  toSide: CanvasSide;
  /** SVG path data for a cubic curve leaving and entering perpendicular to the sides. */
  path: string;
  /** Point on the curve at t = 0.5, for the label. */
  middle: { x: number; y: number };
}

export function edgeGeometry(
  from: Rect,
  to: Rect,
  edge: Pick<CanvasEdge, "fromSide" | "toSide">,
): EdgeGeometry {
  const centre = (rect: Rect) => ({
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  });
  const fromSide = edge.fromSide ?? facingSide(from, centre(to));
  const toSide = edge.toSide ?? facingSide(to, centre(from));
  const a = sideAnchor(from, fromSide);
  const b = sideAnchor(to, toSide);
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const pull = Math.min(Math.max(distance / 2, 40), 300);
  const c1 = {
    x: a.x + NORMALS[fromSide].x * pull,
    y: a.y + NORMALS[fromSide].y * pull,
  };
  const c2 = {
    x: b.x + NORMALS[toSide].x * pull,
    y: b.y + NORMALS[toSide].y * pull,
  };
  const middle = {
    x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8,
    y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8,
  };
  return {
    from: a,
    to: b,
    fromSide,
    toSide,
    path: `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`,
    middle,
  };
}

/**
 * Markdown stand-in for the vault index: file cards become `[[links]]`, so
 * notes placed on a canvas list it as a backlink, and card text is searchable.
 */
export function canvasIndexText(text: string): string {
  let data: CanvasData;
  try {
    data = parseCanvas(text);
  } catch {
    return "";
  }
  const lines: string[] = [];
  for (const node of data.nodes) {
    if (node.type === "file" && node.file)
      lines.push(`[[${node.file}${node.subpath ?? ""}]]`);
    else if (node.type === "text") lines.push(...node.text.split("\n"));
    else if (node.type === "link") lines.push(node.url);
    else if (node.type === "group" && node.label) lines.push(node.label);
  }
  for (const edge of data.edges) if (edge.label) lines.push(edge.label);
  return lines.join("\n");
}

/** CSS color for a canvas color value: preset number, or a validated hex color. */
export function cssColor(color: CanvasColor | undefined): string | null {
  if (!color) return null;
  if ((PRESET_COLORS as readonly string[]).includes(color))
    return `var(--canvas-color-${color})`;
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : null;
}
