import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { Component } from "../../src/compat/component";
import { embedHost, pluginEmbeds } from "../../src/editor/plugin-embeds";
import { codeBlockHost, pluginBlocks } from "../../src/editor/plugin-blocks";
import { obsidianSyntax } from "../../src/editor/syntax";
import { memoryVault } from "../helpers/vault-store";

it.each(["embed", "code block"])("discovers a plugin %s when parsing advances without a document edit", async (kind) => {
  const vault = await memoryVault({ "Table.xlsx": "" });
  const doc = "Paragraph\n\n".repeat(10000) + (kind === "embed" ? "![[Table.xlsx]]\n" : "```fixture\ncontent\n```\n");
  const field = kind === "embed" ? pluginEmbeds : pluginBlocks;
  const state = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, extensions: [obsidianSyntax] }),
      embedHost.of(() => ({
        file: vault.getFileByPath("Table.xlsx")!,
        subpath: "",
        factory: ({ containerEl }) => new (class extends Component {
          loadFile() { containerEl.textContent = "Fixture content"; }
        })(),
      })),
      pluginEmbeds,
      codeBlockHost.of({ processor: () => () => {}, context: () => null }),
      pluginBlocks,
    ],
  });
  expect(syntaxTree(state).length).toBeLessThan(doc.length);
  expect(state.field(field).size).toBe(0);
  expect(ensureSyntaxTree(state, doc.length, 5000)).not.toBeNull();
  const next = state.update({}).state;
  expect(syntaxTree(next).length).toBe(doc.length);
  expect(next.doc.toString()).toBe(doc);
  expect(next.field(field).size).toBe(1);
});
