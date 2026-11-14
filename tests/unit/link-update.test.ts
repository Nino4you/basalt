import { describe, expect, it } from "vitest";
import { LinkUpdate } from "../../src/app/link-update";
import { scanNote } from "../../src/app/vault-index";

const files = [
  "Home.md",
  "Old.md",
  "Notes/Other.md",
  "Notes/Sibling.md",
  "Archive/Plan.md",
  "image.png",
  "Board.canvas",
];

const rename = (from: string, to: string, list = files) =>
  new LinkUpdate(list, new Map([[from, to]]));

describe("LinkUpdate.rewriteNote", () => {
  it("rewrites wiki links, embeds, headings and aliases", () => {
    const update = rename("Old.md", "New.md");
    expect(
      update.rewriteNote(
        "See [[Old]], [[Old#Intro|the intro]], ![[Old^block]] and [[Old.md]].",
        "Home.md",
      ),
    ).toBe(
      "See [[New]], [[New#Intro|the intro]], ![[New^block]] and [[New.md]].",
    );
  });

  it("keeps the folder style of a link and uses a path when a name is ambiguous", () => {
    const moved = rename("Old.md", "Notes/Old.md");
    // A unique name still finds the file in its new folder: nothing to do.
    expect(moved.rewriteNote("[[Old]] [[Old|x]]", "Home.md")).toBeNull();
    expect(moved.rewriteNote("[[Notes/Other]]", "Home.md")).toBeNull();
    const ambiguous = rename("Old.md", "Notes/Plan.md");
    // "Plan" is taken by Archive/Plan.md, so the new link needs its folder.
    expect(ambiguous.rewriteNote("[[Old]]", "Home.md")).toBe("[[Notes/Plan]]");
    // And links that used to mean Archive/Plan.md by name alone keep meaning it.
    expect(ambiguous.rewriteNote("[[Plan]]", "Home.md")).toBe(
      "[[Archive/Plan]]",
    );
  });

  it("rewrites Markdown links with their encoding and title", () => {
    const update = rename("Old.md", "Notes/New Name.md");
    expect(
      update.rewriteNote('[a](Old.md) [b](Old.md#Top "Title")', "Home.md"),
    ).toBe('[a](New%20Name.md) [b](New%20Name.md#Top "Title")');
    const back = rename("Notes/Other.md", "Other (2).md");
    expect(back.rewriteNote("[c](Notes/Other.md)", "Home.md")).toBe(
      "[c](Other%20%282%29.md)",
    );
  });

  it("fixes relative links inside the moved note itself", () => {
    const update = rename("Notes/Other.md", "Other.md");
    // [[Sibling]] found Notes/Sibling.md through the shared folder.
    // Still unique by name after the move, and self links move along.
    expect(
      update.rewriteNote(
        "[[Sibling]] and [[#Local heading]]",
        "Notes/Other.md",
      ),
    ).toBeNull();
    const crowded = rename("Notes/Other.md", "Other.md", [
      ...files,
      "Elsewhere/Sibling.md",
    ]);
    expect(crowded.rewriteNote("[[Sibling]]", "Notes/Other.md")).toBe(
      "[[Notes/Sibling]]",
    );
  });

  it("leaves code, unresolved links and unrelated links alone", () => {
    const update = rename("Old.md", "New.md");
    const text = [
      "`[[Old]]` [[Missing]] [[Home]] [site](https://example.com/Old.md)",
      "```",
      "[[Old]]",
      "```",
    ].join("\n");
    expect(update.rewriteNote(text, "Home.md")).toBeNull();
  });

  it("lists exactly the notes whose links would change", () => {
    const update = rename("Old.md", "New.md");
    expect(update.affects("Home.md", scanNote("[[Old]]").links)).toBe(true);
    expect(update.affects("Home.md", scanNote("[[Home]]").links)).toBe(false);
  });
});

describe("LinkUpdate.rewriteCanvas", () => {
  it("moves file cards and links in card text, keeping unknown fields", () => {
    const update = rename("Old.md", "Notes/Old.md");
    const canvas = JSON.stringify({
      nodes: [
        {
          id: "a",
          type: "file",
          file: "Old.md",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          extra: 1,
        },
        {
          id: "b",
          type: "text",
          text: "[[Old.md]]",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
        {
          id: "c",
          type: "file",
          file: "image.png",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      ],
      edges: [],
      custom: true,
    });
    const next = JSON.parse(update.rewriteCanvas(canvas, "Board.canvas")!);
    expect(next.nodes[0]).toMatchObject({ file: "Notes/Old.md", extra: 1 });
    expect(next.nodes[1].text).toBe("[[Old.md]]");
    expect(next.nodes[2].file).toBe("image.png");
    expect(next.custom).toBe(true);
    expect(
      update.rewriteCanvas(
        JSON.stringify({ nodes: [], edges: [] }),
        "Board.canvas",
      ),
    ).toBeNull();
  });
});
