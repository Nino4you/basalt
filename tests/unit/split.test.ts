import { describe, expect, it } from "vitest";
import {
  cornerGroup,
  dropSideAt,
  groupIds,
  mapGroups,
  normalizeSplit,
  removeGroup,
  sideRect,
  splitGroup,
  type SplitNode,
} from "../../src/app/split";

const row = (...groups: number[]): SplitNode => ({
  direction: "row",
  children: groups.map((group) => ({ group })),
  sizes: groups.map(() => 1),
});

describe("editor split layout", () => {
  it("splits a single group to either side", () => {
    expect(splitGroup({ group: 1 }, 1, "right", 2)).toEqual(row(1, 2));
    expect(splitGroup({ group: 1 }, 1, "top", 2)).toEqual({
      direction: "column",
      children: [{ group: 2 }, { group: 1 }],
      sizes: [1, 1],
    });
  });

  it("joins an existing row and shares the target's room", () => {
    const split = splitGroup(row(1, 2), 2, "left", 3);
    expect(split).toEqual({
      direction: "row",
      children: [{ group: 1 }, { group: 3 }, { group: 2 }],
      sizes: [1, 0.5, 0.5],
    });
    expect(groupIds(split)).toEqual([1, 3, 2]);
  });

  it("nests when the direction differs and leaves the input alone", () => {
    const start = row(1, 2);
    const split = splitGroup(start, 2, "bottom", 3);
    expect(split).toEqual({
      direction: "row",
      children: [
        { group: 1 },
        {
          direction: "column",
          children: [{ group: 2 }, { group: 3 }],
          sizes: [1, 1],
        },
      ],
      sizes: [1, 1],
    });
    expect(start).toEqual(row(1, 2));
    expect(cornerGroup(split, "left")).toBe(1);
    expect(cornerGroup(split, "right")).toBe(2);
  });

  it("dissolves branches when groups are removed", () => {
    const split = splitGroup(row(1, 2), 2, "bottom", 3);
    expect(removeGroup(split, 3)).toEqual(row(1, 2));
    // The column that is left moves up into the row's place.
    expect(removeGroup(split, 1)).toEqual({
      direction: "column",
      children: [{ group: 2 }, { group: 3 }],
      sizes: [1, 1],
    });
    expect(removeGroup({ group: 1 }, 1)).toBeNull();
    expect(removeGroup(row(1, 2), 9)).toEqual(row(1, 2));
  });

  it("merges a nested branch of the same direction, keeping proportions", () => {
    const nested: SplitNode = {
      direction: "row",
      children: [
        { group: 1 },
        {
          direction: "column",
          children: [{ group: 2 }, row(3, 4)],
          sizes: [1, 1],
        },
      ],
      sizes: [1, 3],
    };
    expect(removeGroup(nested, 2)).toEqual({
      direction: "row",
      children: [{ group: 1 }, { group: 3 }, { group: 4 }],
      sizes: [1, 1.5, 1.5],
    });
  });

  it("maps a pointer position to a split side or the middle", () => {
    const rect = { left: 100, top: 0, right: 700, bottom: 300 };
    expect(dropSideAt(150, 150, rect)).toBe("left");
    expect(dropSideAt(650, 150, rect)).toBe("right");
    expect(dropSideAt(400, 20, rect)).toBe("top");
    expect(dropSideAt(400, 280, rect)).toBe("bottom");
    expect(dropSideAt(400, 150, rect)).toBe("center");
    expect(sideRect(rect, "right")).toEqual({ ...rect, left: 400 });
    expect(sideRect(rect, "top")).toEqual({ ...rect, bottom: 150 });
    expect(sideRect(rect, "center")).toEqual(rect);
  });

  it("repairs stored layouts", () => {
    expect(normalizeSplit(null, 1)).toEqual({ group: 0 });
    expect(normalizeSplit("nonsense", 2)).toEqual(row(0, 1));
    expect(
      normalizeSplit(
        {
          direction: "column",
          children: [{ group: 1 }, { group: 1 }, { group: 7 }, { group: 0 }],
          sizes: [2, 1, 1, -4],
        },
        3,
      ),
    ).toEqual({
      direction: "row",
      children: [
        {
          direction: "column",
          children: [{ group: 1 }, { group: 0 }],
          sizes: [2, 1],
        },
        { group: 2 },
      ],
      sizes: [1, 1],
    });
    expect(mapGroups(row(0, 1), (index) => index + 10)).toEqual(row(10, 11));
  });
});
