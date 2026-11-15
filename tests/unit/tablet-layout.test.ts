import { expect, it } from "vitest";
import {
  NOTE_MIN_WIDTH,
  RAIL_WIDTH,
  sidebarSheets as sheets,
} from "../../src/ui/device";

/** The left dock takes RAIL_WIDTH of the viewport. */
const sidebarSheets = (
  viewport: number,
  left: Parameters<typeof sheets>[1],
  right: Parameters<typeof sheets>[2],
) => sheets(viewport - RAIL_WIDTH, left, right);

const pinned = { open: true, width: 280, pinned: true };
const right = { width: 300, pinned: true };

it("floats sidebars that are not pinned, whatever the width", () => {
  expect(
    sidebarSheets(
      1600,
      { ...pinned, pinned: false },
      { ...right, pinned: false },
    ),
  ).toEqual({ left: true, right: true });
});

it("docks pinned sidebars on a wide landscape tablet", () => {
  expect(sidebarSheets(1280, pinned, right)).toEqual({
    left: false,
    right: false,
  });
});

it("lets a pinned right sidebar float when the docked files leave no room", () => {
  expect(sidebarSheets(1024, pinned, right)).toEqual({
    left: false,
    right: true,
  });
  // With the files closed there is room for the right one again.
  expect(sidebarSheets(1024, { ...pinned, open: false }, right)).toEqual({
    left: false,
    right: false,
  });
});

it("floats even pinned sidebars in portrait", () => {
  expect(sidebarSheets(834, pinned, right)).toEqual({
    left: true,
    right: true,
  });
});

it("decides by the room left for the note", () => {
  const exact = RAIL_WIDTH + pinned.width + NOTE_MIN_WIDTH;
  expect(sidebarSheets(exact, pinned, right).left).toBe(false);
  expect(sidebarSheets(exact - 1, pinned, right).left).toBe(true);
});

it("gives the note the whole width when the dock floats at the bottom", () => {
  // 860 px: too narrow beside a left dock, wide enough without it.
  expect(sidebarSheets(860, pinned, right).left).toBe(true);
  expect(sheets(860, pinned, right).left).toBe(false);
});
