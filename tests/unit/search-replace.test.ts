import { expect, it } from "vitest";
import { replaceableTerm, replaceTerm } from "../../src/app/search-replace";

it("replaces only a single term, keeping the typed case", () => {
  expect(replaceableTerm("Basalt")).toBe("Basalt");
  expect(replaceableTerm('"zwei Wörter" path:Projekte tag:#x')).toBe(
    "zwei Wörter",
  );
  expect(replaceableTerm("eins zwei")).toBeNull();
  expect(replaceableTerm("#tag")).toBeNull();
  expect(replaceableTerm("-weg path:a")).toBeNull();
  expect(replaceableTerm("")).toBeNull();
  expect(replaceableTerm("/bas.lt/")).toBeNull();
  expect(replaceableTerm("basalt line:(granit)")).toBeNull();
  expect(replaceableTerm("basalt -task:x")).toBeNull();
});

it("replaces like the search finds, or with matching case", () => {
  expect(replaceTerm("Basalt, basalt und BASALT.", "basalt", "Granit")).toEqual(
    {
      text: "Granit, Granit und Granit.",
      count: 3,
    },
  );
  expect(replaceTerm("Basalt, basalt.", "Basalt", "Granit", true)).toEqual({
    text: "Granit, basalt.",
    count: 1,
  });
  expect(replaceTerm("aaa", "aa", "b")).toEqual({ text: "ba", count: 1 });
  expect(replaceTerm("kein Treffer", "x", "y")).toEqual({
    text: "kein Treffer",
    count: 0,
  });
  // Lower-casing "İ" changes the length; such notes are left alone.
  expect(replaceTerm("İstanbul basalt", "basalt", "x").count).toBe(0);
});
