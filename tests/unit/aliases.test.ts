import { describe, expect, it } from "vitest";
import { scanNote, VaultIndex } from "../../src/app/vault-index";

const aliases = (frontmatter: string) =>
  scanNote(`---\n${frontmatter}\n---\nBody`).aliases;

describe("frontmatter aliases", () => {
  it("reads the usual ways of writing them", () => {
    expect(aliases('aliases: [Lava rock, "Rock, black"]')).toEqual([
      "Lava rock",
      "Rock, black",
    ]);
    expect(aliases("aliases:\n  - Lava rock\n  - 'Columns'")).toEqual([
      "Lava rock",
      "Columns",
    ]);
    expect(aliases("alias: Lava rock")).toEqual(["Lava rock"]);
    expect(aliases("aliases: a, b, a")).toEqual(["a", "b"]);
    expect(aliases("title: x")).toEqual([]);
    expect(scanNote("aliases: [x]").aliases).toEqual([]);
  });
});

describe("aliases in the index", () => {
  it("finds unlinked mentions of names and aliases, longest first", () => {
    const index = new VaultIndex();
    index.setFiles(["Basalt.md", "Trip.md"]);
    index.setContent(
      "Basalt.md",
      "---\naliases: [Basalt rock, lava]\n---\nRock.",
    );
    index.setContent(
      "Trip.md",
      "A basalt rock and some lava, then basalt again.",
    );
    expect(index.namesOf("Basalt.md")).toEqual([
      "Basalt",
      "Basalt rock",
      "lava",
    ]);
    const text = "A basalt rock and some lava, then basalt again.";
    expect(
      index
        .unlinkedMentions("Basalt.md")
        .map(({ col, length }) => text.slice(col, col + length)),
    ).toEqual(["basalt rock", "lava", "basalt"]);
  });
});
