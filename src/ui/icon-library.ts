import type { IconNode } from "lucide";
import { hostIcons } from "./icon-set";

/** Lucide export name (`Trash2`) per icon id (`trash-2`, also `trash2`). */
let library: Map<string, IconNode> | null = null;
let loading: Promise<void> | null = null;

const kebab = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();

const pascal = (id: string) =>
  id.replace(/(^|-)([a-z0-9])/g, (_, __, ch: string) => ch.toUpperCase());

/**
 * Loads the full Lucide set (about 1,500 icons) into its own chunk. Plugins
 * call `setIcon` synchronously with arbitrary ids, so the compatibility
 * session awaits this before any plugin code runs; the host UI never needs it.
 */
export function loadIconLibrary(): Promise<void> {
  loading ??= import("lucide").then(({ icons }) => {
    const ids = new Map<string, IconNode>();
    for (const [name, node] of Object.entries(
      icons as Record<string, IconNode>,
    )) {
      const id = kebab(name);
      ids.set(id, node);
      // Lucide exports `Trash2` for the id `trash-2`, so digits need their own alias.
      const digits = id.replace(/([a-z])(\d)/, "$1-$2");
      if (!ids.has(digits)) ids.set(digits, node);
    }
    library = ids;
  });
  return loading;
}

/** Whether `loadIconLibrary` has finished; before that only host icons resolve. */
export function iconLibraryLoaded(): boolean {
  return library !== null;
}

/** Looks up a Lucide icon by id; host icons always, the rest once loaded. */
export function findIcon(id: string): IconNode | undefined {
  return library?.get(id) ?? hostIcons[pascal(id)];
}

/** Every known Lucide id; only the host subset until the library is loaded. */
export function iconIds(): string[] {
  if (library) return [...library.keys()];
  return Object.keys(hostIcons).map(kebab);
}
