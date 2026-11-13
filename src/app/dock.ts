/**
 * Dock layout model: which side panel lives in which dock area, in which
 * order, and which one is active there. Pure data so it can be persisted and
 * unit-tested without a DOM.
 */

export type DockArea = "left" | "left-bottom" | "right" | "bottom";

// Nested targets must win over their containing sidebar.
export const DOCK_AREAS: readonly DockArea[] = ["left-bottom", "left", "right", "bottom"];

export interface DockSlot {
  panels: string[];
  active: string | null;
}

export type DockLayout = Record<DockArea, DockSlot>;

export interface PanelSpec {
  id: string;
  label: string;
  icon: string;
  area: DockArea;
}

const isArea = (value: unknown): value is DockArea =>
  DOCK_AREAS.includes(value as DockArea);

/** Every panel in its default area, first panel of each area active. */
export function defaultDock(specs: readonly PanelSpec[]): DockLayout {
  const layout = emptyDock();
  for (const spec of specs) layout[spec.area].panels.push(spec.id);
  for (const area of DOCK_AREAS)
    layout[area].active = layout[area].panels[0] ?? null;
  return layout;
}

function emptyDock(): DockLayout {
  return {
    left: { panels: [], active: null },
    "left-bottom": { panels: [], active: null },
    right: { panels: [], active: null },
    bottom: { panels: [], active: null },
  };
}

/**
 * Turns persisted (possibly stale or corrupt) data into a valid layout:
 * unknown ids and duplicates are dropped, panels that are missing (e.g. added
 * in a newer version) are appended to their default area, and every area's
 * active panel is one it actually contains.
 */
export function normalizeDock(
  raw: unknown,
  specs: readonly PanelSpec[],
): DockLayout {
  const known = new Map(specs.map((spec) => [spec.id, spec]));
  const layout = emptyDock();
  const seen = new Set<string>();
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const area of DOCK_AREAS) {
    const slot = value[area];
    if (!slot || typeof slot !== "object") continue;
    const { panels, active } = slot as { panels?: unknown; active?: unknown };
    if (Array.isArray(panels))
      for (const id of panels)
        if (typeof id === "string" && known.has(id) && !seen.has(id)) {
          seen.add(id);
          layout[area].panels.push(id);
        }
    if (typeof active === "string") layout[area].active = active;
  }
  for (const spec of specs)
    if (!seen.has(spec.id)) layout[spec.area].panels.push(spec.id);
  for (const area of DOCK_AREAS) fixActive(layout[area]);
  return layout;
}

function fixActive(slot: DockSlot, fallbackIndex = 0): void {
  if (slot.active !== null && slot.panels.includes(slot.active)) return;
  slot.active =
    slot.panels[Math.min(fallbackIndex, slot.panels.length - 1)] ?? null;
}

export function areaOf(layout: DockLayout, id: string): DockArea | null {
  return DOCK_AREAS.find((area) => layout[area].panels.includes(id)) ?? null;
}

/**
 * Moves a panel to `index` in `area` (end when omitted) and makes it the
 * active panel there. The area it left falls back to a neighbouring panel.
 * Returns a new layout; the input is not modified.
 */
export function movePanel(
  layout: DockLayout,
  id: string,
  area: DockArea,
  index?: number,
): DockLayout {
  const next = cloneDock(layout);
  const from = areaOf(next, id);
  if (!from || !isArea(area)) return next;
  const source = next[from];
  const oldIndex = source.panels.indexOf(id);
  source.panels.splice(oldIndex, 1);
  const target = next[area];
  let at = index ?? target.panels.length;
  // Indices are given against the list as the user sees it, which still
  // contains the dragged panel when it stays in the same area.
  if (from === area && at > oldIndex) at -= 1;
  at = Math.max(0, Math.min(at, target.panels.length));
  target.panels.splice(at, 0, id);
  target.active = id;
  if (from !== area) {
    if (source.active === id) source.active = null;
    fixActive(source, Math.max(0, oldIndex - 1));
  }
  return next;
}

export function activatePanel(layout: DockLayout, id: string): DockLayout {
  const next = cloneDock(layout);
  const area = areaOf(next, id);
  if (area) next[area].active = id;
  return next;
}

/**
 * The layout as it is shown. Phones have no room for a bottom panel, so its
 * panels join the right drawer there; the stored layout keeps them at the
 * bottom for the next desktop session.
 */
export function effectiveDock(layout: DockLayout, mobile: boolean): DockLayout {
  const shown = cloneDock(layout);
  if (!mobile) return shown;
  const { bottom, right } = shown;
  shown.left.panels.push(...shown["left-bottom"].panels);
  if (shown.left.active === null) shown.left.active = shown["left-bottom"].active;
  shown["left-bottom"] = { panels: [], active: null };
  right.panels.push(...bottom.panels);
  if (right.active === null) right.active = bottom.active;
  shown.bottom = { panels: [], active: null };
  return shown;
}

export interface DockRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Screen geometry a panel drag is resolved against. */
export interface DockGeometry {
  /** Areas that are open right now: their whole box and their tab strip row. */
  open: Partial<Record<DockArea, { box: DockRect; strip: DockRect }>>;
  /** The editor region between the dock areas. */
  editor: DockRect;
  /** Width (left, right) or height (bottom) an area takes once it opens. */
  sizes: Record<DockArea, number>;
}

export interface DockDropTarget {
  area: DockArea;
  /**
   * `strip` inserts between the tabs of an open area, `area` appends to an
   * open area, `edge` opens a closed area from the editor's border.
   */
  kind: "strip" | "area" | "edge";
  /** What the drop overlay covers: where the panel is going to be. */
  rect: DockRect;
}

/** Largest share of the editor an edge target (and its preview) may cover. */
const EDGE_SHARE = 1 / 3;

const contains = (rect: DockRect, x: number, y: number) =>
  x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;

/**
 * Resolves a pointer position to the place a dragged panel would be docked,
 * the way VS Code does: open areas take the drop as a whole, and closed ones
 * are reached through the matching border of the editor, where the target is
 * exactly the strip the area is going to occupy. The sidebars run the full
 * height, so they win the lower corners over the bottom area.
 */
export function dropTargetAt(
  x: number,
  y: number,
  geometry: DockGeometry,
): DockDropTarget | null {
  for (const area of DOCK_AREAS) {
    const open = geometry.open[area];
    if (!open) continue;
    if (contains(open.strip, x, y))
      return { area, kind: "strip", rect: open.strip };
    if (contains(open.box, x, y)) return { area, kind: "area", rect: open.box };
  }
  const { editor, sizes } = geometry;
  if (!contains(editor, x, y)) return null;
  const edge = (area: DockArea, extent: number) =>
    Math.max(0, Math.min(sizes[area], extent * EDGE_SHARE));
  const width = editor.right - editor.left;
  const height = editor.bottom - editor.top;
  if (!geometry.open.left) {
    const right = editor.left + edge("left", width);
    if (x < right)
      return { area: "left", kind: "edge", rect: { ...editor, right } };
  }
  if (!geometry.open.right) {
    const left = editor.right - edge("right", width);
    if (x >= left)
      return { area: "right", kind: "edge", rect: { ...editor, left } };
  }
  if (!geometry.open.bottom) {
    const top = editor.bottom - edge("bottom", height);
    if (y >= top)
      return { area: "bottom", kind: "edge", rect: { ...editor, top } };
  }
  return null;
}

export function cloneDock(layout: DockLayout): DockLayout {
  return {
    left: { panels: [...layout.left.panels], active: layout.left.active },
    "left-bottom": {
      panels: [...layout["left-bottom"].panels],
      active: layout["left-bottom"].active,
    },
    right: { panels: [...layout.right.panels], active: layout.right.active },
    bottom: {
      panels: [...layout.bottom.panels],
      active: layout.bottom.active,
    },
  };
}

/**
 * The layout without the panels the user closed. Closed panels keep their
 * place in the stored layout so that reopening puts them back where they
 * were; an area whose active panel was closed falls back to the panel before
 * it (or the first one).
 */
export function withoutPanels(
  layout: DockLayout,
  closed: readonly string[],
): DockLayout {
  const next = cloneDock(layout);
  if (closed.length === 0) return next;
  for (const area of DOCK_AREAS) {
    const slot = next[area];
    const activeIndex =
      slot.active === null ? 0 : slot.panels.indexOf(slot.active);
    const before = slot.panels
      .slice(0, Math.max(0, activeIndex))
      .filter((id) => !closed.includes(id)).length;
    slot.panels = slot.panels.filter((id) => !closed.includes(id));
    if (slot.active !== null && closed.includes(slot.active)) slot.active = null;
    fixActive(slot, Math.max(0, before - 1));
  }
  return next;
}
