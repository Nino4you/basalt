import { h, icon, trackSliderFill } from "../ui/dom";
import { Modal } from "../ui/modal";
import type { App } from "./app";
import {
  buildGraph,
  defaultGraphOptions,
  ForceLayout,
  nodeRadius,
  type GraphData,
  type GraphNode,
  type GraphOptions,
} from "./graph-model";

const SVG = "http://www.w3.org/2000/svg";
const OPTIONS_KEY = "basalt-graph";
const MIN_SCALE = 0.1;
const MAX_SCALE = 6;
/**
 * Zoom at which labels start to fade in, per label tier (0 = leaf, 3 = hub).
 * Hubs are named first, like in Obsidian; focused nodes are always readable.
 */
const LABEL_SCALE = [0.85, 0.6, 0.35, 0.05];
const LABEL_FADE = 0.25;
/** Most layout ticks per frame; small graphs settle at an even pace. */
const TICKS_PER_FRAME = 2;
/**
 * Layout time per frame. A tick of a large vault (5000 notes) takes longer
 * than this alone, so such layouts tick only on every other frame and the
 * frames in between stay free for panning, zooming and hover.
 */
const FRAME_BUDGET = 8;
const GROUP_COLORS = 8;

function graphSignature(data: GraphData): string {
  return [
    ...data.nodes.map(
      (node) => `${node.kind}:${node.group}:${node.id}:${node.label}`,
    ),
    ...data.edges.map((edge) => `${edge.source}>${edge.target}`),
  ].join("\n");
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs))
    node.setAttribute(name, value);
  return node;
}

const radiusOf = (node: GraphNode) => nodeRadius(node.degree);

const labelTier = (degree: number) =>
  degree >= 12 ? 3 : degree >= 6 ? 2 : degree >= 3 ? 1 : 0;

/** Label size on screen: grows gently with zoom, stays readable when small. */
const labelPixels = (scale: number) =>
  Math.min(18, Math.max(10.5, 13 * Math.pow(scale, 0.4)));

const reducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface GraphViewHandlers {
  /** Called for a click or Enter on a node; `newTab` for Ctrl/Cmd. */
  activate(node: GraphNode, newTab: boolean): void;
}

interface Rendered {
  node: GraphNode;
  el: SVGGElement;
  circle: SVGCircleElement;
  label: SVGTextElement;
  edges: SVGLineElement[];
  neighbours: Set<string>;
}

/**
 * SVG graph with pan, wheel/pinch zoom, node dragging and keyboard access.
 * Every node is a focusable button named after its note.
 */
export class GraphView {
  readonly el: HTMLElement;
  private readonly svgEl: SVGSVGElement;
  private readonly viewport: SVGGElement;
  private readonly edgeLayer: SVGGElement;
  private readonly nodeLayer: SVGGElement;
  private readonly emptyEl: HTMLElement;
  private readonly layout = new ForceLayout();
  private rendered = new Map<string, Rendered>();
  private edgeEnds: Array<[SVGLineElement, string, string]> = [];
  private frame = 0;
  /** Smoothed cost of one layout tick in ms, for the frame budget. */
  private tickCost = 0;
  /** Frames left to skip before the next tick when one tick exceeds the budget. */
  private skipFrames = 0;
  private scale = 1;
  private tx = 0;
  private ty = 0;
  /** Width covered at the right edge by an overlay; fitting avoids it. */
  fitInset: () => number = () => 0;
  private measured: { width: number; height: number; inset: number } | null =
    null;
  /** Until the user pans or zooms, the view keeps fitting the whole graph. */
  private autoFit = true;
  private target: { scale: number; tx: number; ty: number } | null = null;
  private signature: string | null = null;
  private activeId: string | null = null;
  private hovered: string | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private gesture: {
    kind: "pan" | "node" | "pinch";
    id?: string;
    moved: boolean;
    startX: number;
    startY: number;
    distance?: number;
  } | null = null;
  private readonly resize: ResizeObserver | null;
  private destroyed = false;

  constructor(
    private readonly handlers: GraphViewHandlers,
    label: string,
    emptyText: string,
  ) {
    this.edgeLayer = svg("g", { class: "graph-edges" });
    this.nodeLayer = svg("g", { class: "graph-nodes" });
    this.viewport = svg("g", { class: "graph-viewport" });
    this.viewport.append(this.edgeLayer, this.nodeLayer);
    this.svgEl = svg("svg", {
      class: "graph-canvas",
      role: "group",
      tabindex: "0",
      "aria-label": label,
      "aria-description":
        "Pfeiltasten verschieben den Graphen, Plus und Minus zoomen. Umschalt beschleunigt. Knoten mit Tab auswählen und mit Enter öffnen.",
    });
    this.svgEl.append(this.viewport);
    this.emptyEl = h("div", {
      class: "pane-empty graph-empty",
      text: emptyText,
      attrs: { hidden: true },
    });
    const controls = h(
      "div",
      "graph-controls",
      this.controlButton("plus", "Vergrößern", () => this.zoomBy(1.4)),
      this.controlButton("minus", "Verkleinern", () => this.zoomBy(1 / 1.4)),
      this.controlButton("maximize", "Ansicht einpassen", () => {
        this.autoFit = true;
        this.fit(false);
      }),
    );
    this.el = h("div", "graph-view", this.svgEl, this.emptyEl, controls);
    this.bindPointer();
    this.resize =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            this.measured = null;
            if (this.autoFit) this.fit(true);
          })
        : null;
    this.resize?.observe(this.svgEl);
  }

  private controlButton(
    id: string,
    label: string,
    run: () => void,
  ): HTMLButtonElement {
    return h(
      "button",
      {
        class: "clickable-icon",
        label,
        attrs: { type: "button" },
        on: { click: run },
      },
      icon(id, 16),
    );
  }

  /** Refits after the visible area changed, unless the user moved the camera. */
  refit(): void {
    this.measured = null;
    if (this.autoFit) this.fit(false);
  }

  get nodeCount(): number {
    return this.rendered.size;
  }

  setGroupColors(enabled: boolean): void {
    this.el.classList.toggle("graph-color-groups", enabled);
  }

  setData(data: GraphData, activeId: string | null = null): void {
    if (this.destroyed) return;
    // Edits that do not change links (most keystrokes) leave the layout alone.
    const signature = graphSignature(data);
    if (signature === this.signature) {
      this.setActive(activeId);
      return;
    }
    const first = !this.rendered.size;
    const focused = this.nodeLayer.contains(document.activeElement)
      ? this.nodeFrom(document.activeElement)?.node.id
      : null;
    this.signature = signature;
    this.layout.setGraph(data);
    this.hovered = null;
    this.svgEl.classList.remove("has-focus");
    const previous = this.rendered;
    this.rendered = new Map();
    this.edgeLayer.replaceChildren();
    this.nodeLayer.replaceChildren();
    for (const node of data.nodes) {
      const old = previous.get(node.id);
      const el =
        old?.el ??
        svg("g", { class: "graph-node", role: "button", tabindex: "0" });
      const circle = old?.circle ?? svg("circle");
      const label = old?.label ?? svg("text", { class: "graph-label" });
      if (!old)
        el.append(
          svg("ellipse", { class: "graph-hit-area", rx: "1", ry: "1" }),
          circle,
          label,
        );
      el.setAttribute("aria-label", node.label);
      el.dataset.id = node.id;
      el.dataset.tier = String(labelTier(node.degree));
      el.setAttribute("class", `graph-node is-${node.kind}`);
      // Preserve component colors for the optional group display.
      if (node.group < 0) {
        el.classList.add("is-isolated");
        delete el.dataset.color;
      } else el.dataset.color = String(node.group % GROUP_COLORS);
      // Nodes that appear in a live update fade in instead of popping up.
      if (!old && !first) {
        el.classList.add("is-entering");
        el.addEventListener(
          "animationend",
          () => el.classList.remove("is-entering"),
          { once: true },
        );
      }
      const r = radiusOf(node);
      circle.setAttribute("r", String(r));
      // The hit area hugs the node plus a fixed on-screen margin (CSS), so
      // small notes next to a hub do not steal its pointer.
      const hit = el.querySelector(".graph-hit-area");
      hit?.setAttribute("rx", String(r));
      hit?.setAttribute("ry", String(r));
      label.setAttribute("y", String(r + 3));
      label.textContent = node.label;
      this.nodeLayer.append(el);
      this.rendered.set(node.id, {
        node,
        el,
        circle,
        label,
        edges: [],
        neighbours: new Set(),
      });
    }
    this.edgeEnds = [];
    for (const edge of data.edges) {
      const line = svg("line", { class: "graph-edge" });
      this.edgeLayer.append(line);
      this.edgeEnds.push([line, edge.source, edge.target]);
      const a = this.rendered.get(edge.source)!;
      const b = this.rendered.get(edge.target)!;
      a.edges.push(line);
      b.edges.push(line);
      a.neighbours.add(edge.target);
      b.neighbours.add(edge.source);
    }
    this.activeId = null;
    this.setActive(activeId);
    this.emptyEl.hidden = data.nodes.length > 0;
    if (reducedMotion()) {
      this.layout.run(250);
      this.layout.alpha = 0;
    } else if (first) {
      // Open mostly arranged; the rest settles visibly in a second or so.
      const end = performance.now() + 160;
      while (this.layout.alpha > 0.08 && performance.now() < end)
        this.layout.tick();
    }
    this.draw();
    if (this.autoFit) this.fit(first || reducedMotion());
    this.schedule();
    if (focused)
      (this.rendered.get(focused)?.el ?? this.svgEl).focus({
        preventScroll: true,
      });
  }

  private setActive(id: string | null): void {
    if (id === this.activeId) return;
    if (this.activeId)
      this.rendered.get(this.activeId)?.el.classList.remove("is-active");
    this.activeId = id;
    if (id) this.rendered.get(id)?.el.classList.add("is-active");
  }

  /** One animation frame: a fixed number of ticks keeps motion even. */
  private schedule(): void {
    if (this.frame || this.destroyed) return;
    if (this.layout.settled && this.cameraSettled()) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.destroyed) return;
      if (!this.layout.settled && this.tickWithinBudget()) {
        this.draw();
        if (this.autoFit) this.fit(false);
      }
      this.stepCamera();
      this.schedule();
    });
  }

  /**
   * Runs as many ticks as fit into the frame budget, at most
   * `TICKS_PER_FRAME`; false if this frame was left to input instead.
   */
  private tickWithinBudget(): boolean {
    if (this.skipFrames > 0) {
      this.skipFrames--;
      return false;
    }
    const start = performance.now();
    let ticks = 0;
    let elapsed = 0;
    do {
      const before = performance.now();
      this.layout.tick();
      const cost = performance.now() - before;
      this.tickCost = this.tickCost ? this.tickCost * 0.7 + cost * 0.3 : cost;
      ticks++;
      elapsed = performance.now() - start;
    } while (
      ticks < TICKS_PER_FRAME &&
      !this.layout.settled &&
      elapsed + this.tickCost <= FRAME_BUDGET
    );
    // One tick over the budget: leave the next frame(s) to the camera, so
    // layout takes about half of the time.
    this.skipFrames = Math.min(2, Math.floor(elapsed / FRAME_BUDGET));
    return true;
  }

  private draw(): void {
    for (const [id, item] of this.rendered) {
      const node = this.layout.get(id);
      if (!node) continue;
      item.el.setAttribute(
        "transform",
        `translate(${node.x.toFixed(1)},${node.y.toFixed(1)})`,
      );
    }
    for (const [line, a, b] of this.edgeEnds) {
      const from = this.layout.get(a)!;
      const to = this.layout.get(b)!;
      line.setAttribute("x1", from.x.toFixed(1));
      line.setAttribute("y1", from.y.toFixed(1));
      line.setAttribute("x2", to.x.toFixed(1));
      line.setAttribute("y2", to.y.toFixed(1));
    }
  }

  /** Layout size, unaffected by the dialog's opening transform. */
  private size(): { width: number; height: number; inset: number } {
    // Measured once per resize: reading layout in every animation frame,
    // right after moving the nodes, forces a synchronous relayout.
    if (this.measured) return this.measured;
    const width = this.svgEl.clientWidth || this.el.clientWidth;
    const height = this.svgEl.clientHeight || this.el.clientHeight;
    const size = {
      width: width || 300,
      height: height || 300,
      inset: Math.min(this.fitInset(), (width || 300) * 0.35),
    };
    if (width && height) this.measured = size;
    return size;
  }

  /**
   * Screen-space extents of the graph at `scale`, relative to the origin,
   * including the labels centred below the nodes that are readable there.
   */
  private extents(scale: number): {
    left: number;
    right: number;
    top: number;
    bottom: number;
  } {
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    const font = labelPixels(scale);
    for (const item of this.rendered.values()) {
      const node = this.layout.get(item.node.id);
      if (!node) continue;
      const r = radiusOf(item.node) * scale;
      const x = node.x * scale;
      const y = node.y * scale;
      let half = r;
      let below = r;
      if (
        item.node.id === this.activeId ||
        scale >= this.labelStart(labelTier(item.node.degree))
      ) {
        half = Math.max(r, (item.node.label.length * font * 0.56) / 2);
        below = r + 3 * scale + font * 1.2;
      }
      left = Math.min(left, x - half);
      right = Math.max(right, x + half);
      top = Math.min(top, y - r);
      bottom = Math.max(bottom, y + below);
    }
    if (left === Infinity) return { left: 0, right: 0, top: 0, bottom: 0 };
    return { left, right, top, bottom };
  }

  /** Targets a camera that shows the whole graph centred; `snap` jumps there. */
  fit(snap = true): void {
    const { width, height, inset } = this.size();
    const { x0, y0, x1, y1 } = this.layout.bounds();
    const margin = Math.min(32, width / 10, height / 10);
    // Space covered by overlays (the settings panel) is left free.
    const availableW = Math.max(width - inset - margin * 2, 1);
    const availableH = Math.max(height - margin * 2, 1);
    let scale = Math.max(
      MIN_SCALE,
      Math.min(
        availableW / Math.max(x1 - x0, 1),
        availableH / Math.max(y1 - y0, 1),
        1.3,
      ),
    );
    // Labels grow slower than the graph, so shrink in a few steps until the
    // nodes and their labels fit.
    let box = this.extents(scale);
    for (let i = 0; i < 6; i++) {
      const k = Math.min(
        availableW / Math.max(box.right - box.left, 1),
        availableH / Math.max(box.bottom - box.top, 1),
      );
      if (k >= 0.995 || scale <= MIN_SCALE) break;
      scale = Math.max(MIN_SCALE, scale * k);
      box = this.extents(scale);
    }
    this.target = {
      scale,
      tx: (width - inset) / 2 - (box.left + box.right) / 2,
      ty: height / 2 - (box.top + box.bottom) / 2,
    };
    if (snap || reducedMotion()) {
      this.scale = scale;
      this.tx = this.target.tx;
      this.ty = this.target.ty;
      this.applyTransform();
    }
    this.schedule();
  }

  private cameraSettled(): boolean {
    const t = this.target;
    return (
      !t ||
      (Math.abs(t.scale - this.scale) < 0.001 &&
        Math.abs(t.tx - this.tx) < 0.5 &&
        Math.abs(t.ty - this.ty) < 0.5)
    );
  }

  /** Eases the camera towards its target so refits never jump. */
  private stepCamera(): void {
    const t = this.target;
    if (!t || this.cameraSettled()) return;
    const k = 0.18;
    this.scale += (t.scale - this.scale) * k;
    this.tx += (t.tx - this.tx) * k;
    this.ty += (t.ty - this.ty) * k;
    this.applyTransform();
  }

  private applyTransform(): void {
    const scale = this.scale;
    this.viewport.setAttribute(
      "transform",
      `translate(${this.tx.toFixed(1)},${this.ty.toFixed(1)}) scale(${scale.toFixed(3)})`,
    );
    // Label state lives on the node layer, not the whole SVG, and is only
    // written when it changes: every write restyles each node, which is what
    // costs frames in large vaults.
    LABEL_SCALE.forEach((_, tier) => {
      const start = this.labelStart(tier);
      const opacity = Math.min(1, Math.max(0, (scale - start) / LABEL_FADE));
      this.setLabelVar(`--graph-label-${tier}`, opacity.toFixed(2));
      // Invisible labels are taken out of rendering.
      this.nodeLayer.classList.toggle(`hide-labels-${tier}`, opacity <= 0);
    });
    // Neighbours of a hovered node are named a little earlier than the rest.
    this.setLabelVar(
      "--graph-label-near",
      Math.min(1, Math.max(0, (scale - 0.4) / LABEL_FADE)).toFixed(2),
    );
    // Labels keep a readable on-screen size instead of scaling with the
    // graph. Steps of about 3% are invisible but spare most restyles.
    const font = labelPixels(scale) / scale;
    const stepped = Math.exp(Math.round(Math.log(font) / 0.03) * 0.03);
    this.setLabelVar("--graph-font-size", `${stepped.toFixed(2)}px`);
  }

  private readonly labelVars = new Map<string, string>();

  private setLabelVar(name: string, value: string): void {
    if (this.labelVars.get(name) === value) return;
    this.labelVars.set(name, value);
    this.nodeLayer.style.setProperty(name, value);
  }

  /** Small graphs (most local graphs) name every node at lower zoom. */
  private labelStart(tier: number): number {
    const crowd = Math.min(1, Math.max(0.3, this.rendered.size / 80));
    return LABEL_SCALE[tier] * crowd;
  }

  /** Stops automatic refits; the user has taken over the camera. */
  private takeCamera(): void {
    this.autoFit = false;
    this.target = null;
  }

  private zoomBy(factor: number, cx?: number, cy?: number): void {
    const { width, height } = this.size();
    const x = cx ?? width / 2;
    const y = cy ?? height / 2;
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * factor));
    this.tx = x - ((x - this.tx) * next) / this.scale;
    this.ty = y - ((y - this.ty) * next) / this.scale;
    this.scale = next;
    this.takeCamera();
    this.applyTransform();
  }

  private local(event: { clientX: number; clientY: number }) {
    const rect = this.svgEl.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private nodeFrom(target: EventTarget | null): Rendered | null {
    const el = (target as Element | null)?.closest?.<SVGGElement>(
      ".graph-node",
    );
    return el?.dataset.id ? (this.rendered.get(el.dataset.id) ?? null) : null;
  }

  private setHover(id: string | null): void {
    if (id === this.hovered) return;
    this.hovered = id;
    const focus = id ? this.rendered.get(id) : null;
    this.svgEl.classList.toggle("has-focus", !!focus);
    for (const [other, item] of this.rendered) {
      const near = !!focus && (other === id || focus.neighbours.has(other));
      item.el.classList.toggle("is-highlighted", near);
      item.el.classList.toggle("is-focused", other === id);
    }
    for (const [line, a, b] of this.edgeEnds)
      line.classList.toggle("is-highlighted", !!id && (a === id || b === id));
  }

  private bindPointer(): void {
    const el = this.svgEl;
    el.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      el.setPointerCapture?.(event.pointerId);
      this.pointers.set(event.pointerId, this.local(event));
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.gesture = {
          kind: "pinch",
          moved: true,
          startX: 0,
          startY: 0,
          distance: Math.hypot(a.x - b.x, a.y - b.y),
        };
        return;
      }
      const hit = this.nodeFrom(event.target);
      const { x, y } = this.local(event);
      this.gesture = {
        kind: hit ? "node" : "pan",
        id: hit?.node.id,
        moved: false,
        startX: x,
        startY: y,
      };
      if (hit) this.setHover(hit.node.id);
    });
    el.addEventListener("pointermove", (event) => {
      const point = this.local(event);
      const last = this.pointers.get(event.pointerId);
      if (!last || !this.gesture) {
        if (event.pointerType === "mouse")
          this.setHover(this.nodeFrom(event.target)?.node.id ?? null);
        return;
      }
      this.pointers.set(event.pointerId, point);
      const gesture = this.gesture;
      if (gesture.kind === "pinch") {
        const [a, b] = [...this.pointers.values()];
        if (!a || !b) return;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (gesture.distance)
          this.zoomBy(
            distance / gesture.distance,
            (a.x + b.x) / 2,
            (a.y + b.y) / 2,
          );
        gesture.distance = distance;
        return;
      }
      if (
        !gesture.moved &&
        Math.hypot(point.x - gesture.startX, point.y - gesture.startY) < 4
      )
        return;
      gesture.moved = true;
      if (gesture.kind === "pan") {
        this.tx += point.x - last.x;
        this.ty += point.y - last.y;
        this.takeCamera();
        this.applyTransform();
      } else if (gesture.id) {
        const node = this.layout.get(gesture.id);
        if (!node) return;
        node.fixed = true;
        node.x = (point.x - this.tx) / this.scale;
        node.y = (point.y - this.ty) / this.scale;
        this.takeCamera();
        // Like d3's drag: keep the layout warm while the node is held.
        this.layout.alphaTarget = 0.3;
        this.layout.reheat(0.3);
        this.draw();
        this.schedule();
      }
    });
    const end = (event: PointerEvent) => {
      this.pointers.delete(event.pointerId);
      const gesture = this.gesture;
      if (!gesture) return;
      if (gesture.kind === "pinch") {
        if (!this.pointers.size) this.gesture = null;
        return;
      }
      this.gesture = null;
      if (gesture.id) {
        const node = this.layout.get(gesture.id);
        if (node) node.fixed = false;
        this.layout.alphaTarget = 0;
        if (event.pointerType !== "mouse") this.setHover(null);
      }
      if (
        event.type === "pointerup" &&
        !gesture.moved &&
        gesture.kind === "node" &&
        gesture.id
      ) {
        const item = this.rendered.get(gesture.id);
        if (item)
          this.handlers.activate(item.node, event.ctrlKey || event.metaKey);
      }
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse" && !this.gesture) this.setHover(null);
    });
    el.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const { x, y } = this.local(event);
        this.zoomBy(Math.exp(-event.deltaY * 0.0015), x, y);
      },
      { passive: false },
    );
    el.addEventListener("keydown", (event) => {
      const item = this.nodeFrom(event.target);
      if (item && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        this.handlers.activate(item.node, event.ctrlKey || event.metaKey);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const direction: Record<string, [number, number]> = {
        ArrowLeft: [1, 0],
        ArrowRight: [-1, 0],
        ArrowUp: [0, 1],
        ArrowDown: [0, -1],
      };
      const delta = direction[event.key];
      if (delta) {
        const step = event.shiftKey ? 100 : 30;
        this.tx += delta[0] * step;
        this.ty += delta[1] * step;
        this.takeCamera();
        this.applyTransform();
      } else if (["+", "=", "-", "_"].includes(event.key)) {
        const factor = event.shiftKey ? 1.6 : 1.2;
        this.zoomBy(
          event.key === "-" || event.key === "_" ? 1 / factor : factor,
        );
      } else return;
      event.preventDefault();
      event.stopPropagation();
    });
    el.addEventListener("focusin", (event) =>
      this.setHover(this.nodeFrom(event.target)?.node.id ?? null),
    );
    el.addEventListener("focusout", () => this.setHover(null));
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.resize?.disconnect();
  }
}

function loadOptions(): GraphOptions {
  const options = defaultGraphOptions();
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(OPTIONS_KEY) ?? "null",
    );
    if (raw && typeof raw === "object") {
      const value = raw as Record<string, unknown>;
      for (const key of [
        "showTags",
        "showUnresolved",
        "showOrphans",
        "colorGroups",
      ] as const)
        if (typeof value[key] === "boolean") options[key] = value[key];
    }
  } catch {
    // Graph filters are a convenience.
  }
  return options;
}

function storeOptions(options: GraphOptions): void {
  try {
    localStorage.setItem(
      OPTIONS_KEY,
      JSON.stringify({
        showTags: options.showTags,
        showUnresolved: options.showUnresolved,
        showOrphans: options.showOrphans,
        colorGroups: options.colorGroups,
      }),
    );
  } catch {
    // Ignore storage failures.
  }
}

/** Opens the note, unresolved link or tag search behind a graph node. */
export function activateGraphNode(
  app: App,
  node: GraphNode,
  newTab: boolean,
): void {
  if (node.kind === "note") void app.openPath(node.id, { newTab });
  else if (node.kind === "tag") app.searchFor(`tag:${node.label}`);
  else if (node.source) app.openLink(node.label, node.source, newTab);
}

function toggle(
  label: string,
  checked: boolean,
  change: (value: boolean) => void,
): HTMLElement {
  const input = h("input", {
    attrs: { type: "checkbox", checked },
    on: {
      change: () => {
        control.classList.toggle("is-enabled", input.checked);
        change(input.checked);
      },
    },
  });
  const control = h(
    "span",
    `checkbox-container${checked ? " is-enabled" : ""}`,
    input,
  );
  return h("label", "graph-toggle", h("span", { text: label }), control);
}

/** Global graph of the whole vault in a full-size dialog. */
export function openGraph(app: App): Modal {
  const modal = new Modal("mod-graph");
  modal.setTitle("Graphansicht");
  const options = loadOptions();
  const view = new GraphView(
    {
      activate: (node, newTab) => {
        modal.close();
        activateGraphNode(app, node, newTab);
      },
    },
    "Graph aller Notizen",
    "Keine Notizen für diese Auswahl.",
  );
  const count = h("span", { class: "graph-count" });
  const refresh = () => {
    if (!modal.isOpen && view.nodeCount) return;
    const data = buildGraph(app.index, options);
    view.setGroupColors(options.colorGroups);
    view.setData(data, app.activePath);
    count.textContent = `${data.nodes.length} Knoten · ${data.edges.length} Verbindungen`;
  };
  const filter = h("input", {
    class: "graph-filter",
    label: "Graph filtern",
    attrs: {
      type: "search",
      placeholder: "Dateien filtern …",
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  let filterTimer: ReturnType<typeof setTimeout> | undefined;
  filter.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      options.filter = filter.value;
      refresh();
    }, 120);
  });
  const set =
    (key: "showTags" | "showUnresolved" | "showOrphans" | "colorGroups") =>
    (value: boolean) => {
      options[key] = value;
      storeOptions(options);
      refresh();
    };
  const settings = h(
    "details",
    { class: "graph-settings", attrs: { open: true } },
    h(
      "summary",
      { class: "graph-settings-heading", label: "Graph-Einstellungen" },
      icon("settings", 16),
      h("span", { text: "Graph-Einstellungen" }),
      icon("chevron-down", 14),
    ),
    h(
      "details",
      { class: "graph-settings-section", attrs: { open: true } },
      h("summary", { text: "Filter" }),
      filter,
      toggle("Tags", options.showTags, set("showTags")),
      toggle(
        "Unaufgelöste Links",
        options.showUnresolved,
        set("showUnresolved"),
      ),
      toggle("Verwaiste Notizen", options.showOrphans, set("showOrphans")),
    ),
    h(
      "details",
      { class: "graph-settings-section" },
      h("summary", { text: "Darstellung" }),
      toggle("Gruppen einfärben", options.colorGroups, set("colorGroups")),
    ),
  );
  view.el.append(settings, count);
  view.fitInset = () =>
    settings.open && view.el.clientWidth > 760 ? settings.offsetWidth + 12 : 0;
  settings.addEventListener("toggle", () => view.refit());
  modal.contentEl.append(view.el);
  const unsubscribe = app.on("index", refresh);
  modal.onClose = () => {
    clearTimeout(filterTimer);
    unsubscribe();
    view.destroy();
  };
  modal.open();
  refresh();
  return modal;
}

/**
 * Graph in the right sidebar: the neighbourhood of the active note, or the
 * whole vault. It stays visible while editing and follows changes live.
 */
export class LocalGraph {
  private view: GraphView | null = null;
  private depth = 1;
  private whole = false;
  private key = "";

  constructor(
    private readonly app: App,
    private readonly pane: HTMLElement,
  ) {}

  render(path: string | null): void {
    const app = this.app;
    if (!this.view) {
      this.view = new GraphView(
        { activate: (node, newTab) => activateGraphNode(app, node, newTab) },
        "Lokaler Graph",
        "Keine Datei geöffnet.",
      );
      const depth = h("input", {
        class: "graph-depth",
        label: "Tiefe",
        attrs: { type: "range", min: 1, max: 3, step: 1, value: this.depth },
      });
      trackSliderFill(depth);
      const depthValue = h("span", {
        class: "graph-depth-value",
        text: String(this.depth),
      });
      depth.addEventListener("input", () => {
        this.depth = Number(depth.value);
        depthValue.textContent = depth.value;
        this.render(this.app.activePath);
      });
      const depthControl = h(
        "label",
        "graph-toggle",
        h("span", { text: "Tiefe" }),
        depth,
        depthValue,
      );
      // Settings stay out of the way behind a gear, like in Obsidian, so the
      // graph keeps the whole panel even when it is docked small.
      const settings = h(
        "details",
        { class: "graph-local-settings" },
        h(
          "summary",
          { class: "clickable-icon", label: "Graph-Einstellungen" },
          icon("settings", 16),
        ),
        h(
          "div",
          "graph-local-settings-body",
          depthControl,
          toggle("Ganzer Vault", this.whole, (value) => {
            this.whole = value;
            depthControl.hidden = value;
            this.render(this.app.activePath);
          }),
        ),
      );
      const view = this.view;
      view.el.addEventListener("pointerdown", (event) => {
        if (!settings.contains(event.target as Node)) settings.open = false;
      });
      settings.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !settings.open) return;
        event.preventDefault();
        event.stopPropagation();
        settings.open = false;
        settings.querySelector("summary")?.focus();
      });
      view.el.append(settings);
      this.pane.replaceChildren(view.el);
    }
    const key = `${path}|${app.index.revision}|${this.depth}|${this.whole}`;
    if (key === this.key) return;
    this.key = key;
    const options = loadOptions();
    this.view.setGroupColors(options.colorGroups);
    this.view.setData(
      this.whole
        ? buildGraph(app.index, { ...options, filter: "" })
        : path
          ? buildGraph(app.index, {
              ...options,
              filter: "",
              center: path,
              depth: this.depth,
            })
          : { nodes: [], edges: [] },
      path,
    );
  }
}
