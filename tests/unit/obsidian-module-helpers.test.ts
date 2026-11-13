import { beforeAll, describe, expect, it } from "vitest";
import { loadIconLibrary } from "../../src/ui/icon-library";
import { createObsidianApi } from "../../src/compat/obsidian-api";

const api = createObsidianApi({ app: {} }) as unknown as {
  requireApiVersion(version: string): boolean;
  addIcon(iconId: string, svgContent: string): void;
  getIcon(iconId: string): SVGSVGElement | null;
  removeIcon(iconId: string): void;
  setIcon(element: HTMLElement, iconId: string): void;
  getIconIds(): string[];
  getLinkpath(linktext: string): string;
  stripHeading(heading: string): string;
  stripHeadingForLink(heading: string): string;
  getAllTags(cache: { tags?: { tag: string }[] } | null): string[] | null;
};

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40"/></svg>';

// Plugin hosts load the full Lucide set before activation; do the same here.
beforeAll(() => loadIconLibrary());
describe("module helpers", () => {
  it("compares the requested API version with the reported one", () => {
    expect(api.requireApiVersion("1.0.0")).toBe(true);
    expect(api.requireApiVersion("1.15.0")).toBe(true);
    expect(api.requireApiVersion("1.15.1")).toBe(false);
    expect(api.requireApiVersion("2.0.0")).toBe(false);
    expect(api.requireApiVersion("not-a-version")).toBe(false);
  });

  it("registers a custom icon and uses it through setIcon", () => {
    api.addIcon("basalt-test", SVG);
    expect(api.getIconIds()).toContain("basalt-test");
    expect(api.getIcon("basalt-test")?.querySelector("circle")).not.toBeNull();
    const element = document.createElement("div");
    api.setIcon(element, "basalt-test");
    expect(element.querySelector("circle")).not.toBeNull();
    expect(api.getIcon("basalt-test")?.getAttribute("width")).toBe("100");
  });

  it("removes a custom icon again", () => {
    api.addIcon("basalt-temp", SVG);
    api.removeIcon("basalt-temp");
    expect(api.getIcon("basalt-temp")).toBeNull();
    expect(api.getIconIds()).not.toContain("basalt-temp");
    const element = document.createElement("div");
    element.textContent = "alt";
    api.setIcon(element, "basalt-temp");
    // An unknown id must not wipe content that is not an icon.
    expect(element.textContent).toBe("alt");
    expect(element.querySelector("svg")).toBeNull();
  });

  it("keeps built-in icon ids alongside custom ones", () => {
    expect(api.getIconIds()).toContain("pencil");
    expect(api.getIcon("pencil")).not.toBeNull();
  });

  it("turns link text into a link path", () => {
    expect(api.getLinkpath("foo#bar")).toBe("foo");
    expect(api.getLinkpath("Ordner/Note#Überschrift|Alias")).toBe(
      "Ordner/Note",
    );
    expect(api.getLinkpath("#Heading")).toBe("");
  });

  it("strips heading punctuation", () => {
    expect(api.stripHeading('foo!"#$%&()*+,.:;<=>?@^`{|}~/[]\\\r\nbar')).toBe(
      "foo bar",
    );
    expect(api.stripHeading("  Gemischt\tund  leer  ")).toBe(
      "Gemischt und leer",
    );
  });

  it("strips the characters that break heading links", () => {
    expect(api.stripHeadingForLink("foo:#|^\r\n%%[[]]bar")).toBe("foo bar");
    expect(api.stripHeadingForLink("1. Einleitung")).toBe("1. Einleitung");
  });

  it("collects unique tags and reports no tags as null", () => {
    expect(
      api.getAllTags({
        tags: [{ tag: "#foo" }, { tag: "#foo" }, { tag: "#bar" }],
      }),
    ).toEqual(["#foo", "#bar"]);
    expect(api.getAllTags({ tags: [] })).toBeNull();
    expect(api.getAllTags(null)).toBeNull();
  });
});
