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
 * Which tablet sidebars slide over the note as sheets instead of sitting
 * beside it. The rule follows the room left for the note, not the
 * orientation: a large tablet in portrait can still dock the files, a small
 * one in landscape shows backlinks as a sheet. The left sidebar decides
 * first; the right one docks only if the note keeps its width beside both.
 */
export function sidebarSheets(
  viewportWidth: number,
  left: { open: boolean; width: number },
  right: { width: number },
): { left: boolean; right: boolean } {
  const room = viewportWidth - RAIL_WIDTH;
  const leftSheet = room - left.width < NOTE_MIN_WIDTH;
  const leftDocked = !leftSheet && left.open;
  const rightSheet =
    room - (leftDocked ? left.width : 0) - right.width < NOTE_MIN_WIDTH;
  return { left: leftSheet, right: rightSheet };
}
