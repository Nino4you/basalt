import { expect, it } from "vitest";
import {
  ConflictWatcher,
  conflictCopyOf,
  findConflicts,
  hasConflictMarkers,
} from "../../src/app/sync-conflicts";

it("recognizes conflict copies of common sync tools", () => {
  expect(
    conflictCopyOf("A/Note.sync-conflict-20261114-093000-ABCDEFG.md"),
  ).toEqual({
    original: "A/Note.md",
    tool: "Syncthing",
  });
  expect(conflictCopyOf("Note (conflicted copy 2026-11-14 093000).md")).toEqual(
    {
      original: "Note.md",
      tool: "Nextcloud/Dropbox",
    },
  );
  expect(
    conflictCopyOf("B/Plan (Ana's conflicted copy 2026-11-14).canvas"),
  ).toEqual({
    original: "B/Plan.canvas",
    tool: "Nextcloud/Dropbox",
  });
  expect(conflictCopyOf("Note.md")).toBeNull();
  expect(conflictCopyOf("Sync-conflict notes.md")).toBeNull();
});

it("finds Git merge markers only as a complete block", () => {
  expect(
    hasConflictMarkers("a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\nb"),
  ).toBe(true);
  expect(hasConflictMarkers("<<<<<<< HEAD\nx\n=======\ny")).toBe(false);
  expect(hasConflictMarkers("Text mit <<<<<<< mitten drin")).toBe(false);
});

it("lists conflicts and reports each one once", () => {
  const texts: Record<string, string> = {
    "Merge.md": "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n",
    "Gut.md": "alles gut",
  };
  const files = [
    "Gut.md",
    "Merge.md",
    "Gut.sync-conflict-20261114-093000-AAA.md",
    "Bild (conflicted copy 2026-11-14).png",
  ];
  const conflicts = findConflicts(files, (path) => texts[path]);
  expect(conflicts).toEqual([
    {
      kind: "copy",
      path: "Gut.sync-conflict-20261114-093000-AAA.md",
      original: "Gut.md",
      tool: "Syncthing",
    },
    { kind: "markers", path: "Merge.md" },
  ]);
  const watcher = new ConflictWatcher();
  expect(watcher.update(conflicts)).toHaveLength(2);
  expect(watcher.update(conflicts)).toHaveLength(0);
  expect(watcher.conflicts).toHaveLength(2);
});

it("scans a note for markers again only after its text changed", () => {
  const watcher = new ConflictWatcher();
  const text = "<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n";
  expect(watcher.markers("A.md", text)).toBe(true);
  expect(watcher.markers("A.md", text)).toBe(true);
  expect(watcher.markers("A.md", "aufgelöst")).toBe(false);
});
