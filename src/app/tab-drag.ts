/**
 * Drag & drop of editor tabs between and around editor groups, as in VS Code:
 * a tab strip takes the tab at the insertion line, the middle of a group
 * moves the tab into it, and the outer thirds split the group on that side.
 */
import {
  hideDropLine,
  hideDropOverlay,
  insertionIndex,
  rectOf,
  setDragLabel,
  showDropLine,
  showDropOverlay,
} from "./dock-drag";
import type { DockRect } from "./dock";
import { dropSideAt, sideRect, type SplitSide } from "./split";

const TAB = ".workspace-tab-header[data-tab-id]";

export type TabDropTarget =
  | { group: number; kind: "strip"; index: number }
  | { group: number; kind: "group" }
  | { group: number; kind: "split"; side: SplitSide };

export interface TabDragGroup {
  id: number;
  /** The whole group: tab strip and view. */
  el: HTMLElement;
  /** The tab strip row. */
  strip: HTMLElement;
  /** The element holding the tabs. */
  tabs: HTMLElement;
  /** Number of tabs in the group. */
  count: number;
}

export interface TabDragHost {
  /** Groups that take drops; empty where tabs cannot be rearranged. */
  groups(): TabDragGroup[];
  /** Label and group of the tab with this id, or null if it is gone. */
  tab(id: string): { label: string; group: number; path: string | null } | null;
  drop(id: string, target: TabDropTarget): void;
}

export function installTabDrag(host: TabDragHost): void {
  let dragged: string | null = null;

  const clear = () => {
    hideDropOverlay();
    hideDropLine();
  };
  const end = () => {
    if (!dragged) return;
    dragged = null;
    clear();
    for (const el of document.querySelectorAll(`${TAB}.is-dragging`))
      el.classList.remove("is-dragging");
  };
  /** The target under the pointer, and the preview that stands for it. */
  const resolve = (
    event: DragEvent,
  ): { target: TabDropTarget; strip: HTMLElement; rect: DockRect } | null => {
    const source = dragged ? host.tab(dragged) : null;
    if (!source) return null;
    const { clientX: x, clientY: y } = event;
    for (const group of host.groups()) {
      const box = rectOf(group.el);
      if (x < box.left || x >= box.right || y < box.top || y >= box.bottom)
        continue;
      const strip = rectOf(group.strip);
      if (y < strip.bottom)
        return {
          target: {
            group: group.id,
            kind: "strip",
            index: insertionIndex(group.tabs, x),
          },
          strip: group.tabs,
          rect: strip,
        };
      const body = { ...box, top: strip.bottom };
      const side = dropSideAt(x, y, body);
      const own = group.id === source.group;
      // Nothing changes by dropping a tab on its own group, or by splitting
      // off the only tab of a group next to itself.
      if (own && (side === "center" || group.count < 2)) return null;
      return {
        target:
          side === "center"
            ? { group: group.id, kind: "group" }
            : { group: group.id, kind: "split", side },
        strip: group.tabs,
        rect: sideRect(body, side),
      };
    }
    return null;
  };

  document.addEventListener("dragstart", (event) => {
    const el = (event.target as Element).closest?.<HTMLElement>(TAB);
    const id = el?.dataset.tabId;
    const tab = id ? host.tab(id) : null;
    if (!el || !id || !tab || !event.dataTransfer) return;
    dragged = id;
    event.dataTransfer.setData("text/plain", tab.path ?? "");
    event.dataTransfer.effectAllowed = "move";
    setDragLabel(event, el, tab.label);
    // Dim the source only after the browser has taken the drag image.
    requestAnimationFrame(() => {
      if (dragged === id) el.classList.add("is-dragging");
    });
  });
  const over = (event: DragEvent) => {
    if (!dragged) return;
    const hit = resolve(event);
    if (!hit) {
      clear();
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const { target } = hit;
    if (target.kind === "strip") {
      hideDropOverlay();
      showDropLine(hit.strip, target.index);
    } else {
      hideDropLine();
      showDropOverlay(hit.rect, {
        dropSide: target.kind === "split" ? target.side : "center",
      });
    }
  };
  // Capturing, so the editor cannot take the drop as inserted text.
  document.addEventListener("dragenter", over, true);
  document.addEventListener("dragover", over, true);
  document.addEventListener(
    "drop",
    (event) => {
      if (!dragged) return;
      const id = dragged;
      const hit = resolve(event);
      end();
      // Never let a dragged tab fall through as text into the editor.
      event.preventDefault();
      event.stopPropagation();
      if (hit) host.drop(id, hit.target);
    },
    true,
  );
  document.addEventListener("dragend", end);
  window.addEventListener("blur", end);
}
