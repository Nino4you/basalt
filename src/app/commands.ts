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

function eventHotkey(event: KeyboardEvent): string | null {
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

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();
  private readonly byHotkey = new Map<string, Command>();

  add(command: Command): void {
    this.commands.set(command.id, command);
    if (command.hotkey) this.byHotkey.set(normalize(command.hotkey), command);
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
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
