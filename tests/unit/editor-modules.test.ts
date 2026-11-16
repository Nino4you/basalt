import { syntaxTree } from "@codemirror/language";
import * as autocomplete from "@codemirror/autocomplete";
import * as search from "@codemirror/search";
import * as lint from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { parser } from "@lezer/markdown";
import { expect, it } from "vitest";
import { editorModules } from "../../src/compat/editor-modules";
import { obsidianSyntax } from "../../src/editor/syntax";

it("shares host autocomplete classes and uses the host editor state", () => {
  const modules: Readonly<Record<string, unknown>> = editorModules;
  const pluginAutocomplete = modules["@codemirror/autocomplete"] as typeof autocomplete;
  expect(pluginAutocomplete).toBeDefined();
  expect(pluginAutocomplete.CompletionContext).toBe(autocomplete.CompletionContext);
  const state = EditorState.create({ doc: "note" });
  const context = new pluginAutocomplete.CompletionContext(state, 4, false);
  expect(context.matchBefore(/\w+/)).toEqual({ from: 0, to: 4, text: "note" });
});

it("shares host search effects and updates real editor state", () => {
  const modules: Readonly<Record<string, unknown>> = editorModules;
  const pluginSearch = modules["@codemirror/search"] as typeof search;
  expect(pluginSearch).toBeDefined();
  expect(pluginSearch.SearchQuery).toBe(search.SearchQuery);
  expect(pluginSearch.setSearchQuery).toBe(search.setSearchQuery);
  let state = EditorState.create({ doc: "note", extensions: search.search() });
  const query = new pluginSearch.SearchQuery({ search: "note" });
  state = state.update({ effects: pluginSearch.setSearchQuery.of(query) }).state;
  expect(search.getSearchQuery(state)).toBe(query);
});

it("shares lint effects and applies plugin diagnostics to real host state", () => {
  const modules: Readonly<Record<string, unknown>> = editorModules;
  const pluginLint = modules["@codemirror/lint"] as typeof lint;
  expect(pluginLint).toBeDefined();
  expect(pluginLint.setDiagnosticsEffect).toBe(lint.setDiagnosticsEffect);
  let state = EditorState.create({ doc: "note" });
  const diagnostic: lint.Diagnostic = { from: 0, to: 4, severity: "warning", message: "Fixture warning" };
  state = state.update(pluginLint.setDiagnostics(state, [diagnostic])).state;
  expect(lint.diagnosticCount(state)).toBe(1);
  const actual: lint.Diagnostic[] = [];
  lint.forEachDiagnostic(state, value => actual.push(value));
  expect(actual).toEqual([diagnostic]);
  state = state.update({ effects: pluginLint.setDiagnosticsEffect.of([]) }).state;
  expect(lint.diagnosticCount(state)).toBe(0);
});

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
