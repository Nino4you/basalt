import { describe, expect, it } from "vitest";
import { findUnlinkedMentions, VaultIndex } from "../../src/app/vault-index";

const words = (text: string, name: string) =>
  findUnlinkedMentions(text, name).map(({ line, col, length }) =>
    text.split("\n")[line].slice(col, col + length),
  );

describe("findUnlinkedMentions", () => {
  it("finds whole words in any case", () => {
    expect(words("Basalt, basalt and BASALT.", "Basalt")).toEqual([
      "Basalt",
      "basalt",
      "BASALT",
    ]);
    expect(words("Basalts and subasalt", "Basalt")).toEqual([]);
    expect(words("Über Grüße", "Grüße")).toEqual(["Grüße"]);
    expect(words("Plan (v2) and Plan [v2]", "Plan (v2)")).toEqual([
      "Plan (v2)",
    ]);
  });

  it("skips links, code, frontmatter, tags, paths and URLs", () => {
    const text = [
      "---",
      "title: Basalt",
      "---",
      "[[Basalt]] [about](Basalt.md) `Basalt` #Basalt",
      "Rocks/Basalt https://example.com/Basalt",
      "```",
      "Basalt",
      "```",
      "real Basalt here",
    ].join("\n");
    expect(findUnlinkedMentions(text, "Basalt")).toEqual([
      { line: 8, col: 5, length: 6 },
    ]);
  });
});

describe("VaultIndex.unlinkedMentions", () => {
  it("lists other notes that name the note without linking it", () => {
    const index = new VaultIndex();
    index.setFiles(["Basalt.md", "Trip.md", "Linked.md", "Board.canvas"]);
    index.setContent("Basalt.md", "Basalt is a rock.");
    index.setContent("Trip.md", "Saw basalt columns.\nMore basalt.");
    index.setContent("Linked.md", "See [[Basalt]].");
    index.setContent(
      "Board.canvas",
      JSON.stringify({
        nodes: [
          {
            id: "a",
            type: "text",
            text: "Basalt",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
          },
        ],
        edges: [],
      }),
    );
    expect(
      index
        .unlinkedMentions("Basalt.md")
        .map(({ source, line, text }) => [source, line, text]),
    ).toEqual([
      ["Trip.md", 0, "Saw basalt columns."],
      ["Trip.md", 1, "More basalt."],
    ]);
  });
});
