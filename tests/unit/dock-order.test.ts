import { expect, it } from "vitest";
import {
  applyDockOrder,
  DEFAULT_DOCK_ORDER,
  moveItem,
  normalizeDockOrder,
  PLUGINS,
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

it("moves one place at a time and stops at the ends", () => {
  expect(moveItem(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
  expect(moveItem(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
});

it("puts the buttons in order, split by the spacer, and hides some", () => {
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
  applyDockOrder(
    ribbon,
    [
      "settings",
      "open-graph",
      SPACER,
      "quick-switcher",
      "daily-note",
      "command-palette",
      PLUGINS,
      "toggle-theme",
    ],
    ["daily-note", "settings"],
  );
  const names = (selector: string) =>
    [...ribbon.querySelector(selector)!.children].map(
      (el) => (el as HTMLElement).dataset.command ?? "plugins",
    );
  expect(names(".side-dock-actions")).toEqual(["settings", "open-graph"]);
  expect(names(".side-dock-settings")).toEqual([
    "quick-switcher",
    "daily-note",
    "command-palette",
    "plugins",
    "toggle-theme",
  ]);
  expect(
    ribbon.querySelector<HTMLElement>('[data-command="daily-note"]')!.hidden,
  ).toBe(true);
  // Settings can never be hidden.
  expect(
    ribbon.querySelector<HTMLElement>('[data-command="settings"]')!.hidden,
  ).toBe(false);
});
