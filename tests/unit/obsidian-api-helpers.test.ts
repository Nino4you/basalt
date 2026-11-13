import { describe, expect, it } from "vitest";
import { createObsidianApi } from "../../src/compat/obsidian-api";

interface FrontMatterInfo {
  exists: boolean;
  frontmatter: string;
  from: number;
  to: number;
  contentStart: number;
}

const api = createObsidianApi({ app: {} }) as unknown as {
  parseYaml(text: string): unknown;
  stringifyYaml(value: unknown): string;
  getFrontMatterInfo(text: string): FrontMatterInfo;
};

describe("frontmatter helpers", () => {
  it("parses YAML into plain values", () => {
    expect(api.parseYaml("tags:\n  - a\n  - b\ntitle: Example\n")).toEqual({
      tags: ["a", "b"],
      title: "Example",
    });
  });

  it("stringifies YAML that parses back to the same value", () => {
    const value = { tags: ["a"], meta: { nested: true } };
    const yaml = api.stringifyYaml(value);
    expect(yaml).not.toContain("---");
    expect(api.parseYaml(yaml)).toEqual(value);
  });

  it("reports the offsets of a frontmatter block", () => {
    const text = "---\ntags: [a]\ntitle: Example\n---\n\nBody";
    const info = api.getFrontMatterInfo(text);
    expect(info.exists).toBe(true);
    expect(info.frontmatter).toBe("tags: [a]\ntitle: Example\n");
    expect(text.slice(info.from, info.to)).toBe(info.frontmatter);
    expect(info.contentStart).toBe(33);
    expect(text.slice(info.contentStart)).toBe("\nBody");
  });

  it("reports an absent block as empty", () => {
    expect(api.getFrontMatterInfo("# Heading\nBody")).toEqual({
      exists: false,
      frontmatter: "",
      from: 0,
      to: 0,
      contentStart: 0,
    });
  });

  it("reports an empty block instead of treating it as body", () => {
    const text = "---\n---\nBody";
    const info = api.getFrontMatterInfo(text);
    expect(info).toEqual({
      exists: true,
      frontmatter: "",
      from: 4,
      to: 4,
      contentStart: 8,
    });
  });

  it("keeps CRLF offsets exact", () => {
    const text = "---\r\ntitle: x\r\n---\r\nBody";
    const info = api.getFrontMatterInfo(text);
    expect(info.exists).toBe(true);
    expect(info.frontmatter).toBe("title: x\r\n");
    expect(info.contentStart).toBe(20);
    expect(text.slice(info.contentStart)).toBe("Body");
  });
});
