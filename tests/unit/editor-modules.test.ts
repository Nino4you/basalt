import { syntaxTree } from "@codemirror/language";
import { parser } from "@lezer/markdown";
import { expect, it } from "vitest";
import { editorModules } from "../../src/compat/editor-modules";
import { obsidianSyntax } from "../../src/editor/syntax";

it("shares the host language runtime and exposes internal-link tokens to plugins", () => {
  const language = editorModules["@codemirror/language"];
  expect(language.syntaxTree).toBe(syntaxTree);
  const source = "[[Note]] and [[Folder/Other#Section|Label]]";
  const links: string[] = [];
  parser
    .configure(obsidianSyntax)
    .parse(source)
    .iterate({
      enter(node) {
        if (node.type.prop(language.tokenClassNodeProp) === "hmd-internal-link")
          links.push(source.slice(node.from, node.to));
      },
    });
  expect(links).toEqual(["Note", "Folder/Other#Section"]);
});
