import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";

export interface CompletionHost {
  /**
   * Link text to insert plus the folder shown as detail; with `alias`, the
   * alias is offered and inserted as `link|alias`.
   */
  notes(): Array<{ link: string; detail: string; alias?: string }>;
  tags(): string[];
  /**
   * Headings (`[[Note#`) or block ids (`[[Note#^`) of the note a link target
   * names; an empty target is the note being edited.
   */
  subpaths?(
    target: string,
    blocks: boolean,
  ): Array<{ label: string; detail?: string }>;
}

function insertWikiLink(
  view: EditorView,
  text: string,
  from: number,
  to: number,
): void {
  const closed = view.state.doc.sliceString(to, to + 2) === "]]";
  view.dispatch({
    changes: { from, to, insert: text + (closed ? "" : "]]") },
    selection: { anchor: from + text.length + 2 },
    userEvent: "input.complete",
  });
}

function applyWikiLink(
  view: EditorView,
  completion: Completion,
  from: number,
  to: number,
): void {
  insertWikiLink(view, completion.label, from, to);
}

export function completionSources(host: CompletionHost): CompletionSource[] {
  const wiki = (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\[\[[^\]\[|#\n]*/);
    if (!match) return null;
    return {
      from: match.from + 2,
      options: host.notes().map((note) =>
        note.alias === undefined
          ? {
              label: note.link,
              detail: note.detail,
              type: "file",
              apply: applyWikiLink,
            }
          : {
              label: note.alias,
              detail: note.detail,
              type: "text",
              apply: (
                view: EditorView,
                _: Completion,
                from: number,
                to: number,
              ) => insertWikiLink(view, `${note.link}|${note.alias}`, from, to),
            },
      ),
      validFor: /^[^\]\[|#\n]*$/,
    };
  };
  const tag = (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/(?:^|[\s(])#[\p{L}\p{N}_/-]*/u);
    if (!match) return null;
    const hash = match.text.indexOf("#");
    // `# ` at the start of a line is a heading, not a tag.
    if (!context.explicit && match.text.length - hash < 2) return null;
    const tags = host.tags();
    if (!tags.length) return null;
    return {
      from: match.from + hash + 1,
      options: tags.map((name) => ({ label: name, type: "tag" })),
      validFor: /^[\p{L}\p{N}_/-]*$/u,
    };
  };
  const subpath = (context: CompletionContext): CompletionResult | null => {
    if (!host.subpaths) return null;
    const match = context.matchBefore(/\[\[[^\]\[|#\n]*#\^?[^\]\[|#\n]*/);
    if (!match) return null;
    const hash = match.text.indexOf("#");
    const target = match.text.slice(2, hash);
    const block = match.text[hash + 1] === "^";
    const from = match.from + hash + (block ? 2 : 1);
    const options = host.subpaths(target, block);
    if (!options.length) return null;
    return {
      from,
      options: options.map((option) => ({
        label: option.label,
        detail: option.detail,
        type: block ? "constant" : "keyword",
        apply: applyWikiLink,
      })),
      validFor: /^[^\]\[|#^\n]*$/,
    };
  };
  return [wiki, subpath, tag];
}
