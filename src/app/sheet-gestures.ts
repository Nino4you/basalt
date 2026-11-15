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
  /** null until the gesture is known to be horizontal (true) or not. */
  horizontal: boolean | null;
  /** How far the card travels between closed and open. */
  distance: number;
  offset: number;
  lastX: number;
  lastTime: number;
  /** px/ms towards opening; positive opens. */
  velocity: number;
}

/**
 * Tablet sidebar cards follow the finger: drag one out of the rail (left)
 * or the screen edge (right), or drag an open card back. On release the
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
      for (const candidate of ["left", "right"] as const)
        if (
          floats[candidate] &&
          visible(candidate) &&
          split(candidate).contains(target)
        )
          side = candidate;
      if (!side) {
        opening = true;
        if (floats.left && !visible("left") && touch.clientX < app.railWidth + 20)
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
      // The closed card sits beyond the rail (left) or the screen edge.
      const distance =
        side === "left" ? rect.width + app.railWidth + 16 : rect.width + 16;
      drag = {
        side,
        opening,
        el,
        startX: touch.clientX,
        startY: touch.clientY,
        horizontal: null,
        distance,
        offset: 0,
        lastX: touch.clientX,
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
      const touch = event.touches[0];
      const dx = touch.clientX - drag.startX;
      const dy = touch.clientY - drag.startY;
      if (drag.horizontal === null) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        drag.horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
        if (!drag.horizontal) {
          drag = null;
          return;
        }
        drag.el.classList.add("is-dragging");
      }
      const { side, opening, distance } = drag;
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
      const elapsed = Math.max(1, event.timeStamp - drag.lastTime);
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
