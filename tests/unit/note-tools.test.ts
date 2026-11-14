import { describe, expect, it } from "vitest";
import {
  mergeNoteText,
  pickRandomNote,
  suggestNoteName,
  uniqueNotePath,
  wikiLinkTo,
} from "../../src/app/note-tools";

describe("random note", () => {
  const files = ["a.md", "b.md", "c.canvas", "img.png", "d/e.md"];

  it("picks only Markdown notes other than the current one", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++)
      seen.add(pickRandomNote(files, "b.md", () => i / 10)!);
    expect([...seen].sort()).toEqual(["a.md", "d/e.md"]);
  });

  it("returns null without another note and survives random() = 1", () => {
    expect(pickRandomNote(["a.md", "x.canvas"], "a.md")).toBeNull();
    expect(pickRandomNote(["a.md", "b.md"], null, () => 1)).toBe("b.md");
  });
});

describe("unique note path", () => {
  const date = new Date(2026, 10, 14, 9, 5);

  it("names the note after the timestamp in the folder", () => {
    expect(uniqueNotePath("Zettel/", "YYYYMMDDHHmm", date, () => false)).toBe(
      "Zettel/202611140905.md",
    );
    expect(uniqueNotePath("", "", date, () => false)).toBe("202611140905.md");
  });

  it("moves on by a minute when the name is taken", () => {
    const taken = new Set(["202611140905.md", "202611140906.md"]);
    expect(uniqueNotePath("", "YYYYMMDDHHmm", date, (p) => taken.has(p))).toBe(
      "202611140907.md",
    );
  });

  it("counts up for formats without minutes", () => {
    const taken = new Set(["2026-11-14.md", "2026-11-14 1.md"]);
    expect(uniqueNotePath("", "YYYY-MM-DD", date, (p) => taken.has(p))).toBe(
      "2026-11-14 2.md",
    );
  });

  it("replaces characters that are not allowed in file names", () => {
    expect(uniqueNotePath("", "HH:mm", date, () => false)).toBe("09-05.md");
  });
});

describe("merge notes", () => {
  it("appends the source body to the target", () => {
    expect(mergeNoteText("# Target\n\nOne\n", "Two\n")).toBe(
      "# Target\n\nOne\n\nTwo\n",
    );
    expect(mergeNoteText("", "Two")).toBe("Two\n");
  });

  it("merges properties: adds missing keys, unions lists, keeps target values", () => {
    const target = "---\ntitle: Target\ntags:\n  - a\n---\nBody\n";
    const source =
      "---\ntitle: Source\ntags: [a, b]\naliases: Src\nstatus: done\n---\nMore\n";
    expect(mergeNoteText(target, source)).toBe(
      "---\ntitle: Target\ntags:\n  - a\n  - b\naliases: Src\nstatus: done\n---\nBody\n\nMore\n",
    );
  });

  it("gives a target without frontmatter the source's properties", () => {
    expect(mergeNoteText("Body\n", "---\ntags: [x]\n---\nMore\n")).toBe(
      "---\ntags:\n  - x\n---\nBody\n\nMore\n",
    );
  });

  it("keeps unparsable source YAML as a code block instead of dropping it", () => {
    expect(mergeNoteText("Body\n", "---\na: [\n---\nMore\n")).toBe(
      "Body\n\n```yaml\na: [\n```\n\nMore\n",
    );
  });

  it("keeps the target's frontmatter untouched when the source has none", () => {
    const target = "---\n# comment\ntitle: x\n---\nBody\n";
    expect(mergeNoteText(target, "More")).toBe(
      "---\n# comment\ntitle: x\n---\nBody\n\nMore\n",
    );
  });
});

describe("extract selection", () => {
  it("suggests the first heading or line as the name", () => {
    expect(suggestNoteName("\n## Ideas: next/steps\nbody")).toBe(
      "Ideas next steps",
    );
    expect(suggestNoteName("- [ ] Call **Anna** about [[Plan|the plan]]")).toBe(
      "Call Anna about the plan",
    );
    expect(suggestNoteName("x".repeat(80))).toHaveLength(60);
    expect(suggestNoteName("   ")).toBe("");
  });

  it("links by bare name unless that would be ambiguous", () => {
    expect(wikiLinkTo(["a.md"], "Ideas.md", "a.md")).toBe("[[Ideas]]");
    expect(
      wikiLinkTo(["a.md", "x/Ideas.md"], "y/Ideas.md", "a.md"),
    ).toBe("[[y/Ideas]]");
  });
});
