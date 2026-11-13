/**
 * Editor split layout: a tree whose leaves are editor groups and whose
 * branches lay their children out in a row or a column, as in VS Code. Pure
 * data so it can be persisted and unit-tested without a DOM.
 */

export type SplitDirection = "row" | "column";
export type SplitSide = "left" | "right" | "top" | "bottom";

export interface SplitLeaf {
  group: number;
}

export interface SplitBranch {
  direction: SplitDirection;
  children: SplitNode[];
  /** Relative share of each child along `direction`; any positive scale. */
  sizes: number[];
}

export type SplitNode = SplitLeaf | SplitBranch;

export const isLeaf = (node: SplitNode): node is SplitLeaf => "group" in node;

const directionOf = (side: SplitSide): SplitDirection =>
  side === "left" || side === "right" ? "row" : "column";

const isBefore = (side: SplitSide) => side === "left" || side === "top";

/** Group ids in reading order: left to right, top to bottom. */
export function groupIds(node: SplitNode): number[] {
  return isLeaf(node) ? [node.group] : node.children.flatMap(groupIds);
}

/**
 * Puts `added` next to `target` on the given side. The two share the room
 * the target had; a neighbour in the same direction joins the existing
 * row or column instead of nesting. Returns a new tree.
 */
export function splitGroup(
  root: SplitNode,
  target: number,
  side: SplitSide,
  added: number,
): SplitNode {
  const direction = directionOf(side);
  const pair = (leaf: SplitLeaf): SplitNode[] =>
    isBefore(side) ? [{ group: added }, leaf] : [leaf, { group: added }];
  const visit = (node: SplitNode): SplitNode => {
    if (isLeaf(node))
      return node.group === target
        ? { direction, children: pair(node), sizes: [1, 1] }
        : node;
    const at = node.children.findIndex(
      (child) => isLeaf(child) && child.group === target,
    );
    if (at >= 0 && node.direction === direction) {
      const half = node.sizes[at] / 2;
      const children = [...node.children];
      const sizes = [...node.sizes];
      children.splice(at, 1, ...pair(node.children[at] as SplitLeaf));
      sizes.splice(at, 1, half, half);
      return { direction, children, sizes };
    }
    return { ...node, children: node.children.map(visit) };
  };
  return visit(root);
}

/**
 * Removes a group; its siblings take over its room and branches left with a
 * single child dissolve. Returns null when the last group is removed.
 */
export function removeGroup(root: SplitNode, group: number): SplitNode | null {
  if (isLeaf(root)) return root.group === group ? null : root;
  const children: SplitNode[] = [];
  const sizes: number[] = [];
  root.children.forEach((child, index) => {
    const kept = removeGroup(child, group);
    if (!kept) return;
    // A nested branch of the same direction would be a pointless level.
    if (!isLeaf(kept) && kept.direction === root.direction) {
      const total = kept.sizes.reduce((sum, size) => sum + size, 0) || 1;
      kept.children.forEach((inner, i) => {
        children.push(inner);
        sizes.push((root.sizes[index] * kept.sizes[i]) / total);
      });
    } else {
      children.push(kept);
      sizes.push(root.sizes[index]);
    }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  return { direction: root.direction, children, sizes };
}

/** The group in the top left or top right corner, where the window buttons sit. */
export function cornerGroup(node: SplitNode, corner: "left" | "right"): number {
  if (isLeaf(node)) return node.group;
  const last = node.direction === "row" && corner === "right";
  return cornerGroup(
    node.children[last ? node.children.length - 1 : 0],
    corner,
  );
}

/** Where a drop at (x, y) inside `rect` goes: an outer third splits, the middle joins. */
export function dropSideAt(
  x: number,
  y: number,
  rect: { left: number; top: number; right: number; bottom: number },
): SplitSide | "center" {
  const fx = (x - rect.left) / Math.max(1, rect.right - rect.left);
  const fy = (y - rect.top) / Math.max(1, rect.bottom - rect.top);
  const edges: Array<[number, SplitSide]> = [
    [fx, "left"],
    [1 - fx, "right"],
    [fy, "top"],
    [1 - fy, "bottom"],
  ];
  const [distance, side] = edges.reduce((a, b) => (b[0] < a[0] ? b : a));
  return distance < 1 / 3 ? side : "center";
}

/** The half of `rect` a split on `side` is going to occupy. */
export function sideRect<
  R extends { left: number; top: number; right: number; bottom: number },
>(rect: R, side: SplitSide | "center"): R {
  const midX = (rect.left + rect.right) / 2;
  const midY = (rect.top + rect.bottom) / 2;
  if (side === "left") return { ...rect, right: midX };
  if (side === "right") return { ...rect, left: midX };
  if (side === "top") return { ...rect, bottom: midY };
  if (side === "bottom") return { ...rect, top: midY };
  return rect;
}

/**
 * Turns persisted (possibly stale or corrupt) data into a valid tree over
 * exactly the groups `0 … count-1`: unknown and repeated groups are dropped
 * and missing ones are appended to the right.
 */
export function normalizeSplit(raw: unknown, count: number): SplitNode {
  const seen = new Set<number>();
  const visit = (value: unknown, depth: number): SplitNode | null => {
    if (!value || typeof value !== "object" || depth > 16) return null;
    const node = value as Record<string, unknown>;
    if (typeof node.group === "number") {
      const group = node.group;
      if (!Number.isInteger(group) || group < 0 || group >= count) return null;
      if (seen.has(group)) return null;
      seen.add(group);
      return { group };
    }
    if (!Array.isArray(node.children)) return null;
    const direction: SplitDirection =
      node.direction === "column" ? "column" : "row";
    const rawSizes = Array.isArray(node.sizes) ? node.sizes : [];
    const children: SplitNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, index) => {
      const kept = visit(child, depth + 1);
      if (!kept) return;
      const size: unknown = rawSizes[index];
      children.push(kept);
      sizes.push(
        typeof size === "number" && Number.isFinite(size) && size > 0
          ? size
          : 1,
      );
    });
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    return { direction, children, sizes };
  };
  let root = visit(raw, 0);
  for (let group = 0; group < count; group++) {
    if (seen.has(group)) continue;
    if (!root) root = { group };
    else if (!isLeaf(root) && root.direction === "row")
      root = {
        ...root,
        children: [...root.children, { group }],
        sizes: [...root.sizes, 1],
      };
    else
      root = { direction: "row", children: [root, { group }], sizes: [1, 1] };
  }
  return root ?? { group: 0 };
}

/** Rewrites group ids, e.g. between runtime ids and persisted indices. */
export function mapGroups(
  node: SplitNode,
  map: (group: number) => number,
): SplitNode {
  return isLeaf(node)
    ? { group: map(node.group) }
    : {
        direction: node.direction,
        children: node.children.map((child) => mapGroups(child, map)),
        sizes: [...node.sizes],
      };
}
