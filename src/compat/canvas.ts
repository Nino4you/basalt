import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Editor } from "./editor-adapter";
import type { TFile } from "./files";
import type { Vault } from "./vault";

/** Independent file-node implementation for plugins embedding notes in a drawing. */
export class CanvasFileNode {
  readonly containerEl = document.createElement("div");
  readonly contentEl = document.createElement("div");
  readonly child: { editor: Editor | null; showPreview: () => void };
  isEditing = false;
  private cm: EditorView | null = null;
  private data = "";
  private file: TFile;
  private closed = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly vault: Vault, file: TFile) {
    this.file = file;
    this.containerEl.className = "canvas-node";
    this.contentEl.className = "canvas-node-content";
    this.containerEl.append(this.contentEl);
    this.child = { editor: null, showPreview: () => { void this.showPreview().catch(error => this.report(error)); } };
  }
  setFilePath(path: string, _subpath = ""): void {
    const file = this.vault.getFileByPath(path);
    if (!file) throw new Error(`Embedded file not found: ${path}`);
    this.file = file;
  }
  render(): void {
    this.pending = this.vault.read(this.file).then(data => {
      if (this.closed) return;
      this.data = data;
      this.contentEl.textContent = data;
    });
    void this.pending.catch(error => this.report(error));
  }
  isEditable(): boolean { return this.file.extension === "md" && !this.closed; }
  async startEditing(): Promise<void> {
    await this.pending;
    if (!this.isEditable() || this.cm) return;
    this.contentEl.replaceChildren();
    this.cm = new EditorView({ parent: this.contentEl, state: EditorState.create({ doc: this.data }) });
    this.child.editor = new Editor(this.cm);
    this.isEditing = true;
    this.cm.focus();
  }
  private async showPreview(): Promise<void> {
    await this.save();
    this.cm?.destroy();
    this.cm = null;
    this.child.editor = null;
    this.isEditing = false;
    this.contentEl.textContent = this.data;
  }
  async save(): Promise<void> {
    const data = this.cm?.state.doc.toString() ?? this.data;
    if (data !== this.data) { await this.vault.modify(this.file, data); this.data = data; }
  }
  detach(): void {
    this.closed = true;
    void this.showPreview().catch(error => this.report(error));
    this.containerEl.remove();
  }
  private report(error: unknown): void {
    this.contentEl.textContent = `Embedded note error: ${String(error)}`;
    console.error("Embedded note failed", error);
  }
}

export class PluginCanvas {
  readonly nodes = new Set<CanvasFileNode>();
  constructor(private readonly vault: Vault) {}
  createFileNode(options: { file: TFile }): CanvasFileNode {
    if (this.vault.getFileByPath(options.file.path) !== options.file) throw new Error("File belongs to another or stale vault");
    const node = new CanvasFileNode(this.vault, options.file);
    this.nodes.add(node);
    return node;
  }
  removeNode(node: CanvasFileNode): void { if (this.nodes.delete(node)) node.detach(); }
}
