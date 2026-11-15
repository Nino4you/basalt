/**
 * Backups the vault keeps of notes and canvases, mirroring `vault_core::Backup`.
 *
 * - `.basalt/history/<path>/<id>.md`: the content `<path>` had before a save.
 * - `.basalt/trash/<id>/<path>`: the content `<path>` had when it was deleted.
 *
 * Ids start with the write time in nanoseconds (`<nanos>-...`).
 */
export interface BackupEntry {
  kind: "version" | "deleted";
  /** The note or canvas the backup belongs to. */
  path: string;
  /** Where the backup itself is stored, below `.basalt/`. */
  location: string;
  /** Milliseconds since the Unix epoch; 0 when the id carries no time. */
  time: number;
  size: number;
}

export const HISTORY_DIR = ".basalt/history";
export const TRASH_DIR = ".basalt/trash";

const DOCUMENT = /\.(md|canvas|base)$/i;

/** Recognizes a backup location; anything else, such as hidden originals, is `null`. */
export function parseBackup(location: string, size = 0): BackupEntry | null {
  let kind: BackupEntry["kind"];
  let path: string;
  let id: string;
  if (location.startsWith(`${HISTORY_DIR}/`)) {
    const rest = location.slice(HISTORY_DIR.length + 1);
    const slash = rest.lastIndexOf("/");
    if (slash < 0) return null;
    const file = rest.slice(slash + 1);
    const match = /^(.*)\.(md|bin)$/.exec(file);
    if (!match) return null;
    kind = "version";
    path = rest.slice(0, slash);
    id = match[1];
  } else if (location.startsWith(`${TRASH_DIR}/`)) {
    const rest = location.slice(TRASH_DIR.length + 1);
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    kind = "deleted";
    id = rest.slice(0, slash);
    path = rest.slice(slash + 1);
  } else return null;
  if (
    !id ||
    !path ||
    path
      .split("/")
      .some((part) => !part || part.startsWith(".") || part === "..")
  )
    return null;
  return { kind, path, location, time: backupTime(id), size };
}

/** Milliseconds from the nanosecond prefix of a backup id, or 0. */
function backupTime(id: string): number {
  const digits = /^(\d+)(?:-|$)/.exec(id)?.[1];
  if (!digits) return 0;
  // Nanoseconds exceed Number precision; dropping the last six digits is exact.
  return digits.length > 6 ? Number(digits.slice(0, -6)) : 0;
}

/** Whether a backup can be shown and restored as text by the note backend. */
export function isDocumentBackup(backup: BackupEntry): boolean {
  return (
    DOCUMENT.test(backup.path) &&
    (backup.kind === "deleted" || backup.location.endsWith(".md"))
  );
}

/** The nanosecond prefix of a backup's id, as digits. */
function nanos(backup: BackupEntry): string {
  const rest = backup.location.slice(
    (backup.kind === "version" ? HISTORY_DIR : TRASH_DIR).length + 1,
  );
  const id =
    backup.kind === "version"
      ? rest.slice(rest.lastIndexOf("/") + 1)
      : rest.slice(0, rest.indexOf("/"));
  return /^\d*/.exec(id)![0];
}

function compareDigits(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** Newest first, by the full nanosecond time; then by location. */
export function sortBackups(backups: BackupEntry[]): BackupEntry[] {
  return backups.sort(
    (a, b) =>
      b.time - a.time ||
      compareDigits(nanos(b), nanos(a)) ||
      a.location.localeCompare(b.location),
  );
}

let sequence = 0;

/**
 * A backup id in the native format, for the browser demo. Ids written within
 * the same millisecond still order by their nanosecond part.
 */
export function newBackupId(now = Date.now()): string {
  sequence += 1;
  return `${now}${String(sequence % 1_000_000).padStart(6, "0")}-0-${sequence}`;
}

const DAY = 24 * 60 * 60 * 1000;

/** How long backups are kept; 0 means without limit. */
export interface RetentionPolicy {
  /** Backups older than this many days go, versions and trash alike. */
  maxAgeDays: number;
  /** Per file, only this many of the newest versions stay. */
  maxVersions: number;
}

/**
 * Backups a policy no longer keeps. Backups whose id carries no time are
 * never removed by age. Deleted files count only by age, never by number.
 */
export function expiredBackups(
  backups: BackupEntry[],
  policy: RetentionPolicy,
  now = Date.now(),
): BackupEntry[] {
  const cutoff = policy.maxAgeDays > 0 ? now - policy.maxAgeDays * DAY : 0;
  const versions = new Map<string, number>();
  return sortBackups([...backups]).filter((backup) => {
    let expired = backup.time > 0 && backup.time < cutoff;
    if (backup.kind === "version") {
      const count = (versions.get(backup.path) ?? 0) + 1;
      versions.set(backup.path, count);
      if (policy.maxVersions > 0 && count > policy.maxVersions) expired = true;
    }
    return expired;
  });
}
