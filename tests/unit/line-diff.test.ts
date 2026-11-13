import { describe, expect, it } from "vitest";
import {
  collapseDiff,
  diffLines,
  type DiffLine,
} from "../../src/app/line-diff";

/** Applying a diff must turn `before` into `after` exactly. */
function check(before: string, after: string): DiffLine[] {
  const lines = diffLines(before, after)!;
  expect(
    lines
      .filter((line) => line.type !== "add")
      .map((line) => line.text)
      .join("\n"),
  ).toBe(before);
  expect(
    lines
      .filter((line) => line.type !== "remove")
      .map((line) => line.text)
      .join("\n"),
  ).toBe(after);
  return lines;
}

const changes = (lines: DiffLine[]) =>
  lines.filter((line) => line.type !== "same").length;

describe("diffLines", () => {
  it("marks unchanged text as the same", () => {
    expect(check("a\nb", "a\nb").every((l) => l.type === "same")).toBe(true);
    expect(check("", "")).toEqual([{ type: "same", text: "" }]);
  });

  it("finds a minimal set of changes", () => {
    expect(check("a\nb\nc", "a\nc")).toEqual([
      { type: "same", text: "a" },
      { type: "remove", text: "b" },
      { type: "same", text: "c" },
    ]);
    expect(check("a\nc", "a\nb\nc")).toEqual([
      { type: "same", text: "a" },
      { type: "add", text: "b" },
      { type: "same", text: "c" },
    ]);
    expect(changes(check("a\nb\nc\nd", "x\nb\ny\nd"))).toBe(4);
    expect(changes(check("a\nb\nc\na\nb\nb\na", "c\nb\na\nb\na\nc"))).toBe(5);
  });

  it("reconstructs both texts for random edits", () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let round = 0; round < 200; round++) {
      const words = ["a", "b", "c", "d", ""];
      const pick = () =>
        Array.from(
          { length: Math.floor(random() * 12) },
          () => words[Math.floor(random() * words.length)],
        ).join("\n");
      check(pick(), pick());
    }
  });

  it("gives up on huge rewrites instead of stalling", () => {
    const before = Array.from({ length: 50 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 50 }, (_, i) => `new ${i}`).join("\n");
    expect(diffLines(before, after, 10)).toBeNull();
    expect(changes(diffLines(before, after, 100)!)).toBe(100);
  });
});

describe("collapseDiff", () => {
  it("keeps context around changes and folds the rest", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[10] = "changed";
    const collapsed = collapseDiff(
      diffLines(before.join("\n"), after.join("\n"))!,
      2,
    );
    expect(collapsed[0]).toEqual({ type: "skip", count: 8 });
    expect(collapsed.slice(1, 7).map((line) => line.type)).toEqual([
      "same",
      "same",
      "remove",
      "add",
      "same",
      "same",
    ]);
    expect(collapsed[7]).toEqual({ type: "skip", count: 7 });
  });
});
