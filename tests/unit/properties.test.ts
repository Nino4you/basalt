import { afterEach, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  frontmatterRange,
  Properties,
  replaceFrontmatter,
} from "../../src/editor/properties-model";
import {
  addProperty,
  propertiesEditor,
  propertiesFacet,
} from "../../src/editor/properties";
import { renderedFacet } from "../../src/editor/live-preview";

afterEach(() => document.body.replaceChildren());

it("finds the frontmatter block", () => {
  const text = "---\na: 1\n---\n# Titel";
  expect(frontmatterRange(text)).toEqual({
    from: 0,
    to: 12,
    yamlFrom: 4,
    yamlTo: 8,
  });
  expect(frontmatterRange("---\n---\nText")).toEqual({
    from: 0,
    to: 7,
    yamlFrom: 4,
    yamlTo: 4,
  });
  expect(frontmatterRange("Text\n---\na: 1\n---")).toBeNull();
  expect(frontmatterRange("---\na: 1\n")).toBeNull();
});

it("infers property types like Obsidian", () => {
  const properties = Properties.parse(
    [
      "title: Hallo",
      "tags: projekt",
      "aliases: [A, B]",
      "done: true",
      "count: 3",
      "due: 2026-11-14",
      "at: 2026-11-14T09:30",
      "list:",
      "  - x",
      "nested:",
      "  a: 1",
      "empty:",
    ].join("\n"),
  )!;
  expect(properties.entries()).toEqual([
    { key: "title", type: "text", value: "Hallo" },
    { key: "tags", type: "list", value: ["projekt"] },
    { key: "aliases", type: "list", value: ["A", "B"] },
    { key: "done", type: "checkbox", value: true },
    { key: "count", type: "number", value: "3" },
    { key: "due", type: "date", value: "2026-11-14" },
    { key: "at", type: "datetime", value: "2026-11-14T09:30" },
    { key: "list", type: "list", value: ["x"] },
    { key: "nested", type: "complex", value: "a: 1\n" },
    { key: "empty", type: "text", value: "" },
  ]);
  expect(Properties.parse("a: [")).toBeNull();
  expect(Properties.parse("- a")).toBeNull();
});

it("edits values in place and keeps comments and list style", () => {
  const properties = Properties.parse(
    "# Kopf\ntitle: Alt # bleibt\naliases: [A]\ntags:\n  - x\ncount: 2",
  )!;
  properties.set("title", "Neu: mit Doppelpunkt", "text");
  properties.set("aliases", ["A", "B"], "list");
  properties.set("tags", ["x", "y"], "list");
  properties.set("count", "4.5", "number");
  expect(properties.toString()).toBe(
    '# Kopf\ntitle: "Neu: mit Doppelpunkt" # bleibt\naliases: [ A, B ]\ntags:\n  - x\n  - y\ncount: 4.5',
  );
  expect(properties.rename("count", "title")).toBe(false);
  expect(properties.rename("count", "anzahl")).toBe(true);
  properties.remove("aliases");
  expect(properties.add("tags")).toBe(false);
  expect(properties.add("status")).toBe(true);
  properties.set("title", "", "text");
  expect(properties.toString()).toBe(
    "# Kopf\ntitle: # bleibt\ntags:\n  - x\n  - y\nanzahl: 4.5\nstatus:",
  );
});

it("replaces, creates and drops the frontmatter block", () => {
  const apply = (text: string, yaml: string) => {
    const change = replaceFrontmatter(text, yaml);
    return text.slice(0, change.from) + change.insert + text.slice(change.to);
  };
  expect(apply("---\na: 1\n---\nText", "a: 2")).toBe("---\na: 2\n---\nText");
  expect(apply("---\n---\nText", "a: 2")).toBe("---\na: 2\n---\nText");
  expect(apply("Text", "a: 2")).toBe("---\na: 2\n---\nText");
  expect(apply("---\na: 1\n---\nText", "")).toBe("Text");
});

function editor(text: string, anchor = text.length) {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text,
      selection: { anchor },
      extensions: [
        renderedFacet.of(true),
        propertiesFacet.of(true),
        propertiesEditor,
        EditorView.editable.of(true),
      ],
    }),
  });
}

it("shows fields that write back to the YAML", () => {
  const view = editor("---\ntitle: Alt\ndone: false\ntags: [a]\n---\nText");
  const widget = view.dom.querySelector(".cm-properties")!;
  expect(widget).not.toBeNull();
  const title = widget.querySelector<HTMLInputElement>(
    '[data-property-key="title"] input.metadata-input',
  )!;
  expect(title.value).toBe("Alt");
  title.value = "Neu";
  title.dispatchEvent(new Event("change"));
  expect(view.state.doc.toString()).toContain("title: Neu\n");

  const done = view.dom.querySelector<HTMLInputElement>(
    '[data-property-key="done"] input[type="checkbox"]',
  )!;
  done.checked = true;
  done.dispatchEvent(new Event("change"));
  expect(view.state.doc.toString()).toContain("done: true\n");

  const tag = view.dom.querySelector<HTMLInputElement>(
    '[data-property-key="tags"] .multi-select-input',
  )!;
  tag.value = "#b";
  tag.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(view.state.doc.toString()).toContain("tags: [ a, b ]\n");

  view.dom
    .querySelector<HTMLButtonElement>(
      '[data-property-key="tags"] .metadata-property-remove',
    )!
    .click();
  expect(view.state.doc.toString()).not.toContain("tags");
  view.destroy();
});

it("shows the YAML when the cursor is inside or the YAML is broken", () => {
  const inside = editor("---\na: 1\n---\nText", 5);
  expect(inside.dom.querySelector(".cm-properties")).toBeNull();
  inside.destroy();
  const broken = editor("---\na: [\n---\nText");
  expect(broken.dom.querySelector(".cm-properties")).toBeNull();
  broken.destroy();
  const opened = editor("---\na: 1\n---\nText", 0);
  expect(opened.dom.querySelector(".cm-properties")).not.toBeNull();
  opened.destroy();
});

it("adds a property, creating the block when needed", async () => {
  const view = editor("Text");
  expect(addProperty(view)).toBe(true);
  expect(view.state.doc.toString()).toBe("---\n---\nText");
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const key = view.dom.querySelector<HTMLInputElement>(
    ".metadata-property.is-new input",
  )!;
  expect(document.activeElement).toBe(key);
  key.value = "status";
  key.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(view.state.doc.toString()).toBe("---\nstatus:\n---\nText");
  view.destroy();
});
