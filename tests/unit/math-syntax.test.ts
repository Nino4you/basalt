import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { obsidianSyntax } from "../../src/editor/syntax";

function math(source: string) {
  const state = EditorState.create({
    doc: source,
    extensions: [
      markdown({ base: markdownLanguage, extensions: [obsidianSyntax] }),
    ],
  });
  const nodes: string[] = [];
  syntaxTree(state).iterate({
    enter(n) {
      if (n.name === "InlineMath" || n.name === "BlockMath")
        nodes.push(state.sliceDoc(n.from, n.to));
    },
  });
  return nodes;
}
it("parses exact formula ranges without Markdown interpreting the expression", () => {
  expect(math("Text $x^2$ und $\\frac{a_*}{b}$\n\n$$\nx+y\n$$")).toEqual([
    "$x^2$",
    "$\\frac{a_*}{b}$",
    "$$\nx+y\n$$",
  ]);
  expect(math("$$x+y$$")).toEqual(["$$x+y$$"]);
  expect(math("$$\nx+y\n\nz+w\n$$")).toEqual(["$$\nx+y\n\nz+w\n$$"]);
});
it("keeps currency, escapes, incomplete math, code and frontmatter as source", () => {
  expect(
    math(
      "---\nx: $a$\n---\n`$x$` und \\$y$ und $5 und $10\n\n```tex\n$x$\n```\n\n$offen",
    ),
  ).toEqual([]);
});
