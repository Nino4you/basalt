import { topModal } from "../ui/modal";
import type { App } from "./app";
import type { Shell } from "./shell";

type Side = "left" | "right";

/** A release faster than this (px/ms) decides the direction on its own. */
const FLING = 0.35;
/** A pause (ms) before lifting the finger that cancels its speed. */
const REST = 100;
/** Movement before a touch counts as a horizontal drag rather than a scroll. */
const SLOP = 8;
/** Elements that belong to a card although they are not inside it. */
const OVERLAYS =
  ".menu, .modal-container, .suggestion-container, .popover, .tooltip, .notice-container, .workspace-ribbon";

interface Drag {
  side: Side;
  /** The card was closed when the finger came down. */
  opening: boolean;
  el: HTMLElement;
  startX: number;
  startY: number;
  /** Sideways cards move along x; the card above the bottom dock along y. */
  axis: "x" | "y";
  /** null until the gesture is known to run along the axis (true) or not. */
  horizontal: boolean | null;
  /** How far the card travels between closed and open. */
  distance: number;
  offset: number;
  lastX: number;
  lastY: number;
  lastTime: number;
  /** px/ms towards opening; positive opens. */
  velocity: number;
}

/**
 * Tablet sidebar cards follow the finger: drag one out of the rail (left)
 * or the screen edge (right), or drag an open card back; the card above a
 * bottom dock is pulled down by its header. On release the
 * speed decides, otherwise whether it is more than half open. A tap beside
 * an open card closes it and still reaches what it was aimed at.
 */
export function installSheetGestures(app: App, shell: Shell): void {
  let drag: Drag | null = null;
  const split = (side: Side) =>
    side === "left" ? shell.leftSplit : shell.rightSplit;
  const visible = (side: Side) =>
    side === "left" ? app.leftVisible : app.rightVisible;

  document.addEventListener(
    "touchstart",
    (event) => {
      drag = null;
      if (event.touches.length !== 1 || !app.isTablet || topModal()) return;
      const touch = event.touches[0];
      const target = event.target as Node;
      const floats = app.floatingSides;
      let side: Side | null = null;
      let opening = false;
      // Above the bottom dock the left card moves down, by its header only:
      // the list inside it scrolls vertically.
      const popup = app.dockAtBottom;
      for (const candidate of ["left", "right"] as const)
        if (
          floats[candidate] &&
          visible(candidate) &&
          split(candidate).contains(target)
        )
          side = candidate;
      if (
        side === "left" &&
        popup &&
        !(target instanceof Element && target.closest(".sheet-header"))
      )
        return;
      if (!side) {
        opening = true;
        if (
          floats.left &&
          !popup &&
          !visible("left") &&
          touch.clientX < app.railWidth + 20
        )
          side = "left";
        else if (
          floats.right &&
          !visible("right") &&
          touch.clientX > window.innerWidth - 24
        )
          side = "right";
      }
      if (!side) return;
      const el = split(side);
      const rect = el.getBoundingClientRect();
      const axis = side === "left" && popup ? "y" : "x";
      // The closed card sits beyond the rail (left), the screen edge, or
      // (above the bottom dock) down where it disappears.
      const distance =
        axis === "y"
          ? rect.height
          : side === "left"
            ? rect.width + app.railWidth + 16
            : rect.width + 16;
      drag = {
        side,
        opening,
        el,
        startX: touch.clientX,
        startY: touch.clientY,
        axis,
        horizontal: null,
        distance,
        offset: 0,
        lastX: touch.clientX,
        lastY: touch.clientY,
        lastTime: event.timeStamp,
        velocity: 0,
      };
    },
    { passive: true },
  );

  document.addEventListener(
    "touchmove",
    (event) => {
      if (!drag) return;
      // Icons being reordered in the dock own the finger.
      if (document.body.classList.contains("is-dock-reordering")) {
        drag = null;
        return;
      }
      const touch = event.touches[0];
      const dx = touch.clientX - drag.startX;
      const dy = touch.clientY - drag.startY;
      const along = drag.axis === "x" ? dx : dy;
      const across = drag.axis === "x" ? dy : dx;
      if (drag.horizontal === null) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        drag.horizontal = Math.abs(along) > Math.abs(across) * 1.2;
        if (!drag.horizontal) {
          drag = null;
          return;
        }
        drag.el.classList.add("is-dragging");
      }
      const { side, opening, distance } = drag;
      const elapsed = Math.max(1, event.timeStamp - drag.lastTime);
      if (drag.axis === "y") {
        // Only downwards, towards the dock.
        drag.offset = Math.max(0, Math.min(distance, dy));
        drag.el.style.transform = `translateY(${drag.offset}px)`;
        drag.velocity = -(touch.clientY - drag.lastY) / elapsed;
        drag.lastY = touch.clientY;
        drag.lastTime = event.timeStamp;
        return;
      }
      // Offset from the open position: negative is towards the left.
      const raw =
        side === "left"
          ? (opening ? -distance : 0) + dx
          : (opening ? distance : 0) + dx;
      drag.offset =
        side === "left"
          ? Math.min(0, Math.max(-distance, raw))
          : Math.max(0, Math.min(distance, raw));
      drag.el.style.transform = `translateX(${drag.offset}px)`;
      const step = (touch.clientX - drag.lastX) / elapsed;
      drag.velocity = side === "left" ? step : -step;
      drag.lastX = touch.clientX;
      drag.lastTime = event.timeStamp;
    },
    { passive: true },
  );

  const finish = (event: TouchEvent) => {
    const current = drag;
    drag = null;
    if (!current?.horizontal) return;
    // A finger that came to rest before lifting has no fling left.
    if (event.timeStamp - current.lastTime > REST) current.velocity = 0;
    const openness = 1 - Math.abs(current.offset) / current.distance;
    const open =
      current.velocity > FLING
        ? true
        : current.velocity < -FLING
          ? false
          : openness > 0.5;
    // Hand the card back to the stylesheet; its transition finishes the move.
    current.el.classList.remove("is-dragging");
    void current.el.offsetWidth;
    current.el.style.transform = "";
    if (current.side === "left") app.toggleLeft(open);
    else app.toggleRight(open);
  };
  document.addEventListener("touchend", finish, { passive: true });
  document.addEventListener("touchcancel", finish, { passive: true });

  // A tap beside an open card closes it without swallowing the tap.
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!app.isTablet || topModal()) return;
      const target = event.target as Element | null;
      if (!target || target.closest(OVERLAYS)) return;
      const floats = app.floatingSides;
      for (const side of ["left", "right"] as const)
        if (floats[side] && visible(side) && !split(side).contains(target)) {
          if (side === "left") app.toggleLeft(false);
          else app.toggleRight(false);
        }
    },
    true,
  );
}
