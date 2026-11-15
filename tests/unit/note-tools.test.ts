import { describe, expect, it } from "vitest";
import {
  mergeNoteText,
  suggestNoteName,
  wikiLinkTo,
} from "../../src/app/note-tools";

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
