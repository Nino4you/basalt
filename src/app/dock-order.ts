import { t } from "../i18n";

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

/** Without these the app could not be reached or set up again. */
export const ALWAYS_SHOWN = new Set([SPACER, "settings"]);

export function dockItemLabel(id: string): string {
  switch (id) {
    case "quick-switcher":
      return t("Schnellauswahl öffnen");
    case "daily-note":
      return t("Heutige Tagesnotiz öffnen");
    case "command-palette":
      return t("Befehlspalette öffnen");
    case "open-graph":
      return t("Graphansicht öffnen");
    case PLUGINS:
      return t("Plugin-Symbole");
    case "toggle-theme":
      return t("Farbschema wechseln");
    case "settings":
      return t("Einstellungen");
    case SPACER:
      return t("Abstand: was darunter steht, sitzt am Ende der Leiste");
    default:
      return id;
  }
}

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

/** Moves `id` one place up (-1) or down (+1); the list is returned as a copy. */
export function moveItem<T>(list: readonly T[], item: T, delta: -1 | 1): T[] {
  const result = [...list];
  const index = result.indexOf(item);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= result.length) return result;
  [result[index], result[target]] = [result[target], result[index]];
  return result;
}

/**
 * Puts the dock's action buttons in `order`: those before the spacer into
 * the upper group, the rest into the end group; hidden ones are hidden.
 */
export function applyDockOrder(
  ribbon: HTMLElement,
  order: readonly string[],
  hidden: readonly string[],
): void {
  const upper = ribbon.querySelector<HTMLElement>(".side-dock-actions");
  const end = ribbon.querySelector<HTMLElement>(".side-dock-settings");
  if (!upper || !end) return;
  const element = (id: string) =>
    id === PLUGINS
      ? ribbon.querySelector<HTMLElement>(".side-dock-plugins")
      : ribbon.querySelector<HTMLElement>(
          `.side-dock-actions > [data-command="${id}"], .side-dock-settings > [data-command="${id}"]`,
        );
  let target = upper;
  for (const id of order) {
    if (id === SPACER) {
      target = end;
      continue;
    }
    const el = element(id);
    if (!el) continue;
    target.append(el);
    el.hidden = hidden.includes(id) && !ALWAYS_SHOWN.has(id);
  }
}
