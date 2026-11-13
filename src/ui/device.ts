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

/** Tablets too narrow (portrait) for both sidebars beside the note. */
export const NARROW_TABLET_QUERY =
  "(any-pointer: coarse) and (max-width: 1099px), (hover: none) and (max-width: 1099px)";
