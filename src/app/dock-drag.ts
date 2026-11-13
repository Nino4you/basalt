/**
 * Drag & drop of tabs, modelled on VS Code: the dragged tab becomes a small
 * label under the pointer, tab strips show an insertion line, and one
 * translucent overlay previews the area a panel is about to be docked into.
 * Targets are resolved from the pointer position (see `dropTargetAt`), not
 * from the element under it, so nothing in the editor can swallow a drop.
 */
import { h } from "../ui/dom";
import {
  DOCK_AREAS,
  type DockArea,
  type DockGeometry,
  type DockRect,
  dropTargetAt,
} from "./dock";

const PANEL_MIME = "application/x-basalt-panel";
const TAB = ".workspace-tab-header";

const dropLine = h("div", {
  class: "tab-drop-indicator",
  attrs: { "aria-hidden": "true" },
});
const overlay = h("div", {
  class: "dock-drop-overlay",
  attrs: { "aria-hidden": "true" },
});

/** A plain copy: DOMRect keeps its values on the prototype, so it cannot be spread. */
export function rectOf(el: HTMLElement): DockRect {
  const { left, top, right, bottom } = el.getBoundingClientRect();
  return { left, top, right, bottom };
}

const tabsOf = (strip: HTMLElement) => [
  ...strip.querySelectorAll<HTMLElement>(TAB),
];

/** Index of the tab boundary closest to the pointer. */
export function insertionIndex(strip: HTMLElement, x: number): number {
  const tabs = tabsOf(strip);
  const at = tabs.findIndex((tab) => {
    const box = tab.getBoundingClientRect();
    return x < box.left + box.width / 2;
  });
  return at === -1 ? tabs.length : at;
}

/** Places the insertion line between two tabs; fixed so strips cannot clip it. */
export function showDropLine(strip: HTMLElement, index: number): void {
  if (!dropLine.isConnected) document.body.append(dropLine);
  const tabs = tabsOf(strip);
  const box = strip.getBoundingClientRect();
  const before = tabs[index];
  const rect = (before ?? tabs[tabs.length - 1])?.getBoundingClientRect();
  const x = rect ? (before ? rect.left : rect.right) : box.left + 8;
  Object.assign(dropLine.style, {
    left: `${Math.min(Math.max(x - 1, box.left), box.right - 2)}px`,
    top: `${box.top}px`,
    height: `${box.height}px`,
  });
  dropLine.classList.add("is-visible");
}

export function hideDropLine(): void {
  dropLine.classList.remove("is-visible");
}

/**
 * Uses a floating label (icon and name) as the drag image instead of the
 * browser's snapshot of the tab. Must be called from `dragstart`.
 */
export function setDragLabel(
  event: DragEvent,
  source: HTMLElement,
  label: string,
): void {
  if (!event.dataTransfer) return;
  const chip = h(
    "div",
    "tab-drag-image",
    source.querySelector(".svg-icon")?.cloneNode(true),
    h("span", { text: label }),
  );
  document.body.append(chip);
  event.dataTransfer.setDragImage(chip, 12, chip.offsetHeight / 2);
  // The browser snapshots the image right after dragstart returns.
  requestAnimationFrame(() => chip.remove());
}

/**
 * Shows the drop preview over `rect`. `tags` end up as data attributes, so
 * styles and tests can tell what the preview stands for.
 */
export function showDropOverlay(
  rect: DockRect,
  tags: { dockArea?: string; dropSide?: string },
): void {
  Object.assign(overlay.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.right - rect.left}px`,
    height: `${rect.bottom - rect.top}px`,
  });
  delete overlay.dataset.dockArea;
  delete overlay.dataset.dropSide;
  Object.assign(overlay.dataset, tags);
  if (!overlay.isConnected) document.body.append(overlay);
  if (overlay.classList.contains("is-visible")) return;
  // Commit the position first, so the overlay fades in where it belongs
  // instead of sliding over from the previous target.
  void overlay.offsetWidth;
  overlay.classList.add("is-visible");
}

export function hideDropOverlay(): void {
  overlay.classList.remove("is-visible");
}

export interface PanelDragHost {
  /** Per area: its whole box, the header row and the element holding the tabs. */
  areas: Record<
    DockArea,
    { box: HTMLElement; strip: HTMLElement; tabs: HTMLElement }
  >;
  /** The editor region whose borders open closed areas. */
  editor: HTMLElement;
  isOpen(area: DockArea): boolean;
  /** Width or height the area takes once it is open. */
  size(area: DockArea): number;
  drop(panel: string, area: DockArea, index?: number): void;
}

/** Makes panel tabs (`[data-panel]`) dockable by drag & drop. */
export function installPanelDrag(host: PanelDragHost): void {
  document.body.append(dropLine, overlay);
  let dragged: string | null = null;

  const geometry = (): DockGeometry => {
    const open: DockGeometry["open"] = {};
    for (const area of DOCK_AREAS) {
      if (!host.isOpen(area)) continue;
      const box = rectOf(host.areas[area].box);
      const strip = rectOf(host.areas[area].strip);
      open[area] = {
        box,
        // The whole header row counts, including the space after the last tab.
        strip: {
          left: box.left,
          right: box.right,
          top: strip.top,
          bottom: strip.bottom,
        },
      };
    }
    return {
      open,
      editor: rectOf(host.editor),
      sizes: {
        left: host.size("left"),
        "left-bottom": host.size("left-bottom"),
        right: host.size("right"),
        bottom: host.size("bottom"),
      },
    };
  };
  const targetAt = (event: DragEvent) =>
    dropTargetAt(event.clientX, event.clientY, geometry());
  const clear = () => {
    hideDropOverlay();
    hideDropLine();
  };
  const end = () => {
    dragged = null;
    clear();
    document.body.classList.remove("is-dragging-panel");
    for (const el of document.querySelectorAll(
      `${TAB}[data-panel].is-dragging`,
    ))
      el.classList.remove("is-dragging");
  };

  document.addEventListener("dragstart", (event) => {
    const tab = (event.target as Element).closest?.<HTMLElement>(
      `${TAB}[data-panel]`,
    );
    if (!tab || !event.dataTransfer) return;
    const id = tab.dataset.panel!;
    dragged = id;
    event.dataTransfer.setData(PANEL_MIME, id);
    event.dataTransfer.effectAllowed = "move";
    setDragLabel(event, tab, tab.getAttribute("aria-label") ?? "");
    // Dim the source only after the browser has taken the drag image.
    requestAnimationFrame(() => {
      if (dragged !== id) return;
      tab.classList.add("is-dragging");
      document.body.classList.add("is-dragging-panel");
    });
  });
  const over = (event: DragEvent) => {
    if (!dragged) return;
    const target = targetAt(event);
    if (!target) {
      clear();
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (target.kind === "strip") {
      const { tabs } = host.areas[target.area];
      hideDropOverlay();
      showDropLine(tabs, insertionIndex(tabs, event.clientX));
    } else {
      hideDropLine();
      showDropOverlay(target.rect, { dockArea: target.area });
    }
  };
  // Capturing, so views that handle drags themselves cannot hide a target.
  document.addEventListener("dragenter", over, true);
  document.addEventListener("dragover", over, true);
  document.addEventListener(
    "drop",
    (event) => {
      if (!dragged) return;
      const id = dragged;
      const target = targetAt(event);
      const index =
        target?.kind === "strip"
          ? insertionIndex(host.areas[target.area].tabs, event.clientX)
          : undefined;
      end();
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      host.drop(id, target.area, index);
    },
    true,
  );
  document.addEventListener("dragend", end);
  // A canceled drag can skip dragend (for example outside the window).
  window.addEventListener("blur", end);
  // Leaving the window hides the preview but keeps the drag alive.
  document.addEventListener("dragleave", (event) => {
    // Chromium leaves relatedTarget empty between elements too, so go by the
    // position: only a pointer on or beyond the viewport border has left.
    const { clientX: x, clientY: y } = event;
    const outside =
      x <= 0 || y <= 0 || x >= window.innerWidth || y >= window.innerHeight;
    if (dragged && !event.relatedTarget && outside) clear();
  });
}
