import { renderMarkdown } from "../markdown";
import { basename, dirname, extension, h, icon, isMac } from "../ui/dom";
import { fuzzyMatch } from "../ui/fuzzy";
import { showMenu, type MenuEntry } from "../ui/menu";
import { Modal, SuggestModal, type Suggestion } from "../ui/modal";
import {
  addEdge,
  addNode,
  bounds,
  cssColor,
  edgeGeometry,
  facingSide,
  nodeById,
  nodesInGroup,
  parseCanvas,
  PRESET_COLORS,
  removeEdges,
  removeNodes,
  serializeCanvas,
  SIDES,
  type CanvasData,
  type CanvasEdge,
  type CanvasNode,
  type CanvasSide,
  type Rect,
} from "./model";

/** What the canvas needs from the surrounding app. */
export interface CanvasHost {
  /** Vault files that may be placed as cards. */
  files(): string[];
  /** Resolves a vault path or `[[link]]` target relative to the canvas. */
  resolve(target: string, source: string): string | null;
  /** Indexed Markdown of a note, if known, for card previews. */
  noteText(path: string): string | undefined;
  openFile(path: string, newTab: boolean): void;
  openLink(target: string, source: string, newTab: boolean): void;
  openExternal(url: string): void;
  /** Receives the serialized canvas after every completed change. */
  onChange(path: string, text: string): void;
  /** Shows every file read-only, e.g. in an unfocused editor group. */
  readonly locked?: boolean;
}

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

type Gesture =
  | {
      kind: "pan";
      pointer: number;
      startX: number;
      startY: number;
      origin: Viewport;
    }
  | {
      kind: "move";
      pointer: number;
      startX: number;
      startY: number;
      nodes: Array<{ node: CanvasNode; x: number; y: number }>;
      moved: boolean;
      target: CanvasNode;
      additive: boolean;
    }
  | {
      kind: "resize";
      pointer: number;
      startX: number;
      startY: number;
      node: CanvasNode;
      width: number;
      height: number;
    }
  | {
      kind: "connect";
      pointer: number;
      from: CanvasNode;
      side: CanvasSide;
      preview: SVGPathElement;
    }
  | {
      kind: "select";
      pointer: number;
      startX: number;
      startY: number;
      box: HTMLElement;
      base: Set<string>;
    }
  | {
      kind: "pinch";
      startDistance: number;
      startZoom: number;
      world: { x: number; y: number };
    };

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const MIN_WIDTH = 60;
const MIN_HEIGHT = 40;
const DOUBLE_TAP_MS = 350;
const DRAG_THRESHOLD = 4;
const HISTORY_LIMIT = 100;
const SVG = "http://www.w3.org/2000/svg";
const IMAGE = /^(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const COLOR_NAMES: Record<string, string> = {
  "1": "Rot",
  "2": "Orange",
  "3": "Gelb",
  "4": "Grün",
  "5": "Cyan",
  "6": "Lila",
};

/** Viewport per canvas path, kept while the app runs so tab switches keep the view. */
const viewports = new Map<string, Viewport>();

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs))
    node.setAttribute(name, value);
  return node;
}

/**
 * Infinite board for one `.canvas` file: cards, groups and connections, with
 * pointer-event gestures that work the same for mouse, pen and touch.
 */
export class CanvasView {
  readonly el: HTMLElement;
  private readonly viewportEl: HTMLElement;
  private readonly worldEl: HTMLElement;
  private readonly edgesEl: SVGSVGElement;
  private readonly overlayEl: SVGSVGElement;
  private readonly errorEl: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  private readonly selectionButtons: HTMLElement;

  private path = "";
  private data: CanvasData = { nodes: [], edges: [] };
  private text = "";
  private readOnly = false;
  private view: Viewport = { x: 0, y: 0, zoom: 1 };
  /** The view still shows a fit; refit when the viewport gets its real size. */
  private autoFit = false;
  private readonly resize: ResizeObserver | null;
  private readonly selected = new Set<string>();
  private readonly selectedEdges = new Set<string>();
  private readonly nodeEls = new Map<string, HTMLElement>();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private gesture: Gesture | null = null;
  private editing: string | null = null;
  private lastTap: { id: string; time: number; x: number; y: number } | null =
    null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  constructor(private readonly host: CanvasHost) {
    const button = (
      id: string,
      label: string,
      onClick: (event: MouseEvent) => void,
      action: string,
    ) =>
      h(
        "button",
        {
          class: "clickable-icon",
          label,
          attrs: { type: "button" },
          data: { canvasAction: action },
          on: { click: onClick },
        },
        icon(id),
      );
    this.zoomLabel = h("span", { class: "canvas-zoom-level", text: "100 %" });
    this.selectionButtons = h(
      "div",
      { class: "canvas-toolbar-group", attrs: { hidden: true } },
      button(
        "palette",
        "Farbe ändern",
        (event) => this.colorMenu(event.currentTarget as HTMLElement),
        "color",
      ),
      button(
        "trash-2",
        "Auswahl löschen",
        () => this.deleteSelection(),
        "delete",
      ),
    );
    const toolbar = h(
      "div",
      {
        class: "canvas-toolbar",
        attrs: { role: "toolbar", "aria-label": "Canvas" },
      },
      h(
        "div",
        "canvas-toolbar-group",
        button(
          "sticky-note",
          "Karte hinzufügen",
          () => this.addTextCard(),
          "add-text",
        ),
        button(
          "file-text",
          "Notiz hinzufügen",
          () => this.pickFile(),
          "add-file",
        ),
        button(
          "link",
          "Weblink hinzufügen",
          () => void this.addLinkCard(),
          "add-link",
        ),
        button(
          "group",
          "Gruppe hinzufügen",
          () => this.addGroup(),
          "add-group",
        ),
      ),
      this.selectionButtons,
    );
    const zoom = h(
      "div",
      {
        class: "canvas-controls",
        attrs: { role: "toolbar", "aria-label": "Zoom" },
      },
      button("zoom-in", "Vergrößern", () => this.zoomBy(1.25), "zoom-in"),
      this.zoomLabel,
      button("zoom-out", "Verkleinern", () => this.zoomBy(0.8), "zoom-out"),
      button("scan", "Alles anzeigen", () => this.fit(), "fit"),
      button("undo-2", "Rückgängig", () => this.undo(), "undo"),
      button("redo-2", "Wiederholen", () => this.redo(), "redo"),
    );
    this.edgesEl = svg("svg", { class: "canvas-edges" });
    this.overlayEl = svg("svg", { class: "canvas-edges canvas-overlay" });
    this.worldEl = h("div", "canvas-world");
    this.worldEl.append(this.edgesEl, this.overlayEl);
    this.viewportEl = h(
      "div",
      {
        class: "canvas-viewport",
        attrs: {
          tabindex: "0",
          role: "application",
          "aria-label": "Canvas-Fläche",
          "aria-roledescription": "Canvas",
        },
      },
      this.worldEl,
    );
    this.errorEl = h("div", {
      class: "canvas-error",
      attrs: { role: "alert", hidden: true },
    });
    this.el = h(
      "div",
      { class: "canvas-wrapper", id: "canvas-view" },
      this.viewportEl,
      toolbar,
      zoom,
      this.errorEl,
    );
    // A canvas opened while its pane is still being laid out measures a
    // fraction of its final size; keep fitting until the user moves the view.
    this.resize =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (this.autoFit && this.viewportEl.clientWidth) this.fit();
          })
        : null;
    this.resize?.observe(this.viewportEl);

    const vp = this.viewportEl;
    vp.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    vp.addEventListener("pointermove", (event) => this.onPointerMove(event));
    vp.addEventListener("pointerup", (event) => this.onPointerUp(event));
    vp.addEventListener("pointercancel", (event) =>
      this.onPointerUp(event, true),
    );
    vp.addEventListener("wheel", (event) => this.onWheel(event), {
      passive: false,
    });
    vp.addEventListener("keydown", (event) => this.onKey(event));
    vp.addEventListener("contextmenu", (event) => this.onContextMenu(event));
    vp.addEventListener("click", (event) => this.onClick(event));
    // Desktop double-click; touch double-taps are detected in pointerup.
    vp.addEventListener("dblclick", (event) => {
      if (this.isEditable(event.target)) return;
      event.preventDefault();
    });
  }

  /** Shows `text` as the canvas at `path`. Unreadable files are shown read-only. */
  load(path: string, text: string): void {
    this.stopEditing(false);
    if (this.path) viewports.set(this.path, this.view);
    const switched = path !== this.path;
    this.path = path;
    if (switched) {
      this.undoStack = [];
      this.redoStack = [];
      this.selected.clear();
      this.selectedEdges.clear();
    }
    this.setText(text, switched);
  }

  /** Applies a newer file state (e.g. reloaded from disk) without touching the viewport. */
  setText(text: string, resetView = false): void {
    if (!resetView && text === this.text) return;
    this.text = text;
    try {
      this.data = parseCanvas(text);
      this.readOnly = !!this.host.locked;
      this.errorEl.hidden = true;
    } catch (error) {
      this.data = { nodes: [], edges: [] };
      this.readOnly = true;
      this.errorEl.hidden = false;
      this.errorEl.textContent = `${error instanceof Error ? error.message : String(error)} Die Datei wird nicht verändert.`;
    }
    this.el.classList.toggle("is-readonly", this.readOnly);
    for (const id of [...this.selected])
      if (!nodeById(this.data, id)) this.selected.delete(id);
    for (const id of [...this.selectedEdges])
      if (!this.data.edges.some((edge) => edge.id === id))
        this.selectedEdges.delete(id);
    this.render();
    if (resetView) {
      const saved = viewports.get(this.path);
      if (saved) this.setViewport(saved);
      else this.fit();
    }
  }

  /** Card previews depend on other notes; re-render them when the index changes. */
  refreshPreviews(): void {
    for (const node of this.data.nodes)
      if (node.type === "file" && node.id !== this.editing)
        this.renderNode(node);
  }

  /** Called when the canvas tab goes to the background. */
  suspend(): void {
    this.stopEditing(true);
    this.cancelGesture();
    this.pointers.clear();
    this.saveViewport();
  }

  focus(): void {
    this.viewportEl.focus({ preventScroll: true });
  }

  destroy(): void {
    this.resize?.disconnect();
    this.stopEditing(true);
    if (this.path) viewports.set(this.path, this.view);
    this.el.remove();
  }

  /** Current document (for tests and for saving on close). */
  get value(): CanvasData {
    return this.data;
  }

  // ── changes ───────────────────────────────────────────────────────────────

  private commit(): void {
    if (this.readOnly) return;
    const next = serializeCanvas(this.data);
    if (next === this.text) return;
    this.undoStack.push(this.text);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.text = next;
    this.host.onChange(this.path, next);
  }

  undo(): void {
    this.stopEditing(true);
    const previous = this.undoStack.pop();
    if (previous === undefined || this.readOnly) return;
    this.redoStack.push(this.text);
    this.restore(previous);
  }

  redo(): void {
    this.stopEditing(true);
    const next = this.redoStack.pop();
    if (next === undefined || this.readOnly) return;
    this.undoStack.push(this.text);
    this.restore(next);
  }

  private restore(text: string): void {
    this.setText(text);
    this.host.onChange(this.path, text);
  }

  // ── geometry ──────────────────────────────────────────────────────────────

  private toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.viewportEl.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.view.x) / this.view.zoom,
      y: (clientY - rect.top - this.view.y) / this.view.zoom,
    };
  }

  private visibleCentre(): { x: number; y: number } {
    const rect = this.viewportEl.getBoundingClientRect();
    return this.toWorld(
      rect.left + (rect.width || 800) / 2,
      rect.top + (rect.height || 600) / 2,
    );
  }

  private setViewport(view: Viewport): void {
    this.autoFit = false;
    this.view = { ...view, zoom: clamp(view.zoom, MIN_ZOOM, MAX_ZOOM) };
    this.worldEl.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.zoom})`;
    this.viewportEl.style.setProperty("--canvas-zoom", String(this.view.zoom));
    // The dot grid moves with the board so panning is visible on empty space.
    const grid = 20 * this.view.zoom;
    this.viewportEl.style.backgroundSize = `${grid}px ${grid}px`;
    this.viewportEl.style.backgroundPosition = `${this.view.x}px ${this.view.y}px`;
    this.zoomLabel.textContent = `${Math.round(this.view.zoom * 100)} %`;
    this.el.dataset.zoom = String(Math.round(this.view.zoom * 100));
  }

  /** Zooms so that `world` stays under the screen point (`screenX`, `screenY`). */
  private zoomAround(zoom: number, screenX: number, screenY: number): void {
    const rect = this.viewportEl.getBoundingClientRect();
    const sx = screenX - rect.left;
    const sy = screenY - rect.top;
    const world = this.toWorld(screenX, screenY);
    const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.setViewport({
      zoom: next,
      x: sx - world.x * next,
      y: sy - world.y * next,
    });
  }

  zoomBy(factor: number): void {
    const rect = this.viewportEl.getBoundingClientRect();
    this.zoomAround(
      this.view.zoom * factor,
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
  }

  /** Shows every card, or the origin of an empty canvas at 100 %. */
  fit(): void {
    const rect = this.viewportEl.getBoundingClientRect();
    const width = rect.width || 800;
    const height = rect.height || 600;
    const box = bounds(this.data.nodes);
    if (!box) {
      this.setViewport({ x: width / 2, y: height / 2, zoom: 1 });
      this.autoFit = true;
      return;
    }
    const margin = 80;
    const zoom = clamp(
      Math.min(
        (width - margin * 2) / Math.max(1, box.width),
        (height - margin * 2) / Math.max(1, box.height),
      ),
      MIN_ZOOM,
      1,
    );
    this.setViewport({
      zoom,
      x: width / 2 - (box.x + box.width / 2) * zoom,
      y: height / 2 - (box.y + box.height / 2) * zoom,
    });
    this.autoFit = true;
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  private render(): void {
    const seen = new Set<string>();
    for (const [index, node] of this.data.nodes.entries()) {
      seen.add(node.id);
      const el = this.renderNode(node);
      el.style.zIndex = String(node.type === "group" ? index : 1000 + index);
      if (el.parentElement !== this.worldEl) this.worldEl.append(el);
    }
    for (const [id, el] of this.nodeEls)
      if (!seen.has(id)) {
        el.remove();
        this.nodeEls.delete(id);
      }
    this.renderEdges();
    this.updateSelection();
    this.el.classList.toggle("is-empty", !this.data.nodes.length);
  }

  private renderNode(node: CanvasNode): HTMLElement {
    let el = this.nodeEls.get(node.id);
    if (!el) {
      el = h("div", { data: { nodeId: node.id } });
      this.nodeEls.set(node.id, el);
    }
    el.className = `canvas-node canvas-node-${node.type}`;
    el.setAttribute("role", "group");
    const color = cssColor(node.color);
    if (color) el.style.setProperty("--canvas-color", color);
    else el.style.removeProperty("--canvas-color");
    el.classList.toggle("is-colored", !!color);
    this.position(el, node);
    const content = h("div", "canvas-node-content");
    let label = "";
    switch (node.type) {
      case "text": {
        label = "Textkarte";
        content.classList.add("markdown-rendered");
        if (node.text.trim()) content.innerHTML = renderMarkdown(node.text);
        else
          content.append(
            h("p", {
              class: "canvas-placeholder",
              text: "Doppelt tippen zum Schreiben",
            }),
          );
        this.decorateLinks(content);
        break;
      }
      case "file": {
        label = `Datei ${node.file}`;
        const resolved = this.host.resolve(node.file, this.path);
        const header = h(
          "div",
          "canvas-file-header",
          icon(IMAGE.test(extension(node.file)) ? "image" : "file-text", 14),
          h("span", { text: basename(node.file) + (node.subpath ?? "") }),
        );
        content.append(header);
        if (!resolved)
          content.append(
            h("p", {
              class: "canvas-placeholder",
              text: "Datei nicht gefunden",
            }),
          );
        else if (/\.md$/i.test(resolved)) {
          const body = h("div", "canvas-file-preview markdown-rendered");
          const text = this.host.noteText(resolved);
          if (text === undefined)
            body.append(
              h("p", { class: "canvas-placeholder", text: "Wird geladen …" }),
            );
          else body.innerHTML = renderMarkdown(text);
          this.decorateLinks(body);
          content.append(body);
        } else
          content.append(
            h("p", {
              class: "canvas-placeholder",
              text: "Vorschau für diesen Dateityp nicht verfügbar. Doppelt tippen zum Öffnen.",
            }),
          );
        el.classList.toggle("is-unresolved", !resolved);
        break;
      }
      case "link": {
        label = `Weblink ${node.url}`;
        content.append(
          h(
            "div",
            "canvas-file-header",
            icon("globe", 14),
            h("span", { text: node.url }),
          ),
          h("p", {
            class: "canvas-placeholder",
            text: "Webseiten werden aus Datenschutzgründen nicht eingebettet.",
          }),
        );
        break;
      }
      case "group": {
        label = `Gruppe ${node.label ?? ""}`.trim();
        break;
      }
    }
    el.setAttribute("aria-label", label);
    const children: Node[] = [];
    if (node.type === "group") {
      children.push(
        h("div", { class: "canvas-group-label", text: node.label || "Gruppe" }),
      );
    } else children.push(content);
    children.push(
      h("div", { class: "canvas-resize-handle", data: { handle: "resize" } }),
      ...SIDES.map((side) =>
        h("div", {
          class: `canvas-connect-handle mod-${side}`,
          data: { handle: "connect", side },
        }),
      ),
    );
    el.replaceChildren(...children);
    return el;
  }

  private decorateLinks(root: HTMLElement): void {
    for (const link of root.querySelectorAll<HTMLElement>("a.internal-link"))
      if (!this.host.resolve(link.dataset.note ?? "", this.path))
        link.classList.add("is-unresolved");
  }

  private position(el: HTMLElement, node: Rect): void {
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    el.style.width = `${node.width}px`;
    el.style.height = `${node.height}px`;
  }

  private renderEdges(): void {
    const parts: SVGElement[] = [];
    for (const edge of this.data.edges) {
      const from = nodeById(this.data, edge.fromNode);
      const to = nodeById(this.data, edge.toNode);
      if (!from || !to) continue;
      const geometry = edgeGeometry(from, to, edge);
      const group = svg("g", {
        class: `canvas-edge${this.selectedEdges.has(edge.id) ? " is-selected" : ""}`,
        "data-edge-id": edge.id,
      });
      const color = cssColor(edge.color);
      if (color) group.style.setProperty("--canvas-color", color);
      group.append(
        svg("path", { class: "canvas-edge-hit", d: geometry.path }),
        svg("path", { class: "canvas-edge-line", d: geometry.path }),
      );
      if ((edge.toEnd ?? "arrow") === "arrow")
        group.append(arrow(geometry.to, geometry.toSide));
      if (edge.fromEnd === "arrow")
        group.append(arrow(geometry.from, geometry.fromSide));
      if (edge.label) {
        const text = svg("text", {
          class: "canvas-edge-label",
          x: String(geometry.middle.x),
          y: String(geometry.middle.y),
          "text-anchor": "middle",
          "dominant-baseline": "middle",
        });
        text.textContent = edge.label;
        group.append(text);
      }
      parts.push(group);
    }
    this.edgesEl.replaceChildren(...parts);
  }

  private updateSelection(): void {
    for (const [id, el] of this.nodeEls) {
      const selected = this.selected.has(id);
      el.classList.toggle("is-selected", selected);
      el.setAttribute("aria-selected", String(selected));
    }
    for (const el of this.edgesEl.querySelectorAll<SVGGElement>(".canvas-edge"))
      el.classList.toggle(
        "is-selected",
        this.selectedEdges.has(el.dataset.edgeId ?? ""),
      );
    this.selectionButtons.hidden =
      this.readOnly || (!this.selected.size && !this.selectedEdges.size);
  }

  private select(ids: Iterable<string>, edges: Iterable<string> = []): void {
    this.selected.clear();
    this.selectedEdges.clear();
    for (const id of ids) this.selected.add(id);
    for (const id of edges) this.selectedEdges.add(id);
    this.updateSelection();
  }

  // ── creating ──────────────────────────────────────────────────────────────

  private place(width: number, height: number, at?: { x: number; y: number }) {
    const centre = at ?? this.visibleCentre();
    return { x: centre.x - width / 2, y: centre.y - height / 2, width, height };
  }

  addTextCard(at?: { x: number; y: number }, edit = true): CanvasNode | null {
    if (this.readOnly) return null;
    const node = addNode(this.data, {
      type: "text",
      text: "",
      ...this.place(260, 140, at),
    });
    this.render();
    this.select([node.id]);
    this.commit();
    if (edit) this.startEditing(node.id);
    return node;
  }

  addFileCard(file: string, at?: { x: number; y: number }): CanvasNode | null {
    if (this.readOnly) return null;
    const node = addNode(this.data, {
      type: "file",
      file,
      ...this.place(400, 400, at),
    });
    this.render();
    this.select([node.id]);
    this.commit();
    return node;
  }

  private pickFile(at?: { x: number; y: number }): void {
    if (this.readOnly) return;
    const files = this.host.files().filter((path) => path !== this.path);
    const entry = (path: string): Suggestion => ({
      render(parent) {
        const folder = dirname(path);
        parent.append(
          h(
            "div",
            "suggestion-content",
            h("div", { class: "suggestion-title", text: basename(path) }),
            folder
              ? h("div", { class: "suggestion-note", text: `${folder}/` })
              : null,
          ),
        );
      },
      run: () => {
        this.addFileCard(path, at);
        this.focus();
      },
    });
    new SuggestModal(
      "Notiz für die Karte suchen …",
      "Notiz hinzufügen",
      (raw) => {
        const query = raw.trim().toLowerCase();
        if (!query) return files.slice(0, 200).map(entry);
        return files
          .map((path) => ({ path, match: fuzzyMatch(query, path) }))
          .filter((item) => item.match)
          .sort((a, b) => b.match!.score - a.match!.score)
          .slice(0, 200)
          .map((item) => entry(item.path));
      },
      [],
      "Keine passende Datei.",
    ).open();
  }

  async addLinkCard(at?: { x: number; y: number }): Promise<void> {
    if (this.readOnly) return;
    const url = await prompt("Weblink hinzufügen", "Adresse", "https://");
    if (!url || !/^https?:\/\/\S+$/i.test(url.trim())) return;
    addNode(this.data, {
      type: "link",
      url: url.trim(),
      ...this.place(400, 160, at),
    });
    this.render();
    this.commit();
  }

  /** Wraps the selected cards, or adds an empty group in the middle of the view. */
  addGroup(at?: { x: number; y: number }): void {
    if (this.readOnly) return;
    const members = this.data.nodes.filter((node) =>
      this.selected.has(node.id),
    );
    const box = bounds(members);
    const rect = box
      ? {
          x: box.x - 30,
          y: box.y - 30,
          width: box.width + 60,
          height: box.height + 60,
        }
      : this.place(500, 360, at);
    const node = addNode(this.data, { type: "group", label: "", ...rect });
    this.render();
    this.select([node.id]);
    this.commit();
  }

  // ── editing ───────────────────────────────────────────────────────────────

  private startEditing(id: string): void {
    const node = nodeById(this.data, id);
    const el = this.nodeEls.get(id);
    if (!node || !el || this.readOnly) return;
    if (node.type === "group") {
      void this.renameGroup(node);
      return;
    }
    if (node.type !== "text") return;
    this.stopEditing(true);
    this.editing = id;
    const area = h("textarea", {
      class: "canvas-node-editor",
      label: "Kartentext",
      attrs: { spellcheck: "true" },
    });
    area.value = node.text;
    el.classList.add("is-editing");
    el.querySelector(".canvas-node-content")?.replaceWith(area);
    area.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        this.stopEditing(true);
        this.focus();
      }
    });
    area.addEventListener("blur", () => {
      if (this.editing === id) this.stopEditing(true);
    });
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  private stopEditing(save: boolean): void {
    const id = this.editing;
    if (!id) return;
    this.editing = null;
    const node = nodeById(this.data, id);
    const el = this.nodeEls.get(id);
    const area = el?.querySelector<HTMLTextAreaElement>("textarea");
    el?.classList.remove("is-editing");
    if (node?.type === "text" && area && save) node.text = area.value;
    if (node) this.renderNode(node);
    if (save) this.commit();
  }

  private async renameGroup(
    node: CanvasNode & { type: "group" },
  ): Promise<void> {
    const label = await prompt(
      "Gruppe benennen",
      "Name der Gruppe",
      node.label ?? "",
    );
    if (label === null) return;
    if (label.trim()) node.label = label.trim();
    else delete node.label;
    this.renderNode(node);
    this.commit();
  }

  private async editEdgeLabel(edge: CanvasEdge): Promise<void> {
    const label = await prompt(
      "Verbindung beschriften",
      "Beschriftung",
      edge.label ?? "",
    );
    if (label === null) return;
    if (label.trim()) edge.label = label.trim();
    else delete edge.label;
    this.renderEdges();
    this.commit();
  }

  deleteSelection(): void {
    if (this.readOnly) return;
    if (!this.selected.size && !this.selectedEdges.size) return;
    this.stopEditing(false);
    removeNodes(this.data, this.selected);
    removeEdges(this.data, this.selectedEdges);
    this.select([]);
    this.render();
    this.commit();
  }

  private setColor(color: string | null): void {
    for (const node of this.data.nodes)
      if (this.selected.has(node.id)) {
        if (color) node.color = color;
        else delete node.color;
      }
    for (const edge of this.data.edges)
      if (this.selectedEdges.has(edge.id)) {
        if (color) edge.color = color;
        else delete edge.color;
      }
    this.render();
    this.commit();
  }

  private colorMenu(at: HTMLElement | { x: number; y: number }): void {
    showMenu(
      [
        {
          title: "Keine Farbe",
          icon: "circle-off",
          onClick: () => this.setColor(null),
        },
        ...PRESET_COLORS.map((color) => ({
          title: COLOR_NAMES[color],
          icon: "circle",
          onClick: () => this.setColor(color),
        })),
      ],
      at,
    );
  }

  // ── pointer input ─────────────────────────────────────────────────────────

  private isEditable(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && !!target.closest("textarea, input");
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.isEditable(event.target)) return;
    if (event.button !== 0 && event.button !== 1) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.editing) this.stopEditing(true);
    this.focus();

    if (this.pointers.size === 2) {
      this.cancelGesture();
      const [a, b] = [...this.pointers.values()];
      this.gesture = {
        kind: "pinch",
        startDistance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        startZoom: this.view.zoom,
        world: this.toWorld((a.x + b.x) / 2, (a.y + b.y) / 2),
      };
      return;
    }
    if (this.pointers.size > 2 || this.gesture) return;

    const target = event.target as Element;
    const nodeEl = target.closest<HTMLElement>(".canvas-node");
    const node = nodeEl
      ? nodeById(this.data, nodeEl.dataset.nodeId ?? "")
      : undefined;
    const handle = (target as HTMLElement).dataset?.handle;
    const edgeId = target.closest<SVGGElement>(".canvas-edge")?.dataset.edgeId;

    if (event.button === 1) {
      this.startPan(event);
      return;
    }
    if (node && handle === "resize" && !this.readOnly) {
      event.preventDefault();
      this.gesture = {
        kind: "resize",
        pointer: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        node,
        width: node.width,
        height: node.height,
      };
      return;
    }
    if (node && handle === "connect" && !this.readOnly) {
      event.preventDefault();
      const preview = svg("path", {
        class: "canvas-edge-line canvas-edge-preview",
      });
      this.overlayEl.replaceChildren(preview);
      this.gesture = {
        kind: "connect",
        pointer: event.pointerId,
        from: node,
        side: (target as HTMLElement).dataset.side as CanvasSide,
        preview,
      };
      return;
    }
    if (node) {
      event.preventDefault();
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      if (!this.selected.has(node.id) && !additive) this.select([node.id]);
      else if (!this.selected.has(node.id)) {
        this.selected.add(node.id);
        this.updateSelection();
      }
      const moving = new Set<CanvasNode>();
      for (const id of this.selected) {
        const selected = nodeById(this.data, id);
        if (!selected) continue;
        moving.add(selected);
        if (selected.type === "group")
          for (const child of nodesInGroup(this.data, selected))
            moving.add(child);
      }
      this.gesture = {
        kind: "move",
        pointer: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        nodes: [...moving].map((item) => ({
          node: item,
          x: item.x,
          y: item.y,
        })),
        moved: false,
        target: node,
        additive,
      };
      return;
    }
    if (edgeId) {
      event.preventDefault();
      this.select([], [edgeId]);
      this.trackTap(`edge:${edgeId}`, event);
      return;
    }
    if (event.shiftKey && event.pointerType === "mouse") {
      const box = h("div", "canvas-selection-box");
      this.el.append(box);
      this.gesture = {
        kind: "select",
        pointer: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        box,
        base: new Set(this.selected),
      };
      return;
    }
    this.startPan(event);
  }

  private startPan(event: PointerEvent): void {
    event.preventDefault();
    this.gesture = {
      kind: "pan",
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...this.view },
    };
    this.el.classList.add("is-panning");
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = this.gesture;
    if (!gesture) return;
    if (gesture.kind === "pinch") {
      const [a, b] = [...this.pointers.values()];
      if (!a || !b) return;
      const zoom = clamp(
        (gesture.startZoom * Math.hypot(a.x - b.x, a.y - b.y)) /
          gesture.startDistance,
        MIN_ZOOM,
        MAX_ZOOM,
      );
      const rect = this.viewportEl.getBoundingClientRect();
      const mx = (a.x + b.x) / 2 - rect.left;
      const my = (a.y + b.y) / 2 - rect.top;
      this.setViewport({
        zoom,
        x: mx - gesture.world.x * zoom,
        y: my - gesture.world.y * zoom,
      });
      return;
    }
    if (gesture.pointer !== event.pointerId) return;
    // Capture only once a drag is underway: capturing on pointerdown would
    // retarget the click of a plain tap away from links inside cards.
    const start = "startX" in gesture ? gesture : null;
    if (
      !start ||
      Math.hypot(event.clientX - start.startX, event.clientY - start.startY) >=
        DRAG_THRESHOLD
    )
      this.capture(event.pointerId);
    const zoom = this.view.zoom;
    switch (gesture.kind) {
      case "pan":
        this.setViewport({
          zoom: gesture.origin.zoom,
          x: gesture.origin.x + event.clientX - gesture.startX,
          y: gesture.origin.y + event.clientY - gesture.startY,
        });
        break;
      case "move": {
        const dx = event.clientX - gesture.startX;
        const dy = event.clientY - gesture.startY;
        if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        if (this.readOnly) return;
        gesture.moved = true;
        this.el.classList.add("is-dragging");
        for (const item of gesture.nodes) {
          item.node.x = Math.round(item.x + dx / zoom);
          item.node.y = Math.round(item.y + dy / zoom);
          const el = this.nodeEls.get(item.node.id);
          if (el) this.position(el, item.node);
        }
        this.renderEdges();
        break;
      }
      case "resize": {
        const node = gesture.node;
        node.width = Math.max(
          MIN_WIDTH,
          Math.round(gesture.width + (event.clientX - gesture.startX) / zoom),
        );
        node.height = Math.max(
          MIN_HEIGHT,
          Math.round(gesture.height + (event.clientY - gesture.startY) / zoom),
        );
        const el = this.nodeEls.get(node.id);
        if (el) this.position(el, node);
        this.renderEdges();
        break;
      }
      case "connect": {
        const to = this.toWorld(event.clientX, event.clientY);
        const target = this.nodeAt(event.clientX, event.clientY);
        const geometry =
          target && target !== gesture.from
            ? edgeGeometry(gesture.from, target, {
                fromSide: gesture.side,
                toSide: facingSide(target, to),
              })
            : edgeGeometry(
                gesture.from,
                { x: to.x, y: to.y, width: 0, height: 0 },
                {
                  fromSide: gesture.side,
                  toSide: opposite(gesture.side),
                },
              );
        gesture.preview.setAttribute("d", geometry.path);
        for (const [id, el] of this.nodeEls)
          el.classList.toggle(
            "is-drop-target",
            id === target?.id && target !== gesture.from,
          );
        break;
      }
      case "select": {
        const rect = this.el.getBoundingClientRect();
        const left = Math.min(gesture.startX, event.clientX);
        const top = Math.min(gesture.startY, event.clientY);
        const width = Math.abs(event.clientX - gesture.startX);
        const height = Math.abs(event.clientY - gesture.startY);
        Object.assign(gesture.box.style, {
          left: `${left - rect.left}px`,
          top: `${top - rect.top}px`,
          width: `${width}px`,
          height: `${height}px`,
        });
        const a = this.toWorld(left, top);
        const b = this.toWorld(left + width, top + height);
        const inside = this.data.nodes
          .filter(
            (node) =>
              node.x >= a.x &&
              node.y >= a.y &&
              node.x + node.width <= b.x &&
              node.y + node.height <= b.y,
          )
          .map((node) => node.id);
        this.select([...gesture.base, ...inside]);
        break;
      }
    }
  }

  private capture(pointer: number): void {
    try {
      if (!this.viewportEl.hasPointerCapture?.(pointer))
        this.viewportEl.setPointerCapture?.(pointer);
    } catch {
      // The pointer may already be gone (e.g. lifted between events).
    }
  }

  private onPointerUp(event: PointerEvent, cancelled = false): void {
    if (!this.pointers.delete(event.pointerId)) return;
    const gesture = this.gesture;
    if (!gesture) return;
    if (gesture.kind === "pinch") {
      // Lifting one finger ends the pinch; the other does not start a pan.
      if (this.pointers.size < 2) this.gesture = null;
      if (!this.pointers.size) this.saveViewport();
      return;
    }
    if (gesture.pointer !== event.pointerId) return;
    this.gesture = null;
    this.el.classList.remove("is-panning", "is-dragging");
    switch (gesture.kind) {
      case "pan": {
        this.saveViewport();
        const still =
          Math.hypot(
            event.clientX - gesture.startX,
            event.clientY - gesture.startY,
          ) < DRAG_THRESHOLD;
        if (still && !cancelled) {
          this.select([]);
          if (this.trackTap("background", event) && !this.readOnly)
            this.addTextCard(this.toWorld(event.clientX, event.clientY));
        }
        break;
      }
      case "move":
        if (gesture.moved) this.commit();
        else if (!cancelled) {
          if (
            gesture.additive &&
            this.selected.has(gesture.target.id) &&
            this.selected.size > 1
          ) {
            // A plain shift-click on a selected card deselects it.
          } else if (!gesture.additive) this.select([gesture.target.id]);
          if (this.trackTap(gesture.target.id, event))
            this.activateNode(gesture.target, event);
        }
        break;
      case "resize":
        this.commit();
        break;
      case "connect": {
        this.overlayEl.replaceChildren();
        for (const el of this.nodeEls.values())
          el.classList.remove("is-drop-target");
        if (cancelled) break;
        const target = this.nodeAt(event.clientX, event.clientY);
        if (target && target !== gesture.from) {
          const edge = addEdge(this.data, {
            fromNode: gesture.from.id,
            fromSide: gesture.side,
            toNode: target.id,
            toSide: facingSide(
              target,
              this.toWorld(event.clientX, event.clientY),
            ),
          });
          if (edge) {
            this.renderEdges();
            this.select([], [edge.id]);
            this.commit();
          }
        }
        break;
      }
      case "select":
        gesture.box.remove();
        break;
    }
  }

  private cancelGesture(): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) return;
    this.el.classList.remove("is-panning", "is-dragging");
    if (gesture.kind === "move" && gesture.moved) {
      for (const item of gesture.nodes) {
        item.node.x = item.x;
        item.node.y = item.y;
      }
      this.render();
    } else if (gesture.kind === "resize") {
      gesture.node.width = gesture.width;
      gesture.node.height = gesture.height;
      this.render();
    } else if (gesture.kind === "connect") this.overlayEl.replaceChildren();
    else if (gesture.kind === "select") gesture.box.remove();
  }

  /** True on the second tap at the same target within the double-tap window. */
  private trackTap(id: string, event: PointerEvent): boolean {
    const now = event.timeStamp || performance.now();
    const last = this.lastTap;
    if (
      last &&
      last.id === id &&
      now - last.time < DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - last.x, event.clientY - last.y) < 24
    ) {
      this.lastTap = null;
      if (id.startsWith("edge:")) {
        const edge = this.data.edges.find((item) => `edge:${item.id}` === id);
        if (edge && !this.readOnly) void this.editEdgeLabel(edge);
        return false;
      }
      return true;
    }
    this.lastTap = { id, time: now, x: event.clientX, y: event.clientY };
    return false;
  }

  private activateNode(node: CanvasNode, event: PointerEvent): void {
    const newTab = event.ctrlKey || event.metaKey;
    if (node.type === "file") {
      const resolved = this.host.resolve(node.file, this.path);
      if (resolved) this.host.openFile(resolved, newTab);
    } else if (node.type === "link") this.host.openExternal(node.url);
    else this.startEditing(node.id);
  }

  private nodeAt(clientX: number, clientY: number): CanvasNode | undefined {
    const point = this.toWorld(clientX, clientY);
    // Topmost first; cards are drawn above groups.
    const ordered = [
      ...this.data.nodes.filter((node) => node.type !== "group"),
      ...this.data.nodes.filter((node) => node.type === "group"),
    ];
    for (let i = ordered.length - 1; i >= 0; i--) {
      const node = ordered[i];
      if (
        point.x >= node.x &&
        point.y >= node.y &&
        point.x <= node.x + node.width &&
        point.y <= node.y + node.height
      )
        return node;
    }
    return undefined;
  }

  private saveViewport(): void {
    if (this.path) viewports.set(this.path, this.view);
  }

  private onClick(event: MouseEvent): void {
    const link = (event.target as Element).closest<HTMLElement>("a");
    if (!link || !this.viewportEl.contains(link)) return;
    event.preventDefault();
    const newTab = event.ctrlKey || event.metaKey;
    if (link.classList.contains("internal-link"))
      this.host.openLink(link.dataset.note ?? "", this.path, newTab);
    else if (link.classList.contains("external-link"))
      this.host.openExternal(link.getAttribute("href") ?? "");
  }

  private onWheel(event: WheelEvent): void {
    if (this.isEditable(event.target)) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(
        -event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025),
      );
      this.zoomAround(this.view.zoom * factor, event.clientX, event.clientY);
    } else {
      const scale = event.deltaMode === 1 ? 16 : 1;
      this.setViewport({
        ...this.view,
        x: this.view.x - event.deltaX * scale,
        y: this.view.y - event.deltaY * scale,
      });
    }
    this.saveViewport();
  }

  private onKey(event: KeyboardEvent): void {
    if (this.isEditable(event.target)) return;
    const mod = isMac ? event.metaKey : event.ctrlKey;
    const key = event.key.toLowerCase();
    let handled = true;
    if (event.key === "Delete" || event.key === "Backspace")
      this.deleteSelection();
    else if (event.key === "Escape") this.select([]);
    else if (mod && key === "z" && !event.shiftKey) this.undo();
    else if (mod && (key === "y" || (key === "z" && event.shiftKey)))
      this.redo();
    else if (mod && key === "a")
      this.select(this.data.nodes.map((node) => node.id));
    else if (event.key === "Enter" && this.selected.size === 1) {
      const node = nodeById(this.data, [...this.selected][0]);
      if (node?.type === "file") {
        const resolved = this.host.resolve(node.file, this.path);
        if (resolved) this.host.openFile(resolved, mod);
      } else if (node) this.startEditing(node.id);
    } else if (!mod && (event.key === "+" || event.key === "="))
      this.zoomBy(1.25);
    else if (!mod && event.key === "-") this.zoomBy(0.8);
    else if (event.shiftKey && event.key === "!") this.fit();
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  private onContextMenu(event: MouseEvent): void {
    if (this.isEditable(event.target)) return;
    event.preventDefault();
    if (this.readOnly) return;
    const at = { x: event.clientX, y: event.clientY };
    const world = this.toWorld(event.clientX, event.clientY);
    const target = event.target as Element;
    const nodeEl = target.closest<HTMLElement>(".canvas-node");
    const node = nodeEl
      ? nodeById(this.data, nodeEl.dataset.nodeId ?? "")
      : undefined;
    const edgeId = target.closest<SVGGElement>(".canvas-edge")?.dataset.edgeId;
    const edge = edgeId
      ? this.data.edges.find((item) => item.id === edgeId)
      : undefined;
    let entries: MenuEntry[];
    if (edge) {
      this.select([], [edge.id]);
      entries = [
        {
          title: "Beschriften",
          icon: "type",
          onClick: () => void this.editEdgeLabel(edge),
        },
        {
          title: "Richtung umkehren",
          icon: "arrow-left-right",
          onClick: () => {
            const { fromNode, fromSide, toNode, toSide } = edge;
            edge.fromNode = toNode;
            edge.toNode = fromNode;
            if (toSide) edge.fromSide = toSide;
            else delete edge.fromSide;
            if (fromSide) edge.toSide = fromSide;
            else delete edge.toSide;
            this.renderEdges();
            this.commit();
          },
        },
        {
          title: "Farbe ändern",
          icon: "palette",
          onClick: () => this.colorMenu(at),
        },
        "separator",
        {
          title: "Verbindung löschen",
          icon: "trash-2",
          danger: true,
          onClick: () => this.deleteSelection(),
        },
      ];
    } else if (node) {
      if (!this.selected.has(node.id)) this.select([node.id]);
      entries = [
        node.type === "file"
          ? {
              title: "Datei öffnen",
              icon: "file-text",
              onClick: () => {
                const resolved = this.host.resolve(node.file, this.path);
                if (resolved) this.host.openFile(resolved, false);
              },
            }
          : node.type === "text" || node.type === "group"
            ? {
                title: node.type === "group" ? "Umbenennen" : "Bearbeiten",
                icon: "pencil",
                onClick: () => this.startEditing(node.id),
              }
            : null,
        {
          title: "Farbe ändern",
          icon: "palette",
          onClick: () => this.colorMenu(at),
        },
        {
          title: "Gruppe um Auswahl",
          icon: "group",
          onClick: () => this.addGroup(),
        },
        "separator",
        {
          title: "Löschen",
          icon: "trash-2",
          danger: true,
          onClick: () => this.deleteSelection(),
        },
      ];
    } else {
      entries = [
        {
          title: "Karte hinzufügen",
          icon: "sticky-note",
          onClick: () => this.addTextCard(world),
        },
        {
          title: "Notiz hinzufügen",
          icon: "file-text",
          onClick: () => this.pickFile(world),
        },
        {
          title: "Weblink hinzufügen",
          icon: "link",
          onClick: () => void this.addLinkCard(world),
        },
        {
          title: "Gruppe hinzufügen",
          icon: "group",
          onClick: () => this.addGroup(world),
        },
        "separator",
        { title: "Alles anzeigen", icon: "scan", onClick: () => this.fit() },
      ];
    }
    showMenu(entries, at);
  }
}

function opposite(side: CanvasSide): CanvasSide {
  return (
    { top: "bottom", bottom: "top", left: "right", right: "left" } as const
  )[side];
}

function arrow(
  tip: { x: number; y: number },
  side: CanvasSide,
): SVGPathElement {
  // The arrow points into the card, against the side's outward normal.
  const normal = {
    top: { x: 0, y: -1 },
    bottom: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  }[side];
  const length = 12;
  const half = 6;
  const base = { x: tip.x + normal.x * length, y: tip.y + normal.y * length };
  const perp = { x: -normal.y, y: normal.x };
  return svg("path", {
    class: "canvas-edge-arrow",
    d: `M ${tip.x} ${tip.y} L ${base.x + perp.x * half} ${base.y + perp.y * half} L ${base.x - perp.x * half} ${base.y - perp.y * half} Z`,
  });
}

/** Small text prompt built on the app modal; resolves `null` when cancelled. */
function prompt(
  title: string,
  label: string,
  initial: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new Modal("mod-canvas-prompt");
    modal.setTitle(title);
    const input = h("input", {
      label,
      attrs: { type: "text", autocomplete: "off", enterkeyhint: "done" },
    });
    input.value = initial;
    let result: string | null = null;
    const form = h(
      "form",
      { attrs: { novalidate: true } },
      input,
      h(
        "div",
        "modal-button-container",
        h("button", {
          text: "Abbrechen",
          attrs: { type: "button" },
          on: { click: () => modal.close() },
        }),
        h("button", {
          class: "mod-cta",
          text: "Übernehmen",
          attrs: { type: "submit" },
        }),
      ),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      result = input.value;
      modal.close();
    });
    modal.onClose = () => resolve(result);
    modal.contentEl.append(form);
    modal.open();
    input.focus();
    input.select();
  });
}
