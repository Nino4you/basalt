/**
 * Graph data and force layout for the graph view. Pure and DOM-free so it can
 * be unit-tested; the SVG renderer lives in graph.ts.
 */
import type { NoteGraph, VaultIndex } from "./vault-index";

export type GraphNodeKind = "note" | "unresolved" | "tag";

export interface GraphNode {
  /** Vault path for notes, `?<target>` for unresolved links, `#<tag>` for tags. */
  id: string;
  label: string;
  kind: GraphNodeKind;
  /** Number of distinct neighbours. */
  degree: number;
  /** For unresolved links: a note that links there, used to create it. */
  source?: string;
  /**
   * Connected group, numbered by size (0 = largest); -1 for nodes without any
   * visible link. Lets the view colour what belongs together.
   */
  group: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphOptions {
  showTags: boolean;
  showUnresolved: boolean;
  showOrphans: boolean;
  /** Optional component coloring; neutral nodes match the default graph view. */
  colorGroups: boolean;
  /** Case-insensitive substring of the path; matching notes keep their neighbours visible. */
  filter: string;
  /** Builds a local graph around this note instead of the whole vault. */
  center?: string | null;
  /** Link distance from `center` (local graph only). */
  depth?: number;
}

export const defaultGraphOptions = (): GraphOptions => ({
  showTags: false,
  showUnresolved: false,
  showOrphans: true,
  colorGroups: false,
  filter: "",
});

const noteLabel = (path: string) =>
  path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/**
 * Builds the undirected link graph of all Markdown notes in the index, or
 * the neighbourhood of `options.center`. Both read the index's incremental
 * note graph, so no link is resolved again here.
 */
export function buildGraph(
  index: VaultIndex,
  options: GraphOptions,
): GraphData {
  if (options.center)
    return buildLocalGraph(index, options, options.center, options.depth ?? 1);
  const graph = index.noteGraph();
  const neighbours = neighbourCache(graph, options);
  let visible = new Set(graph.position.keys());
  for (const id of graph.users.keys())
    if (id[0] === "?" ? options.showUnresolved : options.showTags)
      visible.add(id);
  const filter = options.filter.trim().toLowerCase();
  if (filter) {
    const matches = [...graph.position.keys()].filter(
      (id) =>
        id.toLowerCase().includes(filter) ||
        noteLabel(id).toLowerCase().includes(filter),
    );
    visible = new Set(matches);
    for (const id of matches)
      for (const other of neighbours(id)) visible.add(other);
  }
  if (!options.showOrphans)
    for (const id of [...visible]) if (!neighbours(id).size) visible.delete(id);
  return cut(graph, visible, neighbours);
}

/**
 * The neighbourhood of `center` up to `depth` links, as `buildGraph` would
 * cut it out of the whole vault, but walked from the centre over the index's
 * incremental note graph: the cost follows the size of the neighbourhood, not
 * of the vault, so the sidebar graph can follow every edit.
 */
export function buildLocalGraph(
  index: VaultIndex,
  options: GraphOptions,
  center: string,
  depth: number,
): GraphData {
  const graph = index.noteGraph();
  if (!graph.position.has(center)) return { nodes: [], edges: [] };
  const neighbours = neighbourCache(graph, options);
  const visible = new Set([center]);
  let frontier = [center];
  for (let d = 0; d < Math.max(1, depth); d++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const other of neighbours(id))
        if (!visible.has(other)) {
          visible.add(other);
          next.push(other);
        }
    frontier = next;
  }
  return cut(graph, visible, neighbours);
}

function neighbourCache(
  graph: NoteGraph,
  options: GraphOptions,
): (id: string) => Set<string> {
  const cache = new Map<string, Set<string>>();
  return (id) => {
    let set = cache.get(id);
    if (!set) cache.set(id, (set = neighboursOf(graph, id, options)));
    return set;
  };
}

/** The subgraph induced by `visible`, with degrees and groups counted in it. */
function cut(
  graph: NoteGraph,
  visible: Set<string>,
  neighbours: (id: string) => Set<string>,
): GraphData {
  const adjacency = new Map<string, Set<string>>();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const id of visible) {
    const near = new Set<string>();
    for (const other of neighbours(id)) if (visible.has(other)) near.add(other);
    adjacency.set(id, near);
    for (const other of near)
      if (id < other) edges.push({ source: id, target: other });
    nodes.push(graphNode(graph, id, near.size));
  }
  nodes.sort(byId);
  // A stable edge order keeps the view's change signature stable too.
  edges.sort(
    (a, b) =>
      byId({ id: a.source }, { id: b.source }) ||
      byId({ id: a.target }, { id: b.target }),
  );
  assignGroups(nodes, adjacency, visible);
  return { nodes, edges };
}

const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function neighboursOf(
  graph: NoteGraph,
  id: string,
  options: GraphOptions,
): Set<string> {
  const result = new Set<string>();
  if (!graph.position.has(id)) {
    for (const path of graph.users.get(id) ?? []) result.add(path);
    return result;
  }
  const links = graph.linksOf(id);
  for (const note of links?.notes ?? []) result.add(note);
  for (const source of graph.incoming.get(id) ?? [])
    if (source !== id) result.add(source);
  if (links && options.showUnresolved)
    for (const target of links.unresolved.keys()) result.add(target);
  if (links && options.showTags)
    for (const tag of links.tags.keys()) result.add(tag);
  return result;
}

function graphNode(graph: NoteGraph, id: string, degree: number): GraphNode {
  if (graph.position.has(id))
    return { id, label: noteLabel(id), kind: "note", degree, group: -1 };
  const source = graph.first(graph.users.get(id) ?? [])!;
  const links = graph.linksOf(source)!;
  if (id[0] === "#")
    return {
      id,
      label: `#${links.tags.get(id)}`,
      kind: "tag",
      degree,
      group: -1,
    };
  return {
    id,
    label: links.unresolved.get(id)!,
    kind: "unresolved",
    degree,
    group: -1,
    source,
  };
}

/** Numbers connected components by size, largest first; isolated nodes get -1. */
function assignGroups(
  nodes: GraphNode[],
  adjacency: Map<string, Set<string>>,
  visible: Set<string>,
): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const components: GraphNode[][] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id) || !node.degree) continue;
    const component: GraphNode[] = [];
    const stack = [node.id];
    seen.add(node.id);
    while (stack.length) {
      const id = stack.pop()!;
      component.push(byId.get(id)!);
      for (const other of adjacency.get(id) ?? [])
        if (visible.has(other) && !seen.has(other)) {
          seen.add(other);
          stack.push(other);
        }
    }
    components.push(component);
  }
  // Nodes are sorted by id, so ties keep a stable order between rebuilds.
  components.sort((a, b) => b.length - a.length);
  components.forEach((component, group) => {
    for (const node of component) node.group = group;
  });
}

/**
 * Node radius in layout units. Grows with the square root of the link count,
 * so hubs stand out without dwarfing everything else. Shared by the layout
 * (collision) and the renderer.
 */
export const nodeRadius = (degree: number): number =>
  Math.min(5 + Math.sqrt(degree) * 2.3, 24);

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Pinned while the user drags the node. */
  fixed: boolean;
  /** Collision radius, see `nodeRadius`. */
  radius: number;
  /** Repulsion strength; hubs push a little harder to make room for leaves. */
  charge: number;
  /** Unlinked notes are kept on a ring around the linked ones. */
  orphan: boolean;
  /** Position in `ForceLayout.nodes`; orders collision pairs cheaply. */
  index: number;
}

interface Quad {
  x0: number;
  y0: number;
  size: number;
  /** Summed charge of all nodes in the cell. */
  charge: number;
  cx: number;
  cy: number;
  /** Leaf content; more than one entry only for (nearly) coincident nodes. */
  nodes: LayoutNode[] | null;
  children: Array<Quad | null> | null;
}

/*
 * The forces follow d3-force semantics (many-body with Barnes–Hut, link with
 * degree bias, positional centering, collision, velocity decay), tuned like
 * Obsidian's graph: separated clusters, hubs in the middle of their leaves and
 * unlinked notes on a loose ring around the rest.
 */
const CHARGE = -170;
const LINK_DISTANCE = 44;
const CENTER = 0.045;
/** Unlinked notes sit on a ring this far outside the linked nodes. */
const ORPHAN_GAP = 50;
const ORPHAN_PULL = 0.3;
const ORPHAN_REPULSION = 0.08;
const COLLIDE_PADDING = 4;
const VELOCITY_DECAY = 0.42;
const THETA2 = 0.81;
/** Repulsion is ignored beyond this distance; keeps far components from drifting apart forever. */
const DISTANCE_MAX2 = 1200 * 1200;
const ALPHA_MIN = 0.002;
/** Like d3: about 300 ticks from a cold start to `ALPHA_MIN`. */
const ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300);
/** Largest step per tick, so a reheated layout never jumps. */
const MAX_SPEED = 60;

/**
 * Small d3-style force layout. Deterministic for the same input: starting
 * positions come from a phyllotaxis spiral and jitter from the node id.
 */
export class ForceLayout {
  nodes: LayoutNode[] = [];
  private byId = new Map<string, LayoutNode>();
  /** source, target, strength, bias towards moving the target. */
  private links: Array<[LayoutNode, LayoutNode, number, number]> = [];
  alpha = 1;
  /** Small graphs (a local graph) get longer links, so labels have room. */
  private spread = 1;
  /** The layout cools towards this instead of 0, e.g. while dragging. */
  alphaTarget = 0;

  /**
   * Replaces the graph. Nodes that already existed keep their position and new
   * ones start next to a placed neighbour, so live updates only nudge the
   * layout instead of restarting it.
   */
  setGraph(data: GraphData): void {
    const previous = this.byId;
    const neighbours = new Map<string, string[]>();
    for (const edge of data.edges) {
      (
        neighbours.get(edge.source) ??
        neighbours.set(edge.source, []).get(edge.source)!
      ).push(edge.target);
      (
        neighbours.get(edge.target) ??
        neighbours.set(edge.target, []).get(edge.target)!
      ).push(edge.source);
    }
    const degreeOf = (id: string) => neighbours.get(id)?.length ?? 0;
    this.byId = new Map();
    let kept = 0;
    for (const node of data.nodes) {
      const old = previous.get(node.id);
      if (!old) continue;
      old.fixed = false;
      this.byId.set(node.id, old);
      kept++;
    }
    const anchors = kept ? this.boundsOf([...this.byId.values()]) : null;
    for (const [i, node] of data.nodes.entries()) {
      if (this.byId.has(node.id)) continue;
      const created: LayoutNode = {
        id: node.id,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        fixed: false,
        radius: 0,
        charge: 0,
        orphan: false,
        index: 0,
      };
      const anchor = kept
        ? (neighbours.get(node.id) ?? [])
            .map((id) => this.byId.get(id))
            .find((other) => other)
        : undefined;
      const angle = (hash(node.id) % 628) / 100;
      if (anchor) {
        created.x = anchor.x + Math.cos(angle) * 30;
        created.y = anchor.y + Math.sin(angle) * 30;
      } else if (anchors) {
        // Unconnected newcomers start at the rim of the existing layout.
        const { x0, y0, x1, y1 } = anchors;
        const radius = Math.max(x1 - x0, y1 - y0) / 2 + 40;
        created.x = (x0 + x1) / 2 + Math.cos(angle) * radius;
        created.y = (y0 + y1) / 2 + Math.sin(angle) * radius;
      } else {
        // Phyllotaxis spiral (as in d3): evenly spread starting positions.
        const radius = 10 * Math.sqrt(i + 0.5);
        created.x = radius * Math.cos(i * 2.399963);
        created.y = radius * Math.sin(i * 2.399963);
      }
      this.byId.set(node.id, created);
    }
    this.spread = Math.min(2.2, Math.max(1, Math.sqrt(40 / data.nodes.length)));
    this.nodes = data.nodes.map((node, index) => {
      const layout = this.byId.get(node.id)!;
      layout.index = index;
      const degree = degreeOf(node.id);
      layout.radius = nodeRadius(degree);
      layout.charge = CHARGE * this.spread * (1 + Math.sqrt(degree) * 0.35);
      layout.orphan = !degree;
      return layout;
    });
    this.links = [];
    for (const edge of data.edges) {
      const a = this.byId.get(edge.source);
      const b = this.byId.get(edge.target);
      if (!a || !b) continue;
      const da = Math.max(1, degreeOf(edge.source));
      const db = Math.max(1, degreeOf(edge.target));
      // d3 defaults: hubs are held less tightly by each of their many links,
      // and the side with fewer links does most of the moving.
      this.links.push([a, b, 1 / Math.min(da, db), da / (da + db)]);
    }
    if (!kept) this.alpha = 1;
    else this.reheat(0.3);
  }

  get(id: string): LayoutNode | undefined {
    return this.byId.get(id);
  }

  get settled(): boolean {
    return this.alpha < ALPHA_MIN && this.alphaTarget < ALPHA_MIN;
  }

  reheat(alpha = 0.5): void {
    this.alpha = Math.max(this.alpha, alpha);
  }

  tick(): void {
    const nodes = this.nodes;
    if (!nodes.length) {
      this.alpha = 0;
      return;
    }
    this.alpha += (this.alphaTarget - this.alpha) * ALPHA_DECAY;
    const alpha = this.alpha;

    const linkDistance = LINK_DISTANCE * this.spread;
    for (const [source, target, strength, bias] of this.links) {
      let dx = target.x + target.vx - source.x - source.vx;
      let dy = target.y + target.vy - source.y - source.vy;
      if (!dx && !dy) {
        dx = jiggle(source.id);
        dy = jiggle(target.id);
      }
      const distance = Math.sqrt(dx * dx + dy * dy);
      const k = ((distance - linkDistance) / distance) * alpha * strength;
      dx *= k;
      dy *= k;
      target.vx -= dx * bias;
      target.vy -= dy * bias;
      source.vx += dx * (1 - bias);
      source.vy += dy * (1 - bias);
    }

    const root = this.buildTree();
    for (const node of nodes)
      // Orphans mostly answer to the ring; full repulsion from the whole
      // vault would push them far out and shrink everything else on fit.
      this.repel(root, node, node.orphan ? alpha * ORPHAN_REPULSION : alpha);

    for (const node of nodes) {
      if (node.orphan) continue;
      node.vx -= node.x * CENTER * alpha;
      node.vy -= node.y * CENTER * alpha;
    }
    this.ring(alpha);

    this.collide();

    for (const node of nodes) {
      if (node.fixed) {
        node.vx = node.vy = 0;
        continue;
      }
      node.vx *= 1 - VELOCITY_DECAY;
      node.vy *= 1 - VELOCITY_DECAY;
      const speed = Math.hypot(node.vx, node.vy);
      if (!Number.isFinite(speed)) {
        node.vx = node.vy = 0;
      } else if (speed > MAX_SPEED) {
        node.vx *= MAX_SPEED / speed;
        node.vy *= MAX_SPEED / speed;
      }
      node.x += node.vx;
      node.y += node.vy;
    }
  }

  /** Runs ticks until settled or the time budget (ms) is spent. */
  run(budget: number, now: () => number = () => performance.now()): void {
    const end = now() + budget;
    while (!this.settled && now() < end) this.tick();
  }

  bounds(): { x0: number; y0: number; x1: number; y1: number } {
    return this.boundsOf(this.nodes);
  }

  private boundsOf(nodes: LayoutNode[]): {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const node of nodes) {
      x0 = Math.min(x0, node.x);
      y0 = Math.min(y0, node.y);
      x1 = Math.max(x1, node.x);
      y1 = Math.max(y1, node.y);
    }
    if (!nodes.length) return { x0: -1, y0: -1, x1: 1, y1: 1 };
    return { x0, y0, x1, y1 };
  }

  private buildTree(): Quad {
    const { x0, y0, x1, y1 } = this.bounds();
    const size = Math.max(x1 - x0, y1 - y0, 1) + 1;
    const root = quad(x0, y0, size);
    for (const node of this.nodes) insert(root, node, 0);
    summarize(root);
    return root;
  }

  /** d3's many-body force: strength / distance, Barnes–Hut approximated. */
  private repel(cell: Quad, node: LayoutNode, alpha: number): void {
    if (!cell.charge) return;
    let dx = cell.cx - node.x;
    let dy = cell.cy - node.y;
    let d2 = dx * dx + dy * dy;
    if (cell.children) {
      if ((cell.size * cell.size) / THETA2 >= d2) {
        for (const child of cell.children)
          if (child) this.repel(child, node, alpha);
        return;
      }
      if (d2 >= DISTANCE_MAX2) return;
      if (d2 < 1) d2 = Math.sqrt(d2);
      const k = (cell.charge * alpha) / d2;
      node.vx += dx * k;
      node.vy += dy * k;
      return;
    }
    if (!cell.nodes || d2 >= DISTANCE_MAX2) return;
    for (const other of cell.nodes) {
      if (other === node) continue;
      dx = other.x - node.x;
      dy = other.y - node.y;
      if (!dx) dx = jiggle(node.id + other.id);
      if (!dy) dy = jiggle(other.id + node.id);
      d2 = dx * dx + dy * dy;
      if (d2 < 1) d2 = Math.sqrt(d2);
      const k = (other.charge * alpha) / d2;
      node.vx += dx * k;
      node.vy += dy * k;
    }
  }

  /**
   * Like Obsidian, notes without links float on a loose ring around the rest
   * instead of crowding the middle or drifting off.
   */
  private ring(alpha: number): void {
    let radius = 0;
    let orphans = 0;
    for (const node of this.nodes)
      if (node.orphan) orphans++;
      else radius = Math.max(radius, Math.hypot(node.x, node.y));
    if (!orphans) return;
    // Enough circumference for every orphan, even without linked nodes.
    radius = Math.max(
      radius + ORPHAN_GAP,
      (orphans * (nodeRadius(0) + COLLIDE_PADDING) * 2.5) / (2 * Math.PI),
    );
    for (const node of this.nodes) {
      if (!node.orphan) continue;
      const distance = Math.hypot(node.x, node.y) || 1;
      const k = ((radius - distance) / distance) * ORPHAN_PULL * alpha;
      node.vx += node.x * k;
      node.vy += node.y * k;
    }
  }

  /** Pushes overlapping circles apart, using a uniform grid for neighbours. */
  private collide(): void {
    let cell = 0;
    for (const node of this.nodes)
      cell = Math.max(cell, (node.radius + COLLIDE_PADDING) * 2);
    const grid = new Map<number, LayoutNode[]>();
    // Numeric cell keys; layouts stay far below 2^20 cells per axis.
    const keyOf = (gx: number, gy: number) => (gx + 0x80000) * 0x100000 + gy;
    for (const node of this.nodes) {
      const key = keyOf(Math.floor(node.x / cell), Math.floor(node.y / cell));
      (grid.get(key) ?? grid.set(key, []).get(key)!).push(node);
    }
    for (const node of this.nodes) {
      const gx = Math.floor(node.x / cell);
      const gy = Math.floor(node.y / cell);
      const ri = node.radius + COLLIDE_PADDING;
      for (let ix = gx - 1; ix <= gx + 1; ix++)
        for (let iy = gy - 1; iy <= gy + 1; iy++)
          for (const other of grid.get(keyOf(ix, iy)) ?? []) {
            if (other.index <= node.index) continue;
            const rj = other.radius + COLLIDE_PADDING;
            let dx = node.x + node.vx - other.x - other.vx;
            let dy = node.y + node.vy - other.y - other.vy;
            if (!dx) dx = jiggle(node.id + other.id);
            if (!dy) dy = jiggle(other.id + node.id);
            const r = ri + rj;
            const d2 = dx * dx + dy * dy;
            if (d2 >= r * r) continue;
            const d = Math.sqrt(d2);
            const push = ((r - d) / d) * 0.7;
            const share = (rj * rj) / (ri * ri + rj * rj);
            node.vx += dx * push * share;
            node.vy += dy * push * share;
            other.vx -= dx * push * (1 - share);
            other.vy -= dy * push * (1 - share);
          }
    }
  }
}

function hash(text: string): number {
  let value = 0;
  for (let i = 0; i < text.length; i++)
    value = (value * 31 + text.charCodeAt(i)) >>> 0;
  return value;
}

/** Tiny deterministic offset for coincident points (d3 uses Math.random). */
function jiggle(seed: string): number {
  // Never exactly 0, which would leave the points stacked.
  return (((hash(seed) % 1000) + 0.5) / 1000 - 0.5) * 1e-3;
}

function quad(x0: number, y0: number, size: number): Quad {
  return { x0, y0, size, charge: 0, cx: 0, cy: 0, nodes: null, children: null };
}

function insert(cell: Quad, node: LayoutNode, depth: number): void {
  if (!cell.children) {
    if (!cell.nodes) {
      cell.nodes = [node];
      return;
    }
    // Too deep means (nearly) coincident points; keep them as one leaf list.
    if (depth > 24) {
      cell.nodes.push(node);
      return;
    }
    const existing = cell.nodes;
    cell.nodes = null;
    cell.children = [null, null, null, null];
    for (const item of existing) insert(cell, item, depth);
  }
  const half = cell.size / 2;
  const right = node.x >= cell.x0 + half ? 1 : 0;
  const bottom = node.y >= cell.y0 + half ? 1 : 0;
  const slot = right + bottom * 2;
  let child = cell.children[slot];
  if (!child)
    cell.children[slot] = child = quad(
      cell.x0 + right * half,
      cell.y0 + bottom * half,
      half,
    );
  insert(child, node, depth + 1);
}

function summarize(cell: Quad): void {
  let charge = 0;
  let cx = 0;
  let cy = 0;
  if (cell.nodes) {
    for (const node of cell.nodes) {
      charge += node.charge;
      cx += node.x * node.charge;
      cy += node.y * node.charge;
    }
  } else if (cell.children) {
    for (const child of cell.children) {
      if (!child) continue;
      summarize(child);
      charge += child.charge;
      cx += child.cx * child.charge;
      cy += child.cy * child.charge;
    }
  }
  cell.charge = charge;
  cell.cx = charge ? cx / charge : 0;
  cell.cy = charge ? cy / charge : 0;
}
