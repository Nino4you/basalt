import { beforeEach, expect, it } from "vitest";
import { BrowserBackend } from "../../src/backend";
import {
  expiredBackups,
  parseBackup,
  type BackupEntry,
} from "../../src/backups";
import {
  autoCleanBackups,
  cleanBackups,
  CLEANUP_INTERVAL,
  formatBytes,
} from "../../src/app/backup-cleanup";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14);

/** A backup written `days` ago, in the native id format. */
function backup(
  kind: "version" | "deleted",
  path: string,
  days: number,
  n = 0,
) {
  const nanos = `${NOW - days * DAY}${String(n).padStart(6, "0")}`;
  const location =
    kind === "version"
      ? `.basalt/history/${path}/${nanos}-0.md`
      : `.basalt/trash/${nanos}-0/${path}`;
  return parseBackup(location, 10)!;
}

const locations = (backups: BackupEntry[]) =>
  backups.map((entry) => entry.location).sort();

beforeEach(() => localStorage.clear());

it("expires backups by age, versions by count, unknown times never", () => {
  const backups = [
    backup("version", "a.md", 1),
    backup("version", "a.md", 2),
    backup("version", "a.md", 3),
    backup("version", "b.md", 100),
    backup("deleted", "c.md", 100),
    backup("deleted", "d.md", 1),
    parseBackup(".basalt/trash/some-uuid/e.md")!,
  ];
  expect(
    locations(expiredBackups(backups, { maxAgeDays: 90, maxVersions: 0 }, NOW)),
  ).toEqual(locations([backups[3], backups[4]]));
  expect(
    locations(expiredBackups(backups, { maxAgeDays: 0, maxVersions: 2 }, NOW)),
  ).toEqual(locations([backups[2]]));
  expect(
    expiredBackups(backups, { maxAgeDays: 0, maxVersions: 0 }, NOW),
  ).toEqual([]);
});

function demo(files: Record<string, string>) {
  localStorage.setItem("basalt-demo-v1", JSON.stringify(files));
  return new BrowserBackend();
}

it("cleans up the demo vault and empties its trash", async () => {
  const old = backup("version", "a.md", 200);
  const recent = backup("version", "a.md", 1);
  const trashed = backup("deleted", "b.md", 1);
  const api = demo({
    "a.md": "now",
    [old.location]: "old",
    [recent.location]: "recent",
    [trashed.location]: "bye",
  });
  const policy = { maxAgeDays: 90, maxVersions: 0 };
  expect(await cleanBackups(api, "demo", { policy }, NOW)).toEqual({
    removed: 1,
    freed: 3,
  });
  expect(locations(await api.backups("demo", true))).toEqual(
    locations([recent, trashed]),
  );
  expect(await cleanBackups(api, "demo", { emptyTrash: true }, NOW)).toEqual({
    removed: 1,
    freed: 3,
  });
  expect(locations(await api.backups())).toEqual([recent.location]);
  expect(await api.read("a.md")).toBe("now");
});

it("refuses to remove anything that is not a backup", async () => {
  const api = demo({ "a.md": "keep" });
  await expect(api.removeBackups(["a.md"])).rejects.toThrow();
  expect(await api.read("a.md")).toBe("keep");
});

it("cleans up automatically at most once a day per vault", async () => {
  const api = demo({ [backup("deleted", "x.md", 400).location]: "x" });
  const policy = { maxAgeDays: 30, maxVersions: 0 };
  expect(await autoCleanBackups(api, "v", policy, NOW)).toEqual({
    removed: 1,
    freed: 1,
  });
  expect(await autoCleanBackups(api, "v", policy, NOW + 1000)).toBeNull();
  expect(
    await autoCleanBackups(api, "v", policy, NOW + CLEANUP_INTERVAL),
  ).toEqual({ removed: 0, freed: 0 });
  expect(
    await autoCleanBackups(api, "w", { maxAgeDays: 0, maxVersions: 0 }, NOW),
  ).toBeNull();
});

it("formats sizes", () => {
  expect(formatBytes(512, "en")).toBe("512 B");
  expect(formatBytes(1_450_000, "en")).toBe("1.5 MB");
  expect(formatBytes(123_400_000, "en")).toBe("123 MB");
});
