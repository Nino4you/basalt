import { createElement as createSvg } from "lucide";
import { hostIcons } from "./icon-set";
import { findIcon } from "./icon-library";

export type Child = Node | string | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  id?: string;
  title?: string;
  /** Sets `aria-label`; the tooltip layer picks it up for icon buttons. */
  label?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  data?: Record<string, string>;
  on?: {
    [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void;
  };
}

/** Small hyperscript helper; the whole UI is plain DOM without a framework. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | string | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (typeof props === "string") node.className = props;
  else if (props) {
    if (props.class) node.className = props.class;
    if (props.text !== undefined) node.textContent = props.text;
    if (props.id) node.id = props.id;
    if (props.title) node.title = props.title;
    if (props.label) node.setAttribute("aria-label", props.label);
    if (props.attrs)
      for (const [name, value] of Object.entries(props.attrs)) {
        if (value === null || value === undefined || value === false) continue;
        node.setAttribute(name, value === true ? "" : String(value));
      }
    if (props.data) Object.assign(node.dataset, props.data);
    if (props.on)
      for (const [name, handler] of Object.entries(props.on))
        node.addEventListener(name, handler as EventListener);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

/** Creates one Lucide SVG directly; nothing ever rescans the document for icons. */
export function icon(id: string, size = 18): SVGElement {
  const node = findIcon(id) ?? hostIcons.File!;
  const svg = createSvg(node);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("svg-icon");
  return svg as unknown as SVGElement;
}

/** Obsidian-style borderless icon button. */
export function iconButton(
  id: string,
  label: string,
  onClick: (event: MouseEvent) => void,
  extraClass = "",
): HTMLButtonElement {
  return h(
    "button",
    {
      class: `clickable-icon${extraClass ? ` ${extraClass}` : ""}`,
      label,
      attrs: { type: "button" },
      on: { click: onClick },
    },
    icon(id),
  );
}

export function clear(node: Element): void {
  node.replaceChildren();
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** Renders "Mod+Shift+F" the way the platform writes it. */
export function formatHotkey(hotkey: string): string {
  return hotkey
    .split("+")
    .map((part) => {
      if (part === "Mod") return isMac ? "⌘" : "Strg";
      if (part === "Shift") return isMac ? "⇧" : "Umschalt";
      if (part === "Alt") return isMac ? "⌥" : "Alt";
      if (part === "ArrowLeft") return "←";
      if (part === "ArrowRight") return "→";
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(isMac ? " " : " + ");
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
): ((...args: A) => void) & { cancel(): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | null = null;
  const run = () => {
    timer = undefined;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  const wrapped = (...args: A) => {
    pending = args;
    clearTimeout(timer);
    timer = setTimeout(run, wait);
  };
  wrapped.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = null;
  };
  wrapped.flush = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    run();
  };
  return wrapped;
}

/** Coalesces repeated calls into one run per animation frame. */
export function frameThrottle(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

export function basename(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/\.(md|canvas)$/i, "");
}

export function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index + 1).toLowerCase();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Colours a range input's track up to its thumb (WebKit has no native fill). */
export function trackSliderFill(input: HTMLInputElement): void {
  const update = () => {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const ratio = max > min ? (Number(input.value) - min) / (max - min) : 0;
    input.style.setProperty(
      "--slider-fill",
      `${(Math.min(1, Math.max(0, ratio)) * 100).toFixed(1)}%`,
    );
  };
  input.addEventListener("input", update);
  update();
}
