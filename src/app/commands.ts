import { isMac } from "../ui/dom";

export interface Command {
  id: string;
  name: string;
  /** e.g. "Mod+Shift+F"; `Mod` is Ctrl, or Cmd on macOS. */
  hotkey?: string;
  icon?: string;
  /** Also fires while a modal or text field outside the editor has focus. */
  global?: boolean;
  /** Hidden from the palette and inert while this returns false. */
  when?(): boolean;
  run(): void;
}

/** The hotkey a key press stands for, such as "Mod+Shift+F"; `null` for a lone modifier. */
export function eventHotkey(event: KeyboardEvent): string | null {
  const key = event.key;
  if (key === "Control" || key === "Meta" || key === "Shift" || key === "Alt")
    return null;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  // Alt/AltGr change `key` on many layouts; fall back to the physical key.
  const letter = /^Key([A-Z])$/.exec(event.code);
  parts.push(
    letter && (event.altKey || key.length !== 1)
      ? letter[1]
      : key.length === 1
        ? key.toUpperCase()
        : key,
  );
  return parts.join("+");
}

function normalize(hotkey: string): string {
  const parts = hotkey.split("+");
  const key = parts.pop()!;
  const order = ["Mod", "Alt", "Shift"].filter((name) => parts.includes(name));
  return [...order, key.length === 1 ? key.toUpperCase() : key].join("+");
}

/**
 * Whether a hotkey can trigger a command at all: plain keys and Shift
 * combinations type text, so they need Ctrl/Cmd or Alt, or a function key.
 */
export function isAssignable(hotkey: string): boolean {
  const parts = hotkey.split("+");
  const key = parts[parts.length - 1];
  return parts.includes("Mod") || parts.includes("Alt") || /^F\d+$/.test(key);
}

const STORAGE_KEY = "basalt-hotkeys";

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();
  private byHotkey = new Map<string, Command>();
  /** Customized hotkeys by command id; `null` removes the default one. */
  private readonly overrides = new Map<string, string | null>();
  private readonly listeners = new Set<() => void>();

  constructor() {
    try {
      const saved: unknown = JSON.parse(
        localStorage.getItem(STORAGE_KEY) ?? "null",
      );
      if (saved && typeof saved === "object")
        for (const [id, hotkey] of Object.entries(saved))
          if (hotkey === null) this.overrides.set(id, null);
          else if (typeof hotkey === "string" && isAssignable(hotkey))
            this.overrides.set(id, normalize(hotkey));
    } catch {
      // Unreadable customizations fall back to the default hotkeys.
    }
  }

  add(command: Command): void {
    this.commands.set(command.id, command);
    this.rebuild();
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  /** The hotkey that runs a command now, customized or default. */
  hotkeyOf(id: string): string | undefined {
    const override = this.overrides.get(id);
    if (override !== undefined) return override ?? undefined;
    const hotkey = this.commands.get(id)?.hotkey;
    return hotkey ? normalize(hotkey) : undefined;
  }

  isCustomized(id: string): boolean {
    return this.overrides.has(id);
  }

  /** The command a hotkey runs, if any. */
  ownerOf(hotkey: string): Command | undefined {
    return this.byHotkey.get(normalize(hotkey));
  }

  /**
   * Gives a command a hotkey (`null` removes it). A command that had the
   * same hotkey loses it, so one key never means two things; that command
   * is returned so the caller can say so.
   */
  setHotkey(id: string, hotkey: string | null): Command | null {
    const next = hotkey === null ? null : normalize(hotkey);
    if (next !== null && !isAssignable(next))
      throw new Error(`Hotkey ${next} needs Ctrl, Alt or a function key`);
    const previous = next === null ? undefined : this.ownerOf(next);
    const displaced = previous && previous.id !== id ? previous : null;
    if (displaced) this.overrides.set(displaced.id, null);
    const fallback = this.commands.get(id)?.hotkey;
    if (next !== null && fallback && normalize(fallback) === next)
      this.overrides.delete(id);
    else this.overrides.set(id, next);
    this.changed();
    return displaced;
  }

  /** Back to the default hotkey, taken from whichever command has it now. */
  resetHotkey(id: string): Command | null {
    const fallback = this.commands.get(id)?.hotkey;
    this.overrides.delete(id);
    if (!fallback) {
      this.changed();
      return null;
    }
    return this.setHotkey(id, fallback);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    try {
      if (this.overrides.size)
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify(Object.fromEntries(this.overrides)),
        );
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Not persisted, but still in effect for this session.
    }
    this.rebuild();
    for (const listener of this.listeners) listener();
  }

  /** Customized hotkeys win over defaults that happen to be the same. */
  private rebuild(): void {
    const map = new Map<string, Command>();
    for (const command of this.commands.values())
      if (!this.overrides.has(command.id) && command.hotkey)
        map.set(normalize(command.hotkey), command);
    for (const [id, hotkey] of this.overrides) {
      const command = this.commands.get(id);
      if (command && hotkey) map.set(hotkey, command);
    }
    this.byHotkey = map;
  }

  list(): Command[] {
    return [...this.commands.values()].filter(
      (command) => !command.when || command.when(),
    );
  }

  run(id: string): void {
    const command = this.commands.get(id);
    if (command && (!command.when || command.when())) command.run();
  }

  /** Returns true when the event was consumed by a command. */
  handleKey(event: KeyboardEvent, blocked: boolean): boolean {
    const hotkey = eventHotkey(event);
    if (!hotkey) return false;
    if (
      !(event.ctrlKey || event.metaKey || event.altKey) &&
      !/^F\d+$/.test(hotkey)
    )
      return false;
    // On macOS, Ctrl+letter belongs to text navigation unless Cmd is used.
    if (isMac && event.ctrlKey && !event.metaKey && event.key !== "Tab")
      return false;
    const command = this.byHotkey.get(hotkey);
    if (!command) return false;
    if (blocked && !command.global) return false;
    if (command.when && !command.when()) return false;
    event.preventDefault();
    event.stopPropagation();
    command.run();
    return true;
  }
}
