import { describe, expect, it } from "vitest";
import { createObsidianApi } from "../../src/compat/obsidian-api";

const api = createObsidianApi({ app: {} }) as unknown as {
  parseFrontMatterEntry(frontmatter: unknown, key: string | RegExp): unknown;
  parseFrontMatterStringArray(
    frontmatter: unknown,
    key: string | RegExp,
  ): string[] | null;
  parseFrontMatterTags(frontmatter: unknown): string[] | null;
  parseFrontMatterAliases(frontmatter: unknown): string[] | null;
};

describe("frontmatter readers", () => {
  it("reads an entry by name or pattern", () => {
    expect(api.parseFrontMatterEntry({ foo: "bar" }, "foo")).toBe("bar");
    expect(api.parseFrontMatterEntry({ baz: "qux" }, /ba./)).toBe("qux");
    expect(api.parseFrontMatterEntry({ foo: "bar" }, "nope")).toBeNull();
    expect(api.parseFrontMatterEntry(null, "foo")).toBeNull();
  });

  it("reads a string array and trims values", () => {
    expect(
      api.parseFrontMatterStringArray({ foo: ["bar", " baz "] }, "foo"),
    ).toEqual(["bar", "baz"]);
    expect(api.parseFrontMatterStringArray({ foo: "bar baz" }, "foo")).toEqual([
      "bar baz",
    ]);
    expect(
      api.parseFrontMatterStringArray({ foo: ["bar", "baz"] }, /fo./),
    ).toEqual(["bar", "baz"]);
    expect(api.parseFrontMatterStringArray({ bar: 1 }, "foo")).toBeNull();
  });

  it("normalises tags with a leading hash", () => {
    expect(api.parseFrontMatterTags({ tags: ["foo", "#bar"] })).toEqual([
      "#foo",
      "#bar",
    ]);
    expect(api.parseFrontMatterTags({ tags: "baz" })).toEqual(["#baz"]);
    expect(api.parseFrontMatterTags({})).toBeNull();
  });

  it("reads aliases", () => {
    expect(api.parseFrontMatterAliases({ aliases: ["foo", "bar"] })).toEqual([
      "foo",
      "bar",
    ]);
    expect(api.parseFrontMatterAliases({ aliases: "baz" })).toEqual(["baz"]);
    expect(api.parseFrontMatterAliases({})).toBeNull();
  });
});
