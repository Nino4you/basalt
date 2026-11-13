import { beforeEach, describe, expect, it } from "vitest";
import { BrowserBackend, DEMO_VERSIONS } from "../../src/backend";
import { isDocumentBackup, parseBackup } from "../../src/backups";

describe("parseBackup", () => {
  it("recognizes both layouts like vault-core", () => {
    expect(
      parseBackup(".basalt/history/A/b.md/1700000000123456789-42-0.md", 7),
    ).toEqual({
      kind: "version",
      path: "A/b.md",
      location: ".basalt/history/A/b.md/1700000000123456789-42-0.md",
      time: 1_700_000_000_123,
      size: 7,
    });
    expect(
      parseBackup(".basalt/trash/1700000000000000000-3/A/c.canvas"),
    ).toMatchObject({
      kind: "deleted",
      path: "A/c.canvas",
      time: 1_700_000_000_000,
    });
    expect(parseBackup(".basalt/trash/some-uuid/n.md")?.time).toBe(0);
    for (const location of [
      ".basalt/history/a.md",
      ".basalt/history/a.md/1.txt",
      ".basalt/history/.hidden.md/1-0.md",
      ".basalt/trash/1",
      ".basalt/trash/1/../x.md",
      ".basalt/history2/a.md/1.md",
      "notes/a.md",
    ])
      expect(parseBackup(location), location).toBeNull();
  });

  it("only treats text backups of notes and canvases as documents", () => {
    const document = (location: string) =>
      isDocumentBackup(parseBackup(location)!);
    expect(document(".basalt/history/a.md/1-0.md")).toBe(true);
    expect(document(".basalt/history/a.canvas/1-0.md")).toBe(true);
    expect(document(".basalt/history/a.ink/1-0.bin")).toBe(false);
    expect(document(".basalt/history/a.md/1-0.bin")).toBe(false);
    expect(document(".basalt/trash/1-0/b.canvas")).toBe(true);
    expect(document(".basalt/trash/1-0/b.png")).toBe(false);
  });
});

describe("browser demo backups", () => {
  beforeEach(() => localStorage.removeItem("basalt-demo-v1"));

  it("keeps previous versions and deleted files, newest first", async () => {
    const vault = new BrowserBackend();
    await vault.create("Note.md", "one");
    await vault.save("Note.md", "two", "one");
    await vault.save("Note.md", "two", "two");
    await vault.save("Note.md", "three", "two");
    await vault.create("Gone.md", "bye");
    await vault.remove("Gone.md", "bye");

    const backups = await vault.backups();
    expect(backups.map(({ kind, path }) => [kind, path])).toEqual([
      ["deleted", "Gone.md"],
      ["version", "Note.md"],
      ["version", "Note.md"],
    ]);
    expect(
      await Promise.all(backups.map((b) => vault.readBackup(b.location))),
    ).toEqual(["bye", "two", "one"]);
    expect(backups[0].size).toBe(3);
    expect((await vault.info()).files).not.toContain(backups[0].location);
  });

  it("keeps only the newest versions of a note", async () => {
    const vault = new BrowserBackend();
    await vault.create("Note.md", "0");
    for (let i = 1; i <= DEMO_VERSIONS + 5; i++)
      await vault.save("Note.md", String(i), String(i - 1));
    const versions = await vault.backups();
    expect(versions).toHaveLength(DEMO_VERSIONS);
    expect(await vault.readBackup(versions[0].location)).toBe(
      String(DEMO_VERSIONS + 4),
    );
  });

  it("refuses to read anything that is not a document backup", async () => {
    const vault = new BrowserBackend();
    await vault.create("Note.md", "secret");
    await expect(vault.readBackup("Note.md")).rejects.toThrow();
    await expect(
      vault.readBackup(".basalt/history/Note.md/1-0.md"),
    ).rejects.toThrow();
  });
});
