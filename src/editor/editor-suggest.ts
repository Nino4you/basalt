import type { CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Editor, EditorPosition } from "../compat/editor-adapter";
import type { TFile } from "../compat/files";
import type { EditorSuggestContext } from "../compat/obsidian-api";

export interface EditorSuggestTrigger {
  start: EditorPosition;
  end: EditorPosition;
  query: string;
}

/** Public shape used by the host; matches Obsidian's EditorSuggest without its popup internals. */
export interface EditorSuggestRegistration {
  context: EditorSuggestContext | null;
  limit: number;
  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTrigger | null;
  getSuggestions(context: EditorSuggestContext): unknown[] | Promise<unknown[]>;
  renderSuggestion(value: unknown, el: HTMLElement): void;
  selectSuggestion(value: unknown, event: MouseEvent | KeyboardEvent): void;
  close(): void;
}

export interface EditorSuggestHost {
  editorSuggests?(): readonly EditorSuggestRegistration[];
  editorFile?(): TFile | null;
}

function optionLabel(suggest: EditorSuggestRegistration, value: unknown): string {
  const el = document.createElement("div");
  try {
    suggest.renderSuggestion(value, el);
  } catch (error) {
    console.error("Plugin suggestion rendering failed", error);
  }
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return text || String(value);
}

/**
 * Bridges Obsidian's EditorSuggest registry to the existing CodeMirror 6
 * completion popup. Plugins keep their own contexts and apply their own edits.
 */
export class EditorSuggestBridge {
  readonly events: Extension;
  readonly source: CompletionSource;
  private active: EditorSuggestRegistration | null = null;
  private generation = 0;
  private event: MouseEvent | KeyboardEvent | null = null;

  constructor(
    private readonly host: EditorSuggestHost,
    private readonly editor: () => Editor,
  ) {
    this.events = EditorView.domEventHandlers({
      keydown: (event) => {
        this.event = event;
        if (event.key === "Escape") this.close();
        return false;
      },
      mousedown: (event) => {
        this.event = event;
        return false;
      },
    });
    this.source = (context) => this.complete(context);
  }

  close(): void {
    const active = this.active;
    this.active = null;
    active?.close();
  }

  private async complete(_context: CompletionContext): Promise<CompletionResult | null> {
    const file = this.host.editorFile?.() ?? null;
    const suggests = this.host.editorSuggests?.() ?? [];
    const generation = ++this.generation;
    this.close();
    if (!file || !suggests.length) return null;
    const editor = this.editor();
    for (const suggest of suggests) {
      let trigger: EditorSuggestTrigger | null;
      try {
        trigger = suggest.onTrigger(editor.getCursor(), editor, file);
      } catch (error) {
        console.error("Plugin editor suggestion trigger failed", error);
        continue;
      }
      if (!trigger) continue;
      const context: EditorSuggestContext = { ...trigger, editor, file };
      suggest.context = context;
      let values: unknown[];
      try {
        values = await suggest.getSuggestions(context);
      } catch (error) {
        if (suggest.context === context) suggest.close();
        console.error("Plugin editor suggestions failed", error);
        continue;
      }
      if (generation !== this.generation || suggest.context !== context) return null;
      if (!Array.isArray(values) || !values.length) {
        suggest.close();
        continue;
      }
      const limited = suggest.limit > 0 ? values.slice(0, suggest.limit) : values;
      this.active = suggest;
      return {
        from: editor.posToOffset(trigger.start),
        to: editor.posToOffset(trigger.end),
        filter: false,
        options: limited.map((value) => ({
          label: optionLabel(suggest, value),
          apply: () => {
            if (suggest.context !== context) return;
            const event =
              this.event ?? new KeyboardEvent("keydown", { key: "Enter" });
            this.event = null;
            this.active = null;
            suggest.selectSuggestion(value, event);
          },
        })),
      };
    }
    return null;
  }
}
