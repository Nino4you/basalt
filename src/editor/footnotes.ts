import { syntaxTree } from "@codemirror/language";
import {
  RangeSetBuilder,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

const REFERENCE = /\[\^([^\]\s]+)\](?!:)|\^\[(?:[^[\]\n]|\[[^\]\n]*\])+\]/g;
const DEFINITION = /^\[\^([^\]\s]+)\]:/;

/** Footnote ids defined in the note, with the first line of their text. */
export function footnoteDefinitions(text: string): Map<string, string> {
  const definitions = new Map<string, string>();
  for (const match of text.matchAll(/^\[\^([^\]\s]+)\]:[ \t]*(.*)$/gm))
    if (!definitions.has(match[1])) definitions.set(match[1], match[2]);
  return definitions;
}

function inCode(state: EditorState, pos: number): boolean {
  for (
    let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(
      state,
    ).resolveInner(pos, 1);
    node;
    node = node.parent
  )
    if (/Code|Math|Frontmatter/.test(node.name)) return true;
  return false;
}

function decorate(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const state = view.state;
  const definitions = footnoteDefinitions(state.doc.toString());
  for (const { from, to } of view.visibleRanges) {
    let line = state.doc.lineAt(from);
    for (;;) {
      const definition = DEFINITION.exec(line.text);
      const marks: Array<[number, number, Decoration]> = [];
      if (definition && !inCode(state, line.from))
        marks.push([
          line.from,
          line.from + definition[0].length,
          Decoration.mark({ class: "cm-footnote-def" }),
        ]);
      for (const match of line.text.matchAll(REFERENCE)) {
        const start = line.from + match.index;
        if (definition && match.index === 0) continue;
        if (inCode(state, start)) continue;
        const text = match[1] !== undefined ? definitions.get(match[1]) : null;
        // A reference without a definition stays plain text, like the reading view.
        if (match[1] !== undefined && text === undefined) continue;
        marks.push([
          start,
          start + match[0].length,
          Decoration.mark({
            class: "cm-footnote-ref",
            attributes: text ? { title: text } : undefined,
          }),
        ]);
      }
      marks.sort((a, b) => a[0] - b[0]);
      for (const [start, end, mark] of marks) builder.add(start, end, mark);
      if (line.to >= to || line.number === state.doc.lines) break;
      line = state.doc.line(line.number + 1);
    }
  }
  return builder.finish();
}

/** Styles footnote references and definitions in the editor. */
export const footnoteMarks: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      )
        this.decorations = decorate(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * "Insert footnote": a reference with the next free number at the cursor and
 * its definition at the end of the note, where the cursor goes to write it.
 */
export function insertFootnote(view: EditorView): boolean {
  if (!view.state.facet(EditorView.editable)) return false;
  const text = view.state.doc.toString();
  const used = new Set<string>();
  for (const match of text.matchAll(/\[\^([^\]\s]+)\]/g)) used.add(match[1]);
  let number = 1;
  while (used.has(String(number))) number++;
  const reference = `[^${number}]`;
  const { from, to } = view.state.selection.main;
  const end = text.length;
  const atEnd = to >= end;
  // The definition starts a paragraph of its own after whatever ends the note.
  const before = atEnd ? text.slice(0, from) + reference : text;
  const separator = before.endsWith("\n\n")
    ? ""
    : before.endsWith("\n")
      ? "\n"
      : "\n\n";
  const definition = `${separator}${reference}: `;
  view.dispatch({
    changes: atEnd
      ? [{ from, to, insert: reference + definition }]
      : [
          { from, to, insert: reference },
          { from: end, insert: definition },
        ],
    selection: {
      anchor: end - (to - from) + reference.length + definition.length,
    },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}
