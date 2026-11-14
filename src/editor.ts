import { t } from "./i18n";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { indentOnInput, syntaxHighlighting } from "@codemirror/language";
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from "@codemirror/search";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { Editor } from "./compat/editor-adapter";
import { EditorExtensionRegistry } from "./compat/editor-extensions";
import type { PluginEmbed } from "./compat/embeds";
import { embedHost, pluginEmbeds } from "./editor/plugin-embeds";
import {
  attachmentHandlers,
  attachmentHost,
  type AttachmentHost,
} from "./editor/attachments";
import { insertLink, toggleTask, toggleWrap } from "./editor/commands";
import { type CompletionHost, completionSources } from "./editor/complete";
import { richPreview, finishRichSource } from "./editor/rich-preview";
import { propertiesEditor, propertiesFacet } from "./editor/properties";
import {
  EditorSuggestBridge,
  type EditorSuggestHost,
} from "./editor/editor-suggest";
import {
  inlineTitle,
  linkClicks,
  linkHost,
  linkPreviews,
  type LinkHost,
  livePreview,
  refreshLinks,
  renderedFacet,
  setInlineTitle,
} from "./editor/live-preview";
import {
  type CodeBlockHost,
  type CodeBlockProcessor,
  codeBlockHost,
  pluginBlocks,
  refreshCodeBlocks as refreshPluginBlocks,
} from "./editor/plugin-blocks";
import {
  codeLanguages,
  markdownHighlight,
  obsidianSyntax,
} from "./editor/syntax";

/** Localized labels for CodeMirror's own panels and announcements. */
const PHRASES: Record<string, string> = {
  Find: t("Suchen"),
  Replace: t("Ersetzen"),
  next: t("Weiter"),
  previous: t("Zurück"),
  all: t("Alle"),
  "match case": t("Groß/Klein"),
  regexp: t("Regex"),
  "by word": t("Wort"),
  replace: t("Ersetzen"),
  "replace all": t("Alle ersetzen"),
  close: t("Schließen"),
  "current match": t("aktueller Treffer"),
  "replaced $ matches": t("$ Treffer ersetzt"),
  "replaced match on line $": t("Treffer in Zeile $ ersetzt"),
  "on line": t("in Zeile"),
  "Go to line": t("Gehe zu Zeile"),
  go: t("Los"),
  Completions: t("Vorschläge"),
};

export interface EditorHost
  extends LinkHost,
    CompletionHost,
    EditorSuggestHost,
    AttachmentHost {
  onChange(text: string): void;
  /** The selected text changed (empty when nothing is selected). */
  onSelection?(selected: string): void;
  save(): void;
  /** Live-preview rendering of code blocks registered by plugins. */
  pluginCodeBlock?(language: string): CodeBlockProcessor | undefined;
  pluginContext?(): { sourcePath: string; app: unknown } | null;
  pluginEmbed?(target: string): PluginEmbed | null;
}

export interface EditorOptions {
  /** Live preview hides Markdown syntax away from the cursor; source mode shows it. */
  livePreview: boolean;
  lineNumbers: boolean;
  spellcheck: boolean;
  autoPair: boolean;
  /** Live preview shows frontmatter as editable properties. */
  properties: boolean;
}

/**
 * One shared CodeMirror view for the whole workspace. Tabs swap `EditorState`
 * objects in and out, so every tab keeps its own undo history, selection and
 * scroll position while plugins keep talking to a single editor.
 */
export class MarkdownEditor {
  readonly view: EditorView;
  readonly compat: Editor;
  readonly extensions: EditorExtensionRegistry;
  private readonly editable = new Compartment();
  private readonly pluginExtensions = new Compartment();
  private readonly pluginSurfaces = new Compartment();
  private readonly surfaceExtensions: Extension[];
  private readonly mode = new Compartment();
  private readonly gutter = new Compartment();
  private readonly attributes = new Compartment();
  private readonly pairing = new Compartment();
  private pluginList: Extension[] = [];
  private readonly suggestBridge: EditorSuggestBridge;
  private isEditable = false;
  private title: string | null = null;
  private options: EditorOptions = {
    livePreview: true,
    lineNumbers: false,
    spellcheck: true,
    autoPair: true,
    properties: true,
  };
  private suppress = false;
  private readonly blockHost: CodeBlockHost;
  private readonly base: Extension[];

  constructor(
    parent: HTMLElement,
    private readonly host: EditorHost,
  ) {
    this.blockHost = {
      processor: (language) => this.host.pluginCodeBlock?.(language),
      context: () => this.host.pluginContext?.() ?? null,
    };
    this.suggestBridge = new EditorSuggestBridge(host, () => this.compat);
    this.surfaceExtensions = [
      codeBlockHost.of(this.blockHost),
      pluginBlocks,
      embedHost.of((target) => this.host.pluginEmbed?.(target) ?? null),
      pluginEmbeds,
    ];
    this.base = [
      markdown({
        base: markdownLanguage,
        extensions: [obsidianSyntax],
        codeLanguages,
      }),
      syntaxHighlighting(markdownHighlight),
      history(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      highlightSelectionMatches({ minSelectionLength: 2 }),
      search({ top: true }),
      EditorView.lineWrapping,
      EditorState.tabSize.of(4),
      EditorState.phrases.of(PHRASES),
      linkHost.of(host),
      attachmentHost.of(host),
      attachmentHandlers,
      livePreview,
      richPreview,
      propertiesEditor,
      Prec.highest(keymap.of([{ key: "Escape", run: finishRichSource }])),
      this.pluginSurfaces.of(this.surfaceExtensions),
      linkClicks,
      linkPreviews,
      inlineTitle,
      this.suggestBridge.events,
      autocompletion({
        override: [...completionSources(host), this.suggestBridge.source],
        icons: false,
        defaultKeymap: true,
      }),
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            host.save();
            return true;
          },
        },
        { key: "Mod-b", run: toggleWrap("**") },
        { key: "Mod-i", run: toggleWrap("*") },
        { key: "Mod-k", run: insertLink },
        { key: "Mod-l", run: toggleTask },
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !this.suppress)
          host.onChange(update.state.doc.toString());
        if (host.onSelection && (update.selectionSet || update.docChanged)) {
          const state = update.state;
          host.onSelection(
            state.selection.ranges
              .map((range) => state.sliceDoc(range.from, range.to))
              .join("\n"),
          );
        }
      }),
    ];
    this.view = new EditorView({ parent, state: this.createState("") });
    this.measure();
    void document.fonts?.ready.then(() => this.measure());
    this.compat = new Editor(this.view);
    this.extensions = new EditorExtensionRegistry((extensions) => {
      this.pluginList = extensions;
      this.view.dispatch({
        effects: this.pluginExtensions.reconfigure(extensions),
      });
    });
  }

  /** Plugin registrations changed; re-render plugin surfaces in the open note. */
  refreshPluginBlocks(): void {
    this.view.dispatch({
      effects: [
        this.pluginSurfaces.reconfigure(this.surfaceExtensions),
        refreshPluginBlocks.of(null),
      ],
    });
  }

  /** Release embedded editors before hiding the note or unloading plugins. */
  releasePluginBlocks(): void {
    this.view.dispatch({ effects: this.pluginSurfaces.reconfigure([]) });
  }

  /**
   * List prefixes are monospaced; wrapped lines hang under the text by a
   * multiple of one cell, which depends on the user's font and size.
   */
  measure(): void {
    const probe = document.createElement("span");
    probe.className = "cm-list-prefix";
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    probe.textContent = "0".repeat(20);
    document.body.append(probe);
    const width = probe.getBoundingClientRect().width / 20;
    probe.remove();
    if (width > 0)
      document.documentElement.style.setProperty("--list-ch", `${width}px`);
  }

  private modeExtension(): Extension {
    return [
      renderedFacet.of(this.options.livePreview),
      propertiesFacet.of(this.options.properties),
    ];
  }

  private attributeExtension(): Extension {
    return EditorView.contentAttributes.of({
      "aria-label": t("Markdown-Editor"),
      spellcheck: String(this.options.spellcheck),
      autocapitalize: "sentences",
    });
  }

  /** A fresh document state carrying the current configuration. */
  createState(text: string): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        this.base,
        this.editable.of(EditorView.editable.of(this.isEditable)),
        this.pluginExtensions.of(this.pluginList),
        this.mode.of(this.modeExtension()),
        this.gutter.of(this.options.lineNumbers ? lineNumbers() : []),
        this.attributes.of(this.attributeExtension()),
        this.pairing.of(this.options.autoPair ? closeBrackets() : []),
      ],
    });
  }

  /** Brings a state that was parked in a background tab up to date. */
  private sync(): void {
    this.view.dispatch({
      effects: [
        this.editable.reconfigure(EditorView.editable.of(this.isEditable)),
        this.pluginExtensions.reconfigure(this.pluginList),
        this.pluginSurfaces.reconfigure(this.surfaceExtensions),
        this.mode.reconfigure(this.modeExtension()),
        this.gutter.reconfigure(this.options.lineNumbers ? lineNumbers() : []),
        this.attributes.reconfigure(this.attributeExtension()),
        this.pairing.reconfigure(this.options.autoPair ? closeBrackets() : []),
        setInlineTitle.of(this.title),
        refreshPluginBlocks.of(null),
      ],
    });
  }

  get state(): EditorState {
    return this.view.state;
  }

  /** Swaps in another tab's document without touching its history. */
  setState(state: EditorState, title: string | null = this.title): void {
    this.title = title;
    this.view.setState(state);
    this.sync();
  }

  get text(): string {
    return this.view.state.doc.toString();
  }

  /** Replaces the document in place; used when the file changed underneath. */
  setText(text: string): void {
    this.suppress = true;
    try {
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: text },
        selection: { anchor: 0 },
      });
    } finally {
      this.suppress = false;
    }
  }

  setEditable(value: boolean): void {
    if (this.isEditable === value) return;
    this.isEditable = value;
    this.view.dispatch({
      effects: this.editable.reconfigure(EditorView.editable.of(value)),
    });
  }

  configure(options: Partial<EditorOptions>): void {
    this.options = { ...this.options, ...options };
    this.sync();
  }

  setTitle(title: string | null): void {
    if (this.title === title) return;
    this.title = title;
    this.view.dispatch({ effects: setInlineTitle.of(title) });
  }

  /** Re-evaluates resolved/unresolved link styling after the file list changed. */
  refreshLinks(): void {
    this.view.dispatch({ effects: refreshLinks.of(null) });
  }

  /** Moves the cursor to `offset` and scrolls it near the top of the view. */
  reveal(offset: number, length = 0): void {
    const anchor = Math.min(offset, this.view.state.doc.length);
    const head = Math.min(anchor + length, this.view.state.doc.length);
    this.view.dispatch({
      selection: { anchor, head },
      effects: EditorView.scrollIntoView(anchor, { y: "start", yMargin: 60 }),
    });
    this.view.focus();
  }

  focus(): void {
    this.view.focus();
  }
}
