import { expect, it } from "vitest";
import { NOTE_MIN_WIDTH, RAIL_WIDTH, sidebarSheets } from "../../src/ui/device";

const left = { open: true, width: 280 };
const right = { width: 300 };

it("docks both sidebars on a wide landscape tablet", () => {
  expect(sidebarSheets(1280, left, right)).toEqual({
    left: false,
    right: false,
  });
});

it("docks the files but slides the right sidebar on a smaller landscape tablet", () => {
  expect(sidebarSheets(1024, left, right)).toEqual({
    left: false,
    right: true,
  });
  // With the files closed there is room for the right one again.
  expect(sidebarSheets(1024, { ...left, open: false }, right)).toEqual({
    left: false,
    right: false,
  });
});

it("slides both over the note in portrait", () => {
  expect(sidebarSheets(834, left, right)).toEqual({ left: true, right: true });
});

it("decides by the room left for the note", () => {
  const exact = RAIL_WIDTH + left.width + NOTE_MIN_WIDTH;
  expect(sidebarSheets(exact, left, right).left).toBe(false);
  expect(sidebarSheets(exact - 1, left, right).left).toBe(true);
});
