import type { Backend } from "../backend";
import { expiredBackups, type RetentionPolicy } from "../backups";

const KEY = "basalt-backup-cleanup";
/** Automatic cleanups run at most this often per vault. */
export const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;

export interface CleanupResult {
  removed: number;
  /** Bytes the removed backups took. */
  freed: number;
}

function lastRuns(): Record<string, number> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return value && typeof value === "object"
      ? (value as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

function remember(vaultId: string, now: number): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...lastRuns(), [vaultId]: now }),
    );
  } catch {
    // Without storage the cleanup simply runs again next time.
  }
}

/**
 * Deletes the backups `policy` no longer keeps, or with `emptyTrash` every file
 * in the vault trash. Only backup locations the backend listed are passed on,
 * and the backend refuses anything else.
 */
export async function cleanBackups(
  backend: Pick<Backend, "backups" | "removeBackups">,
  vaultId: string,
  selection: { policy: RetentionPolicy } | { emptyTrash: true },
  now = Date.now(),
): Promise<CleanupResult> {
  const backups = await backend.backups(vaultId, true);
  const doomed =
    "emptyTrash" in selection
      ? backups.filter((backup) => backup.kind === "deleted")
      : expiredBackups(backups, selection.policy, now);
  if (!doomed.length) return { removed: 0, freed: 0 };
  await backend.removeBackups(
    doomed.map((backup) => backup.location),
    vaultId,
  );
  return {
    removed: doomed.length,
    freed: doomed.reduce((sum, backup) => sum + backup.size, 0),
  };
}

/** Applies the retention policy once a day per vault; null when it was not due. */
export async function autoCleanBackups(
  backend: Pick<Backend, "backups" | "removeBackups">,
  vaultId: string,
  policy: RetentionPolicy,
  now = Date.now(),
): Promise<CleanupResult | null> {
  if (!policy.maxAgeDays && !policy.maxVersions) return null;
  const last = lastRuns()[vaultId] ?? 0;
  if (now - last < CLEANUP_INTERVAL && last <= now) return null;
  // Remember first: a failing cleanup should not retry on every start.
  remember(vaultId, now);
  return cleanBackups(backend, vaultId, { policy }, now);
}

/** Human-readable size, such as "1.4 MB". */
export function formatBytes(bytes: number, locale?: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString(locale, { maximumFractionDigits: digits })} ${units[unit]}`;
}
