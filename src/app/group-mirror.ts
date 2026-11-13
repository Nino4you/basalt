import { CanvasView } from "../canvas/view";
import { MarkdownEditor, type EditorOptions } from "../editor";
import { basename, dirname, h, icon } from "../ui/dom";
import type { App, Tab } from "./app";
import { AttachmentView } from "./attachment-view";
import { ReadingView } from "./reading";

/**
 * What an editor group shows while another group has the focus.
 *
 * Plugins talk to exactly one editor, so only the focused group hosts the
 * live views. Every other group mirrors its active tab read-only, at the
 * scroll position it was left at; a click hands the live views over. Notes,
 * canvases and attachments are mirrored; plugin views exist only once and
 * show a placeholder instead.
 */
export class GroupMirror {
  readonly el: HTMLElement;
  private readonly breadcrumb = h("div", "view-header-breadcrumb");
  private readonly title = h("div", "view-header-title");
  private readonly sourceEl = h("div", {
    class: "markdown-source-view",
    attrs: { hidden: true },
  });
  private readonly previewEl = h("article", {
    class: "markdown-reading-view markdown-preview-view markdown-rendered",
    attrs: { hidden: true },
  });
  private readonly canvasHost = h("div", {
    class: "canvas-host",
    attrs: { hidden: true },
  });
  private readonly attachmentHost = h("div", {
    class: "attachment-host",
    attrs: { hidden: true },
  });
  private readonly placeholder = h("div", {
    class: "empty-state group-placeholder",
    attrs: { hidden: true },
  });
  private editor: MarkdownEditor | null = null;
  private reading: ReadingView | null = null;
  private canvas: CanvasView | null = null;
  private attachment: AttachmentView | null = null;
  private options = "";
  /** The tab and path the source mirror currently shows. */
  private shown: { tab: Tab; path: string } | null = null;
  /** The tab and path the canvas mirror currently shows. */
  private canvasShown: { tab: Tab; path: string } | null = null;

  constructor(private readonly app: App) {
    this.el = h(
      "div",
      "workspace-leaf mod-mirror",
      h(
        "div",
        "view-header",
        h("div", "view-header-left"),
        h("div", "view-header-title-container", this.breadcrumb, this.title),
        h("div", "view-actions"),
      ),
      h(
        "div",
        "view-content",
        this.sourceEl,
        this.previewEl,
        this.canvasHost,
        this.attachmentHost,
        this.placeholder,
      ),
    );
    // A click activates the group; the read-only canvas must not start a
    // pan or selection gesture on the way.
    this.canvasHost.addEventListener(
      "pointerdown",
      (event) => event.stopPropagation(),
      true,
    );
  }

  /** Brings the mirror in line with `tab`; cheap when nothing changed. */
  show(tab: Tab, options: EditorOptions): void {
    const folder = tab.path ? dirname(tab.path) : "";
    this.breadcrumb.replaceChildren(
      ...folder
        .split("/")
        .filter(Boolean)
        .flatMap((part) => [
          h("span", { class: "view-header-breadcrumb-part", text: part }),
          h("span", { class: "view-header-breadcrumb-separator", text: "/" }),
        ]),
    );
    this.title.textContent = this.app.tabTitle(tab);
    const note = tab.kind === "markdown" && tab.loaded ? tab.note : null;
    const canvas = tab.kind === "canvas" && tab.loaded ? tab.note : null;
    const attachment = tab.kind === "attachment" ? tab.path : null;
    this.sourceEl.hidden = !note || tab.reading;
    this.previewEl.hidden = !note || !tab.reading;
    this.canvasHost.hidden = !canvas;
    this.attachmentHost.hidden = !attachment;
    this.placeholder.hidden = !!(note || canvas || attachment);
    if (!canvas) this.releaseCanvas();
    if (!attachment) this.attachment?.clear();
    if (canvas && tab.path) {
      this.releaseNote();
      this.showCanvas(tab, tab.path, canvas.text);
      return;
    }
    if (attachment) {
      this.releaseNote();
      this.attachment ??= new AttachmentView(this.attachmentHost);
      void this.attachment.show(attachment, this.app.compatibility);
      return;
    }
    if (!note || !tab.path) {
      this.releaseNote();
      this.placeholder.replaceChildren(
        h(
          "div",
          "empty-state-container",
          icon(
            tab.kind === "canvas"
              ? "layout-dashboard"
              : tab.kind === "plugin"
                ? "puzzle"
                : "file",
            28,
          ),
          h("div", {
            class: "empty-state-title",
            text: tab.path ? basename(tab.path) : "Keine Datei geöffnet",
          }),
          h("p", {
            class: "empty-state-description",
            text: tab.path
              ? "Klicken, um diese Ansicht zu aktivieren."
              : "Klicken, um diese Gruppe zu aktivieren.",
          }),
        ),
      );
      return;
    }
    if (tab.reading) {
      this.reading ??= new ReadingView(this.app, this.previewEl);
      const fresh = this.shown?.tab !== tab || this.shown.path !== tab.path;
      this.shown = { tab, path: tab.path };
      this.reading.render(tab.path, note.text);
      if (fresh) this.previewEl.scrollTop = tab.previewScroll;
      return;
    }
    this.reading?.clear();
    const editor = (this.editor ??= new MarkdownEditor(this.sourceEl, {
      onChange: () => {},
      save: () => {},
      resolves: (target) =>
        !!this.shown &&
        this.app.index.resolve(target, this.shown.path) !== null,
      openLink: () => {},
      openExternal: () => {},
      openTag: () => {},
      notes: () => [],
      tags: () => [],
    }));
    // Reconfiguring re-renders the document; only do it for real changes.
    const key = JSON.stringify(options);
    if (key !== this.options) {
      this.options = key;
      editor.configure(options);
    }
    const title = this.app.settings.get("inlineTitle")
      ? basename(tab.path)
      : null;
    if (this.shown?.tab === tab && this.shown.path === tab.path) {
      // Same tab: keep the scroll position, follow edits made elsewhere.
      editor.setTitle(title);
      if (editor.text !== note.text) {
        const scroll = editor.view.scrollDOM.scrollTop;
        editor.setText(note.text);
        this.scrollTo(scroll);
      }
      return;
    }
    this.shown = { tab, path: tab.path };
    editor.setState(editor.createState(note.text), title);
    this.scrollTo(tab.scroll);
  }

  private showCanvas(tab: Tab, path: string, text: string): void {
    if (!this.canvas) {
      const index = this.app.index;
      this.canvas = new CanvasView({
        files: () => index.files,
        resolve: (target, source) => index.resolve(target, source),
        noteText: (path) => index.content(path),
        openFile: () => {},
        openLink: () => {},
        openExternal: () => {},
        onChange: () => {},
        locked: true,
      });
      // The id belongs to the live canvas.
      this.canvas.el.removeAttribute("id");
      this.canvasHost.append(this.canvas.el);
    }
    if (this.canvasShown?.tab === tab && this.canvasShown.path === path) {
      // Same tab: keep the viewport, follow edits made elsewhere.
      this.canvas.setText(text);
      return;
    }
    this.canvasShown = { tab, path };
    this.canvas.load(path, text);
  }

  private releaseCanvas(): void {
    if (!this.canvasShown) return;
    this.canvasShown = null;
    this.canvas?.suspend();
  }

  private scrollTo(top: number): void {
    const view = this.editor?.view;
    view?.requestMeasure({
      read: () => null,
      write: () => {
        view.scrollDOM.scrollTop = top;
      },
    });
  }

  /** Scroll positions of the mirror, which survive being moved in the DOM. */
  get scroll(): { source: number; preview: number } {
    return {
      source: this.editor?.view.scrollDOM.scrollTop ?? 0,
      preview: this.previewEl.scrollTop,
    };
  }

  set scroll(value: { source: number; preview: number }) {
    if (this.editor) this.editor.view.scrollDOM.scrollTop = value.source;
    this.previewEl.scrollTop = value.preview;
  }

  /**
   * Called before the live views take over: writes the mirror's scroll
   * position back to the tab. Returns the document offset under `point`
   * (where the user clicked), if the source is showing.
   */
  handOver(tab: Tab, point?: { x: number; y: number }): number | null {
    // The live canvas picks up the viewport the mirror leaves behind.
    if (this.canvasShown?.tab === tab) this.canvas?.suspend();
    if (this.shown?.tab !== tab) return null;
    if (tab.reading) {
      tab.previewScroll = this.previewEl.scrollTop;
      return null;
    }
    const view = this.editor?.view;
    if (!view) return null;
    tab.scroll = view.scrollDOM.scrollTop;
    return point ? view.posAtCoords(point) : null;
  }

  /** Drops rendered content, including plugin render children. */
  release(): void {
    this.releaseNote();
    this.releaseCanvas();
    this.attachment?.clear();
  }

  private releaseNote(): void {
    this.shown = null;
    this.reading?.clear();
  }
}
