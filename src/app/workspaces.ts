/**
 * Named workspaces: saved tab/split layouts plus the sidebar layout, like
 * Obsidian's "Workspaces" core plugin. They are kept per vault in this
 * WebView's localStorage next to the automatically restored workspace, so
 * they never write into the vault.
 */

export interface WorkspaceTab {
  path: string | null;
  reading: boolean;
}

/** The editor part of a workspace, in the shape the app restores at startup. */
export interface WorkspaceTabs {
  tabs: WorkspaceTab[];
  active: number;
  groups?: Array<{ tabs: WorkspaceTab[]; active: number }>;
  split?: unknown;
  group?: number;
}

export interface NamedWorkspace {
  name: string;
  /** Milliseconds since the epoch of the last save. */
  saved: number;
  tabs: WorkspaceTabs;
  /** Sidebar and panel layout; validated by the app when it is applied. */
  layout: unknown;
}

const MAX_WORKSPACES = 100;
const MAX_NAME = 80;

export const workspacesKey = (vaultId: string) =>
  `basalt-workspaces:${JSON.stringify(vaultId)}`;

/** Trims the name and rejects what could not be shown or told apart. */
export function workspaceName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) throw new Error("empty");
  if (name.length > MAX_NAME) throw new Error("too-long");
  return name;
}

const tabList = (value: unknown): WorkspaceTab[] =>
  Array.isArray(value)
    ? value
        .filter(
          (tab): tab is WorkspaceTab =>
            !!tab &&
            typeof tab === "object" &&
            (typeof (tab as WorkspaceTab).path === "string" ||
              (tab as WorkspaceTab).path === null),
        )
        .map((tab) => ({ path: tab.path, reading: tab.reading === true }))
    : [];

const whole = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;

function parseTabs(value: unknown): WorkspaceTabs {
  const raw = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const result: WorkspaceTabs = {
    tabs: tabList(raw.tabs),
    active: whole(raw.active),
  };
  if (Array.isArray(raw.groups) && raw.groups.length > 1) {
    result.groups = raw.groups.slice(0, 16).map((group: unknown) => {
      const saved = (group ?? {}) as Record<string, unknown>;
      return { tabs: tabList(saved.tabs), active: whole(saved.active) };
    });
    result.split = raw.split;
    result.group = whole(raw.group);
  }
  return result;
}

function parseWorkspace(value: unknown): NamedWorkspace | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string") return null;
  let name: string;
  try {
    name = workspaceName(raw.name);
  } catch {
    return null;
  }
  return {
    name,
    saved: whole(raw.saved),
    tabs: parseTabs(raw.tabs),
    layout: raw.layout ?? null,
  };
}

const sameName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

/** Saved workspaces of one vault. Every change is written immediately. */
export class WorkspaceLibrary {
  private items: NamedWorkspace[] = [];
  private current: string | null = null;

  constructor(
    private readonly vaultId: string,
    private readonly storage: Pick<
      Storage,
      "getItem" | "setItem"
    > = localStorage,
  ) {
    try {
      const raw: unknown = JSON.parse(
        storage.getItem(workspacesKey(vaultId)) ?? "null",
      );
      if (!raw || typeof raw !== "object") return;
      const value = raw as Record<string, unknown>;
      const seen: NamedWorkspace[] = [];
      if (Array.isArray(value.workspaces))
        for (const entry of value.workspaces.slice(0, MAX_WORKSPACES)) {
          const workspace = parseWorkspace(entry);
          if (workspace && !seen.some((w) => sameName(w.name, workspace.name)))
            seen.push(workspace);
        }
      this.items = seen;
      if (typeof value.active === "string" && this.get(value.active))
        this.current = this.get(value.active)!.name;
    } catch {
      // A corrupt entry only loses the saved workspaces.
    }
  }

  /** Sorted by name in the UI language. */
  list(): NamedWorkspace[] {
    return [...this.items].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): NamedWorkspace | null {
    return this.items.find((item) => sameName(item.name, name)) ?? null;
  }

  /** The workspace that was saved or loaded last, if it still exists. */
  get active(): string | null {
    return this.current;
  }

  /** Adds or replaces (by name, ignoring case) and makes it the active one. */
  save(workspace: NamedWorkspace): void {
    const name = workspaceName(workspace.name);
    const index = this.items.findIndex((item) => sameName(item.name, name));
    if (index < 0 && this.items.length >= MAX_WORKSPACES)
      throw new Error("limit");
    const entry = { ...workspace, name };
    const items = [...this.items];
    if (index >= 0) items[index] = entry;
    else items.push(entry);
    this.write(items, name);
  }

  setActive(name: string | null): void {
    const workspace = name === null ? null : this.get(name);
    this.write(this.items, workspace?.name ?? null);
  }

  remove(name: string): void {
    const items = this.items.filter((item) => !sameName(item.name, name));
    const active =
      this.current && sameName(this.current, name) ? null : this.current;
    this.write(items, active);
  }

  rename(from: string, to: string): void {
    const name = workspaceName(to);
    const existing = this.get(name);
    const source = this.get(from);
    if (!source) throw new Error("missing");
    if (existing && existing !== source) throw new Error("exists");
    const items = this.items.map((item) =>
      item === source ? { ...item, name } : item,
    );
    const active =
      this.current && sameName(this.current, from) ? name : this.current;
    this.write(items, active);
  }

  /** Throws (and keeps the old state) when localStorage refuses the write. */
  private write(items: NamedWorkspace[], active: string | null): void {
    this.storage.setItem(
      workspacesKey(this.vaultId),
      JSON.stringify({ active, workspaces: items }),
    );
    this.items = items;
    this.current = active;
  }
}

/** Builds a workspace entry; split into a function so tests need no `App`. */
export function namedWorkspace(
  name: string,
  tabs: WorkspaceTabs,
  layout: unknown,
  now = Date.now(),
): NamedWorkspace {
  return {
    name: workspaceName(name),
    saved: now,
    tabs: parseTabs(JSON.parse(JSON.stringify(tabs))),
    layout: JSON.parse(JSON.stringify(layout ?? null)),
  };
}
