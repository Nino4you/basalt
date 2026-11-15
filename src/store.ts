import { t } from "./i18n";
import type { Backend } from "./backend";

export interface Note {
  path: string;
  text: string;
  saved: string;
  recovered: boolean;
}

export interface Recovery {
  id: string;
  path: string;
  text: string;
  savedAt: string;
}

/**
 * How often the app backs up its own autosaved content while someone keeps
 * typing. Content the app did not write itself is always backed up.
 */
export const OWN_BACKUP_INTERVAL = 5 * 60_000;

/** Serializes saves and retains edits made while an earlier snapshot is being saved. */
export class NoteStore {
  readonly notes = new Map<string, Note>();
  /** What this store last wrote per path, and when that path was last backed up. */
  private readonly written = new Map<string, { text: string; backedUp: number }>();
  private pending: Promise<void> = Promise.resolve();
  private readonly deleting = new Set<string>();
  private readonly deleted = new WeakSet<Note>();
  private readonly removals = new Map<string, number>();
  /** Called after each successful save, e.g. to tell other windows. */
  onSaved: ((path: string, text: string) => void) | null = null;

  constructor(
    private readonly api: Backend,
    readonly vaultId: string,
  ) {}

  private draftKey(path: string): string {
    return `basalt-draft:${JSON.stringify([this.vaultId, path])}`;
  }

  async load(path: string): Promise<Note> {
    if (this.isDeleting(path))
      throw new Error(t("Die Datei wird gerade gelöscht."));
    return this.loadSnapshot(path);
  }

  private async loadSnapshot(path: string): Promise<Note> {
    const existing = this.notes.get(path);
    if (existing) return existing;
    const generation = this.removals.get(path);
    const saved = await this.api.read(path, this.vaultId);
    if (generation !== this.removals.get(path))
      throw new Error(
        t("Die Datei wurde inzwischen gelöscht. Bitte erneut öffnen."),
      );
    const raw = localStorage.getItem(this.draftKey(path));
    const draft: { text: string; base: string } | null = raw
      ? JSON.parse(raw)
      : null;
    if (
      draft &&
      (typeof draft.text !== "string" || typeof draft.base !== "string")
    )
      throw new Error(t("Ungültiger Entwurf. Die Datei wurde nicht verändert."));
    const note = {
      path,
      saved: draft?.base ?? saved,
      text: draft?.text ?? saved,
      recovered: draft !== null && draft.text !== saved,
    };
    this.notes.set(path, note);
    return note;
  }

  edit(note: Note, text: string): void {
    if (this.deleted.has(note)) throw new Error(t("Die Datei wurde gelöscht."));
    if (this.isDeleting(note.path))
      throw new Error(t("Die Datei wird gerade gelöscht."));
    note.text = text;
    if (text === note.saved) localStorage.removeItem(this.draftKey(note.path));
    else
      localStorage.setItem(
        this.draftKey(note.path),
        JSON.stringify({ text, base: note.saved }),
      );
  }

  /** `backup: true` backs up the replaced content even if it was a recent own write. */
  save(note: Note, options: { backup?: boolean } = {}): Promise<void> {
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        if (!this.deleted.has(note))
          await this.saveSnapshot(note, options.backup === true);
      });
    this.pending = operation;
    return operation;
  }

  private async saveSnapshot(note: Note, force: boolean): Promise<void> {
    const snapshot = note.text;
    if (snapshot === note.saved) return;
    // The replaced content needs a backup unless this store wrote it itself
    // and backed this file up a short while ago.
    const own = this.written.get(note.path);
    const now = Date.now();
    const backup =
      force ||
      !own ||
      own.text !== note.saved ||
      now - own.backedUp >= OWN_BACKUP_INTERVAL;
    await this.api.save(note.path, snapshot, note.saved, this.vaultId, backup);
    this.written.set(note.path, {
      text: snapshot,
      backedUp: backup ? now : own!.backedUp,
    });
    note.saved = snapshot;
    note.recovered = false;
    this.onSaved?.(note.path, snapshot);
    if (note.text === snapshot)
      localStorage.removeItem(this.draftKey(note.path));
    else
      localStorage.setItem(
        this.draftKey(note.path),
        JSON.stringify({ text: note.text, base: snapshot }),
      );
  }

  isDeleting(path: string): boolean {
    return this.deleting.has(path);
  }

  remove(path: string): Promise<void> {
    if (this.isDeleting(path))
      return Promise.reject(new Error(t("Die Datei wird gerade gelöscht.")));
    this.deleting.add(path);
    this.removals.set(path, (this.removals.get(path) ?? 0) + 1);
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        let note = this.notes.get(path);
        if (!note && localStorage.getItem(this.draftKey(path)) !== null)
          note = await this.loadSnapshot(path);
        if (note) await this.saveSnapshot(note, false);
        await this.api.remove(path, note?.saved, this.vaultId);
        this.written.delete(path);
        if (note) this.deleted.add(note);
        this.notes.delete(path);
        localStorage.removeItem(this.draftKey(path));
      })
      .finally(() => this.deleting.delete(path));
    this.pending = operation;
    return operation;
  }

  /**
   * Moves a file to the free path `to`. Unsaved edits are saved first, and
   * a loaded note keeps its identity, so open tabs simply follow it.
   */
  move(from: string, to: string): Promise<void> {
    if (this.isDeleting(from) || this.isDeleting(to))
      return Promise.reject(
        new Error(t("Die Datei wird gerade verschoben oder gelöscht.")),
      );
    // Blocks edits and loads of the old path until the move has settled.
    this.deleting.add(from);
    this.removals.set(from, (this.removals.get(from) ?? 0) + 1);
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        if (this.notes.has(to))
          throw new Error(
            "Am Ziel existiert bereits eine Datei mit diesem Namen.",
          );
        let note = this.notes.get(from);
        if (!note && localStorage.getItem(this.draftKey(from)) !== null)
          note = await this.loadSnapshot(from);
        if (note) await this.saveSnapshot(note, false);
        await this.api.move(from, to, note?.saved, this.vaultId);
        const own = this.written.get(from);
        this.written.delete(from);
        if (own) this.written.set(to, own);
        localStorage.removeItem(this.draftKey(from));
        if (!note) return;
        this.notes.delete(from);
        note.path = to;
        this.notes.set(to, note);
      })
      .finally(() => this.deleting.delete(from));
    this.pending = operation;
    return operation;
  }

  async saveAll(): Promise<void> {
    for (const note of this.notes.values()) await this.save(note);
  }

  recoveries(): Recovery[] {
    const prefix = `basalt-recovery:${JSON.stringify(this.vaultId)}:`;
    const result: Recovery[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (!key.startsWith(prefix)) continue;
      const value = JSON.parse(localStorage.getItem(key)!);
      if (
        typeof value.path === "string" &&
        typeof value.text === "string" &&
        typeof value.savedAt === "string"
      )
        result.push({ ...value, id: key });
    }
    return result.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  /** Reload only after archiving the unsaved local version; never silently discard it. */
  async reload(path: string): Promise<Note> {
    const generation = this.removals.get(path);
    await this.pending.catch(() => {});
    const current = await this.api.read(path, this.vaultId);
    if (generation !== this.removals.get(path))
      throw new Error(
        t("Die Datei wurde inzwischen gelöscht. Bitte erneut öffnen."),
      );
    const old = this.notes.get(path);
    if (old && old.text !== old.saved) {
      const savedAt = new Date().toISOString();
      const key = `basalt-recovery:${JSON.stringify(this.vaultId)}:${savedAt}:${crypto.randomUUID()}:${path}`;
      localStorage.setItem(
        key,
        JSON.stringify({ path, text: old.text, savedAt }),
      );
    }
    const note = { path, text: current, saved: current, recovered: false };
    this.notes.set(path, note);
    localStorage.removeItem(this.draftKey(path));
    return note;
  }
}
