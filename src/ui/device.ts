/**
 * Layout classes. Width alone misses phones turned sideways (a Pixel 7 is
 * 915 × 412 in landscape), which would otherwise get the desktop layout with
 * both sidebars beside a sliver of editor. Keep the CSS media queries that
 * list the same conditions in sync.
 */
export const PHONE_QUERY =
  "(max-width: 768px), (any-pointer: coarse) and (max-height: 500px), (hover: none) and (max-height: 500px)";

/**
 * Finger input: tablets get the desktop layout with touch-sized targets.
 * Not `(pointer: coarse)`: Android reports a fine primary pointer as soon as
 * a hardware keyboard is attached, although the screen is still touched.
 */
export const TOUCH_QUERY = "(any-pointer: coarse), (hover: none)";

/** Width of the tablet navigation rail (the ribbon on tablets). */
export const RAIL_WIDTH = 72;
/** Tablets dock a sidebar beside the note only while the note keeps this width. */
export const NOTE_MIN_WIDTH = 520;

/**
 * Which tablet sidebars float over the note as cards instead of sitting
 * beside it. They float unless pinned; a pinned one docks only while the
 * note keeps its width, so a pinned sidebar still floats in portrait on a
 * small tablet. The left sidebar decides first; the right one docks only if
 * the note keeps its width beside both.
 */
export function sidebarSheets(
  viewportWidth: number,
  left: { open: boolean; width: number; pinned: boolean },
  right: { width: number; pinned: boolean },
): { left: boolean; right: boolean } {
  const room = viewportWidth - RAIL_WIDTH;
  const leftSheet = !left.pinned || room - left.width < NOTE_MIN_WIDTH;
  const leftDocked = !leftSheet && left.open;
  const rightSheet =
    !right.pinned ||
    room - (leftDocked ? left.width : 0) - right.width < NOTE_MIN_WIDTH;
  return { left: leftSheet, right: rightSheet };
}
