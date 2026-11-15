import { describe, expect, it } from "vitest";
import { extractSubpath, parseImageSize, splitTarget } from "../../src/subpath";

const NOTE = [
  "---",
  "tags: [x]",
  "---",
  "# Title",
  "Intro",
  "",
  "## Goals",
  "- Fast ^fast",
  "  - really",
  "- Local",
  "",
  "### Details",
  "More",
  "",
  "## Risk: SAF",
  "First line",
  "writes are not atomic. ^risk",
  "",
  "| a | b |",
  "| - | - |",
  "",
  "^table",
  "",
  "```",
  "## Not a heading ^code",
  "```",
].join("\n");

describe("embed subpaths", () => {
  it("splits targets", () => {
    expect(splitTarget("Note#Head#Sub")).toEqual({ name: "Note", subpath: "Head#Sub" });
    expect(splitTarget("Note")).toEqual({ name: "Note", subpath: "" });
  });

  it("extracts a heading with its subsections up to the next sibling", () => {
    expect(extractSubpath(NOTE, "Goals")).toBe(
      "## Goals\n- Fast ^fast\n  - really\n- Local\n\n### Details\nMore",
    );
    expect(extractSubpath(NOTE, "goals")).toContain("## Goals");
    expect(extractSubpath(NOTE, "Goals#Details")).toBe("### Details\nMore");
    expect(extractSubpath(NOTE, "Risk SAF")).toMatch(/^## Risk: SAF\nFirst line/);
    expect(extractSubpath(NOTE, "Not a heading")).toBeNull();
    expect(extractSubpath(NOTE, "Details#Goals")).toBeNull();
  });

  it("extracts paragraphs, list items and preceding blocks by id", () => {
    expect(extractSubpath(NOTE, "^risk")).toBe("First line\nwrites are not atomic.");
    expect(extractSubpath(NOTE, "^fast")).toBe("- Fast\n  - really");
    expect(extractSubpath(NOTE, "^table")).toBe("| a | b |\n| - | - |");
    expect(extractSubpath(NOTE, "^code")).toBeNull();
    expect(extractSubpath(NOTE, "^missing")).toBeNull();
    expect(extractSubpath(NOTE, "^bad id")).toBeNull();
  });

  it("parses image sizes from the alias", () => {
    expect(parseImageSize("300")).toEqual({ alt: "", width: 300 });
    expect(parseImageSize("300x200")).toEqual({ alt: "", width: 300, height: 200 });
    expect(parseImageSize("Foto|120")).toEqual({ alt: "Foto", width: 120 });
    expect(parseImageSize("Foto")).toEqual({ alt: "Foto" });
  });
});
