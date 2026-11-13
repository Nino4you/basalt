import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";

export interface CompletionHost {
  /** Link text to insert plus the folder shown as detail. */
  notes(): Array<{ link: string; detail: string }>;
  tags(): string[];
}

function applyWikiLink(
  view: EditorView,
  completion: Completion,
  from: number,
  to: number,
): void {
  const closed = view.state.doc.sliceString(to, to + 2) === "]]";
  const insert = completion.label + (closed ? "" : "]]");
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + completion.label.length + 2 },
    userEvent: "input.complete",
  });
}

export function completionSources(host: CompletionHost): CompletionSource[] {
  const wiki = (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\[\[[^\]\[|#\n]*/);
    if (!match) return null;
    return {
      from: match.from + 2,
      options: host.notes().map((note) => ({
        label: note.link,
        detail: note.detail,
        type: "file",
        apply: applyWikiLink,
      })),
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
  return [wiki, tag];
}
