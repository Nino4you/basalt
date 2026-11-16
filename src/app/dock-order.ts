/** Divides the actions at the top (or left) of the dock from those at its end. */
export const SPACER = "|";
/** All plugin ribbon icons, kept together as one entry. */
export const PLUGINS = "plugins";

/** The dock's actions by command id, in their default order. */
export const DEFAULT_DOCK_ORDER = [
  "quick-switcher",
  "daily-note",
  "command-palette",
  "open-graph",
  PLUGINS,
  SPACER,
  "toggle-theme",
  "settings",
];

/**
 * A stored order made usable: unknown entries go, missing ones come back at
 * their default place (before the spacer when they belong above it), and
 * there is exactly one spacer.
 */
export function normalizeDockOrder(stored: unknown): string[] {
  const known = new Set(DEFAULT_DOCK_ORDER);
  const order: string[] = [];
  if (Array.isArray(stored))
    for (const id of stored)
      if (typeof id === "string" && known.has(id) && !order.includes(id))
        order.push(id);
  for (const id of DEFAULT_DOCK_ORDER) {
    if (order.includes(id)) continue;
    const above =
      DEFAULT_DOCK_ORDER.indexOf(id) < DEFAULT_DOCK_ORDER.indexOf(SPACER);
    const spacer = order.indexOf(SPACER);
    if (above && spacer >= 0) order.splice(spacer, 0, id);
    else order.push(id);
  }
  return order;
}

/** The dock id of an action element: its command, or PLUGINS. */
export function dockItemId(el: Element): string | null {
  if (el.classList.contains("side-dock-plugins")) return PLUGINS;
  return (el as HTMLElement).dataset.command ?? null;
}

/**
 * Puts the dock's action buttons in `order`: those before the spacer into
 * the upper group, the rest into the end group.
 */
export function applyDockOrder(
  ribbon: HTMLElement,
  order: readonly string[],
): void {
  const upper = ribbon.querySelector<HTMLElement>(".side-dock-actions");
  const end = ribbon.querySelector<HTMLElement>(".side-dock-settings");
  if (!upper || !end) return;
  const items = new Map<string, HTMLElement>();
  for (const el of [...upper.children, ...end.children]) {
    const id = dockItemId(el);
    if (id) items.set(id, el as HTMLElement);
  }
  let target = upper;
  for (const id of order) {
    if (id === SPACER) target = end;
    else if (items.has(id)) target.append(items.get(id)!);
  }
}

/** The order the action buttons are in now, as `applyDockOrder` takes it. */
export function readDockOrder(ribbon: HTMLElement): string[] {
  const ids = (selector: string) =>
    [...(ribbon.querySelector(selector)?.children ?? [])]
      .map(dockItemId)
      .filter((id): id is string => !!id);
  return [...ids(".side-dock-actions"), SPACER, ...ids(".side-dock-settings")];
}
