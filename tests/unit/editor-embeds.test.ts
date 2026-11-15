import { afterEach, expect, it, vi } from "vitest";
import { MarkdownEditor } from "../../src/editor";
import type { EmbedPreviewHost, EmbedSource } from "../../src/editor/embeds";

let editor: MarkdownEditor;
afterEach(() => {
  editor?.view.destroy();
  document.body.replaceChildren();
});

function mount(doc: string, plugin = false) {
  const rendered: EmbedSource[] = [];
  const cleanup = vi.fn();
  const host: EmbedPreviewHost = {
    describe: (embed) =>
      embed.target.startsWith("Missing")
        ? null
        : {
            kind: /\.(png|svg)$/.test(embed.target) ? "image" : "note",
            version: "1",
          },
    render(embed, el) {
      rendered.push(embed);
      el.textContent = `[${embed.target}]`;
      return cleanup;
    },
  };
  const parent = document.createElement("div");
  document.body.append(parent);
  editor = new MarkdownEditor(parent, {
    resolves: () => true,
    openLink: () => {},
    openExternal: () => {},
    openTag: () => {},
    notes: () => [],
    tags: () => [],
    save: () => {},
    onChange: () => {},
    embedPreview: host,
    pluginEmbed: () => (plugin ? ({} as never) : null),
  });
  editor.setState(editor.createState(doc));
  editor.setEditable(true);
  return { parent, rendered, cleanup };
}

it("renders standalone embeds as blocks and images inline", () => {
  const { parent, rendered } = mount(
    "Intro\n\n![[Note#Goals]]\n\nText ![[Photo.png|80]] and ![[Note]] inline.\n\n![alt|50](Pics/A.svg)\n\n![[Missing]]",
  );
  expect(rendered).toEqual([
    { target: "Note#Goals", alias: "", markdown: false },
    { target: "Photo.png", alias: "80", markdown: false },
    { target: "Pics/A.svg", alias: "alt|50", markdown: true },
  ]);
  expect(parent.querySelectorAll(".cm-embed-preview.is-block")).toHaveLength(2);
  expect(parent.querySelectorAll(".cm-embed-preview.is-inline")).toHaveLength(1);
  // An inline note embed stays a link; an unresolved one stays source.
  expect(parent.textContent).toContain("Note");
  expect(parent.textContent).toContain("Missing");
});

it("leaves embeds to plugins that render them and to source mode", () => {
  const plugin = mount("![[Note]]", true);
  expect(plugin.rendered).toEqual([]);
  editor.view.destroy();
  const source = mount("![[Note]]");
  expect(source.rendered).toHaveLength(1);
  editor.configure({ livePreview: false });
  expect(source.parent.querySelector(".cm-embed-preview")).toBeNull();
  expect(source.cleanup).toHaveBeenCalled();
});

it("shows the source of an edited embed line and keeps the embed below", () => {
  const { parent } = mount("Intro\n\n![[Note]]\n");
  const line = editor.view.state.doc.line(3);
  editor.view.dispatch({ selection: { anchor: line.from + 3 } });
  const sourceLine = () =>
    [...parent.querySelectorAll(".cm-line")].some((el) =>
      el.textContent?.includes("Note"),
    );
  expect(parent.querySelector(".cm-embed-preview.is-block")).toBeTruthy();
  expect(sourceLine()).toBe(true);
  editor.view.dispatch({ selection: { anchor: 0 } });
  expect(parent.querySelector(".cm-embed-preview.is-block")).toBeTruthy();
  expect(sourceLine()).toBe(false);
});
