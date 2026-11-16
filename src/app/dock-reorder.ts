import type { App } from "./app";
import { readDockOrder } from "./dock-order";
import type { DockPanelId } from "./shell";

/** A finger has to rest this long on an icon before it can be moved. */
export const LONG_PRESS = 350;
/** Movement that cancels a long press (a swipe) or starts a mouse drag. */
const SLOP = 8;

interface Reorder {
  item: HTMLElement;
  /** The icons it can trade places with, in screen order. */
  lane: () => HTMLElement[];
  pointerId: number;
  startX: number;
  startY: number;
  /** Where in the icon it was grabbed, along the dock. */
  grab: number;
  active: boolean;
  timer: number;
}

/**
 * Icons in the dock (the ribbon on desktops) are reordered by dragging:
 * a mouse drags right away, a finger after a long press, so taps and the
 * card swipes keep working. Views trade places with views, actions with
 * actions; an action can move between the upper and the end group. The
 * new order is saved when the icon is let go.
 */
export function installDockReorder(app: App, ribbon: HTMLElement): void {
  let state: Reorder | null = null;
  let swallowClick = false;
  const vertical = () => !app.dockAtBottom;
  const along = (rect: DOMRect) => (vertical() ? rect.top : rect.left);
  const size = (rect: DOMRect) => (vertical() ? rect.height : rect.width);
  const point = (event: PointerEvent) =>
    vertical() ? event.clientY : event.clientX;

  const lanes = {
    views: () => [
      ...ribbon.querySelectorAll<HTMLElement>(".side-dock-panels > .rail-item"),
    ],
    actions: () =>
      [
        ...ribbon.querySelectorAll<HTMLElement>(
          ".side-dock-actions > *, .side-dock-settings > *",
        ),
      ].filter((el) => !el.hidden),
  };

  const begin = () => {
    if (!state) return;
    state.active = true;
    document.body.classList.add("is-dock-reordering");
    state.item.classList.add("is-reordering");
    navigator.vibrate?.(12);
  };

  /** The icon follows the pointer; it swaps with a neighbour past its middle. */
  const follow = (event: PointerEvent) => {
    if (!state) return;
    const { item } = state;
    item.style.transform = "";
    const position = point(event) - state.grab;
    const lane = state.lane();
    const index = lane.indexOf(item);
    const before = lane[index - 1];
    const after = lane[index + 1];
    if (after) {
      const rect = after.getBoundingClientRect();
      if (
        position + size(item.getBoundingClientRect()) >
        along(rect) + size(rect) / 2
      )
        after.after(item);
    }
    if (before && lane.indexOf(item) === index) {
      const rect = before.getBoundingClientRect();
      if (position < along(rect) + size(rect) / 2) before.before(item);
    }
    // The icon stays within its group's stretch of the dock.
    const now = state.lane();
    const first = now[0].getBoundingClientRect();
    const last = now[now.length - 1].getBoundingClientRect();
    const own = item.getBoundingClientRect();
    const clamped = Math.max(
      along(first),
      Math.min(along(last) + size(last) - size(own), position),
    );
    const offset = clamped - along(own);
    item.style.transform = vertical()
      ? `translateY(${offset}px)`
      : `translateX(${offset}px)`;
  };

  const finish = (save: boolean) => {
    const current = state;
    state = null;
    if (!current) return;
    clearTimeout(current.timer);
    if (!current.active) return;
    current.item.classList.remove("is-reordering");
    current.item.style.transform = "";
    document.body.classList.remove("is-dock-reordering");
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 0);
    if (!save) {
      app.applyDockOrder();
      app.applyLayout();
      return;
    }
    if (current.item.classList.contains("rail-item"))
      app.setLeftViewOrder(
        lanes.views().map((el) => el.dataset.panel as DockPanelId),
      );
    else app.settings.set("dockOrder", readDockOrder(ribbon));
  };

  ribbon.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || state) return;
    const target = event.target as Element;
    const item = target.closest<HTMLElement>(
      ".side-dock-panels > .rail-item, .side-dock-actions > [data-command], .side-dock-settings > [data-command]",
    );
    if (!item) return;
    const lane = item.classList.contains("rail-item")
      ? lanes.views
      : lanes.actions;
    const rect = item.getBoundingClientRect();
    state = {
      item,
      lane,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grab: point(event) - along(rect),
      active: false,
      timer: 0,
    };
    if (event.pointerType !== "mouse")
      state.timer = window.setTimeout(begin, LONG_PRESS);
  });

  document.addEventListener(
    "pointermove",
    (event) => {
      if (!state || event.pointerId !== state.pointerId) return;
      const moved = Math.hypot(
        event.clientX - state.startX,
        event.clientY - state.startY,
      );
      if (!state.active) {
        if (moved < SLOP) return;
        // A finger that moves before the long press is a swipe, not a drag.
        if (event.pointerType !== "mouse") {
          finish(false);
          return;
        }
        begin();
      }
      event.preventDefault();
      follow(event);
    },
    { passive: false },
  );
  document.addEventListener("pointerup", (event) => {
    if (state?.pointerId === event.pointerId) finish(true);
  });
  document.addEventListener("pointercancel", (event) => {
    if (state?.pointerId === event.pointerId) finish(state.active);
  });
  // The click that ends a drag must not run the icon's action.
  ribbon.addEventListener(
    "click",
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  // Android turns a long press into a context menu; the drag owns it here.
  ribbon.addEventListener("contextmenu", (event) => {
    if (state || document.body.classList.contains("is-dock-reordering"))
      event.preventDefault();
  });
}
