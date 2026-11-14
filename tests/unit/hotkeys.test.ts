import { beforeEach, expect, it, vi } from "vitest";
import { CommandRegistry, isAssignable } from "../../src/app/commands";

const press = (key: string, init: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key, cancelable: true, ...init });

function registry() {
  const commands = new CommandRegistry();
  const runs: string[] = [];
  for (const [id, hotkey] of [
    ["save", "Mod+S"],
    ["search", "Mod+Shift+F"],
    ["graph", undefined],
  ] as const)
    commands.add({ id, name: id, hotkey, run: () => runs.push(id) });
  return { commands, runs };
}

beforeEach(() => localStorage.removeItem("basalt-hotkeys"));

it("runs a customized hotkey and keeps it across restarts", () => {
  const { commands, runs } = registry();
  commands.setHotkey("graph", "Mod+Alt+G");
  expect(commands.hotkeyOf("graph")).toBe("Mod+Alt+G");
  commands.handleKey(press("g", { ctrlKey: true, altKey: true }), false);
  expect(runs).toEqual(["graph"]);

  const again = registry();
  expect(again.commands.hotkeyOf("graph")).toBe("Mod+Alt+G");
  expect(again.commands.isCustomized("graph")).toBe(true);
});

it("moves a hotkey that another command had, and resets back", () => {
  const { commands, runs } = registry();
  const listener = vi.fn();
  commands.onChange(listener);
  const displaced = commands.setHotkey("graph", "Mod+S");
  expect(displaced?.id).toBe("save");
  expect(commands.hotkeyOf("save")).toBeUndefined();
  commands.handleKey(press("s", { ctrlKey: true }), false);
  expect(runs).toEqual(["graph"]);

  // Resetting "save" takes its default back from "graph".
  expect(commands.resetHotkey("save")?.id).toBe("graph");
  expect(commands.hotkeyOf("save")).toBe("Mod+S");
  expect(commands.hotkeyOf("graph")).toBeUndefined();
  expect(listener).toHaveBeenCalled();
});

it("removes a hotkey and refuses ones that would type text", () => {
  const { commands, runs } = registry();
  commands.setHotkey("save", null);
  expect(commands.hotkeyOf("save")).toBeUndefined();
  expect(commands.handleKey(press("s", { ctrlKey: true }), false)).toBe(false);
  expect(runs).toEqual([]);
  expect(() => commands.setHotkey("graph", "Shift+G")).toThrow();
  expect(isAssignable("G")).toBe(false);
  expect(isAssignable("F5")).toBe(true);
  expect(isAssignable("Alt+Shift+K")).toBe(true);
  // Setting the default again is no customization.
  commands.setHotkey("save", "Mod+S");
  expect(commands.isCustomized("save")).toBe(false);
});

it("ignores unreadable stored hotkeys", () => {
  localStorage.setItem("basalt-hotkeys", "{not json");
  expect(registry().commands.hotkeyOf("save")).toBe("Mod+S");
  localStorage.setItem(
    "basalt-hotkeys",
    JSON.stringify({ save: "S", search: 3 }),
  );
  const { commands } = registry();
  expect(commands.hotkeyOf("save")).toBe("Mod+S");
  expect(commands.hotkeyOf("search")).toBe("Mod+Shift+F");
});
