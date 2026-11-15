import { expect, it } from "vitest";
import { NOTE_MIN_WIDTH, RAIL_WIDTH, sidebarSheets } from "../../src/ui/device";

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
