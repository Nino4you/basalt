import { expect, it } from "vitest";
import {
  applyDockOrder,
  DEFAULT_DOCK_ORDER,
  normalizeDockOrder,
  PLUGINS,
  readDockOrder,
  SPACER,
} from "../../src/app/dock-order";

it("repairs stored orders", () => {
  expect(normalizeDockOrder(undefined)).toEqual(DEFAULT_DOCK_ORDER);
  // Unknown and duplicate entries go, missing ones return in their group.
  expect(
    normalizeDockOrder(["settings", "nope", "open-graph", "settings", SPACER]),
  ).toEqual([
    "settings",
    "open-graph",
    "quick-switcher",
    "daily-note",
    "command-palette",
    PLUGINS,
    SPACER,
    "toggle-theme",
  ]);
});

it("applies an order across both groups and reads it back", () => {
  const ribbon = document.createElement("nav");
  ribbon.innerHTML = `
    <div class="side-dock-actions">
      <button data-command="quick-switcher"></button>
      <button data-command="daily-note"></button>
      <button data-command="command-palette"></button>
      <button data-command="open-graph"></button>
      <div class="side-dock-plugins"></div>
    </div>
    <div class="side-dock-settings">
      <button data-command="toggle-theme"></button>
      <button data-command="settings"></button>
    </div>`;
  const order = [
    "settings",
    "open-graph",
    SPACER,
    "quick-switcher",
    "daily-note",
    "command-palette",
    PLUGINS,
    "toggle-theme",
  ];
  applyDockOrder(ribbon, order);
  expect(readDockOrder(ribbon)).toEqual(order);
});
