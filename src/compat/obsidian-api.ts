import { getLocale } from "../i18n";
import obsidianMoment from "moment";
import { constructLegacy } from "./legacy-constructor";
import { installSvgCompat } from "./svg";
import "moment/locale/de.js";
import { API_VERSION } from "./api-version";
import { StateEffect, StateField } from "@codemirror/state";
import { renderedFacet } from "../editor/live-preview";
import DOMPurify from "dompurify";
import {
  fetchRequestUrl,
  type RequestUrl,
  type RequestUrlParam,
  type RequestUrlResponse,
} from "./request";
import { createElement } from "lucide";
import { findIcon, iconIds } from "../ui/icon-library";
import { showMenu, type MenuEntry } from "../ui/menu";
import { Component } from "./component";
import { SettingPage } from "./setting-page";
import { debounce } from "./debounce";
import { installDomEvents } from "./dom-events";
import { Editor, type EditorPosition } from "./editor-adapter";
import { Events } from "./events";
import { TAbstractFile, TFile, TFolder } from "./files";
import {
  getFrontMatterInfo,
  parseFrontMatterAliases,
  parseFrontMatterEntry,
  parseFrontMatterStringArray,
  parseFrontMatterTags,
  parseYaml,
  stringifyYaml,
} from "./frontmatter";
import { Plugin } from "./plugin";
import {
  MarkdownView,
  Workspace,
  WorkspaceLeaf,
  WorkspaceSidedock,
  WorkspaceSplit,
} from "./workspace";

export interface DomElementInfo {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | null>;
  title?: string;
  value?: string;
  type?: string;
  placeholder?: string;
  href?: string;
  parent?: HTMLElement;
}

declare global {
  function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: DomElementInfo | string,
    callback?: (element: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K];
  function createDiv(
    options?: DomElementInfo | string,
    callback?: (element: HTMLDivElement) => void,
  ): HTMLDivElement;
  function createSpan(
    options?: DomElementInfo | string,
    callback?: (element: HTMLSpanElement) => void,
  ): HTMLSpanElement;
  interface HTMLElement {
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      options?: DomElementInfo | string,
      callback?: (element: HTMLElementTagNameMap[K]) => void,
    ): HTMLElementTagNameMap[K];
    createDiv(
      options?: DomElementInfo | string,
      callback?: (element: HTMLDivElement) => void,
    ): HTMLDivElement;
    createSpan(
      options?: DomElementInfo | string,
      callback?: (element: HTMLSpanElement) => void,
    ): HTMLSpanElement;
    empty(): void;
    detach(): void;
    setText(text: string): void;
    addClass(...classes: string[]): void;
    removeClass(...classes: string[]): void;
    toggleClass(classes: string | string[], value: boolean): void;
    hasClass(value: string): boolean;
    setAttr(key: string, value: string | number | boolean | null): void;
    getAttr(key: string): string | null;
    setCssStyles(styles: Partial<CSSStyleDeclaration>): void;
    setCssProps(props: Record<string, string>): void;
    show(): void;
    hide(): void;
    isShown(): boolean;
    toggle(value: boolean): void;
    find(selector: string): Element | null;
    findAll(selector: string): Element[];
    onClickEvent(
      callback: (event: MouseEvent) => unknown,
      options?: boolean | AddEventListenerOptions,
    ): void;
    on(
      name: string,
      selector: string,
      callback: (this: HTMLElement, event: Event, delegateTarget: HTMLElement) => unknown,
      options?: boolean | AddEventListenerOptions,
    ): void;
    on(
      name: string,
      callback: EventListener,
      options?: boolean | AddEventListenerOptions,
    ): void;
    off(
      name: string,
      selector: string,
      callback: (this: HTMLElement, event: Event, delegateTarget: HTMLElement) => unknown,
      options?: boolean | AddEventListenerOptions,
    ): void;
    off(
      name: string,
      callback: EventListener,
      options?: boolean | AddEventListenerOptions,
    ): void;
  }
  interface Document {
    on(name: string, selector: string, callback: (this: Document, event: Event, delegateTarget: HTMLElement) => unknown, options?: boolean | AddEventListenerOptions): void;
    off(name: string, selector: string, callback: (this: Document, event: Event, delegateTarget: HTMLElement) => unknown, options?: boolean | AddEventListenerOptions): void;
  }
  interface DocumentFragment {
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      options?: DomElementInfo | string,
      callback?: (element: HTMLElementTagNameMap[K]) => void,
    ): HTMLElementTagNameMap[K];
    createDiv(
      options?: DomElementInfo | string,
      callback?: (element: HTMLDivElement) => void,
    ): HTMLDivElement;
    createSpan(
      options?: DomElementInfo | string,
      callback?: (element: HTMLSpanElement) => void,
    ): HTMLSpanElement;
  }
}

export interface EditorInfo {
  file: TFile | null;
  app: object;
}

/** Update the per-editor file information that plugins read from editor state. */
export const editorInfoEffect = StateEffect.define<EditorInfo | null>();
export const editorInfoField = StateField.define<EditorInfo | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(editorInfoEffect)) value = effect.value;
    return value;
  },
});

export const editorLivePreviewField = StateField.define<boolean>({
  create: (state) => state.facet(renderedFacet),
  update: (_value, transaction) => transaction.state.facet(renderedFacet),
});

export type { RequestUrlParam, RequestUrlResponse } from "./request";

export interface RequestUrlResponsePromise extends Promise<RequestUrlResponse> {
  arrayBuffer: Promise<ArrayBuffer>;
  json: Promise<unknown>;
  text: Promise<string>;
}

const customIcons = new Map<string, string>();

/** A plugin-registered SVG, or a built-in lucide icon, as a detached element. */
function iconElement(iconId: string): SVGSVGElement | null {
  const custom = customIcons.get(iconId);
  if (custom !== undefined) {
    const template = document.createElement("template");
    template.innerHTML = custom;
    const svg = template.content.firstElementChild;
    return svg instanceof SVGSVGElement ? svg : null;
  }
  // The full set is loaded before plugins run (`CompatibilitySession.create`).
  const node = findIcon(iconId.replace(/^lucide-/, ""));
  if (!node) return null;
  return createElement(node) as SVGSVGElement;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
}

export function normalizePath(path: string): string {
  if (typeof path !== "string") throw new TypeError("Path must be a string");
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

export function parseLinktext(linktext: string): {
  path: string;
  subpath: string;
} {
  const unwrapped = linktext.replace(/^!?\[\[|\]\]$/g, "");
  const hash = unwrapped.indexOf("#");
  if (hash < 0) return { path: unwrapped, subpath: "" };
  return {
    path: unwrapped.slice(0, hash),
    subpath: unwrapped.slice(hash),
  };
}

export function setTooltip(
  element: HTMLElement,
  tooltip: string,
  _options?: unknown,
): void {
  element.setAttribute("aria-label", tooltip);
  element.setAttribute("title", tooltip);
}

export function setIcon(element: HTMLElement, iconId: string): void {
  // Replace the previous icon only; plugins put labels next to it.
  for (const child of [...element.children])
    if (child.tagName.toLowerCase() === "svg") child.remove();
  const svg = iconElement(iconId);
  if (!svg) return;
  // Built-in icons are sized here; custom icons keep the size the plugin chose.
  if (!customIcons.has(iconId)) {
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("stroke-width", "1.7");
  }
  element.append(svg);
}

export function getIcon(iconId: string): SVGSVGElement | null {
  return iconElement(iconId);
}

export function addIcon(iconId: string, svgContent: string): void {
  customIcons.set(iconId, svgContent);
}

export function removeIcon(iconId: string): void {
  customIcons.delete(iconId);
}

export function getIconIds(): string[] {
  return [...new Set([...iconIds(), ...customIcons.keys()])];
}

export function sanitizeHTMLToDom(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
  }) as unknown as DocumentFragment;
}

export function requireApiVersion(version: string): boolean {
  const wanted = version.split(".").map(Number);
  if (wanted.some((part) => !Number.isInteger(part))) return false;
  const current = API_VERSION.split(".").map(Number);
  for (let index = 0; index < Math.max(wanted.length, current.length); index++)
    if ((current[index] ?? 0) !== (wanted[index] ?? 0))
      return (current[index] ?? 0) > (wanted[index] ?? 0);
  return true;
}

/** Documented example: `getLinkpath("foo#bar")` is `"foo"`. */
export function getLinkpath(linktext: string): string {
  return linktext.trim().split("|")[0].split("#")[0].trim();
}

const HEADING_PUNCTUATION = '!"#$%&()*+,.:;<=>?@^`{|}~/[]\\';
const LINK_HEADING_PUNCTUATION = "#:|^%[]\\";

function stripCharacters(text: string, characters: string): string {
  return [...text]
    .map((character) => (characters.includes(character) ? " " : character))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripHeading(heading: string): string {
  return stripCharacters(heading, HEADING_PUNCTUATION);
}

export function stripHeadingForLink(heading: string): string {
  return stripCharacters(heading, LINK_HEADING_PUNCTUATION);
}

export function getAllTags(
  cache: { tags?: { tag: string }[] } | null,
): string[] | null {
  const tags = [...new Set(cache?.tags?.map((entry) => entry.tag) ?? [])];
  return tags.length ? tags : null;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked to stay below the argument limit of String.fromCharCode.
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    .buffer;
}

export function arrayBufferToHex(data: ArrayBuffer): string {
  return [...new Uint8Array(data)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToArrayBuffer(hex: string): ArrayBuffer {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex))
    throw new Error(`Invalid hex string: ${hex}`);
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes.buffer;
}

export function getBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  // FileReader rather than blob.arrayBuffer(): both WebViews and jsdom have it.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

export function installDomCompat(): void {
  installSvgCompat();
  const marker = Symbol.for("basalt.domCompat");
  const prototype = HTMLElement.prototype as unknown as Record<
    symbol | string,
    unknown
  >;
  if (prototype[marker]) return;
  Object.defineProperty(prototype, marker, { value: true });

  const applyOptions = (
    element: HTMLElement,
    options?: DomElementInfo | string,
  ) => {
    if (!options) return;
    if (typeof options === "string") {
      element.className = options;
      return;
    }
    if (options.cls) {
      const classes = Array.isArray(options.cls) ? options.cls : [options.cls];
      element.classList.add(...classes.flatMap((value) => value.split(/\s+/)).filter(Boolean));
    }
    if (options.text !== undefined) element.textContent = options.text;
    if (options.title !== undefined) element.title = options.title;
    if (options.href !== undefined) element.setAttribute("href", options.href);
    if (options.value !== undefined)
      (element as HTMLInputElement).value = options.value;
    if (options.type !== undefined)
      (element as HTMLInputElement).type = options.type;
    if (options.placeholder !== undefined)
      (element as HTMLInputElement).placeholder = options.placeholder;
    for (const [key, value] of Object.entries(options.attr ?? {})) {
      if (value === null) element.removeAttribute(key);
      else element.setAttribute(key, String(value));
    }
    options.parent?.append(element);
  };

  prototype.createEl = function <K extends keyof HTMLElementTagNameMap>(
    this: HTMLElement,
    tag: K,
    options?: DomElementInfo | string,
    callback?: (element: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    applyOptions(element, options);
    this.append(element);
    callback?.(element);
    return element;
  };
  prototype.createDiv = function (
    this: HTMLElement,
    options?: DomElementInfo | string,
    callback?: (element: HTMLDivElement) => void,
  ) {
    return (this as HTMLElement).createEl("div", options, callback);
  };
  prototype.createSpan = function (
    this: HTMLElement,
    options?: DomElementInfo | string,
    callback?: (element: HTMLSpanElement) => void,
  ) {
    return (this as HTMLElement).createEl("span", options, callback);
  };
  prototype.empty = function (this: HTMLElement) {
    this.replaceChildren();
  };
  prototype.detach = function (this: HTMLElement) {
    this.remove();
  };
  prototype.setText = function (this: HTMLElement, text: string) {
    this.textContent = text;
  };
  prototype.addClass = function (this: HTMLElement, ...classes: string[]) {
    this.classList.add(...classes.flatMap((value) => value.split(/\s+/)).filter(Boolean));
  };
  prototype.removeClass = function (this: HTMLElement, ...classes: string[]) {
    for (const value of classes) this.classList.remove(...value.split(/\s+/).filter(Boolean));
  };
  prototype.toggleClass = function (
    this: HTMLElement,
    classes: string | string[],
    value: boolean,
  ) {
    for (const item of Array.isArray(classes) ? classes : [classes])
      this.classList.toggle(item, value);
  };
  prototype.hasClass = function (this: HTMLElement, value: string) {
    return this.classList.contains(value);
  };
  prototype.setAttr = function (
    this: HTMLElement,
    key: string,
    value: string | number | boolean | null,
  ) {
    if (value === null || value === false) this.removeAttribute(key);
    else this.setAttribute(key, String(value));
  };
  prototype.getAttr = function (this: HTMLElement, key: string) {
    return this.getAttribute(key);
  };
  prototype.setCssStyles = function (
    this: HTMLElement,
    styles: Partial<CSSStyleDeclaration>,
  ) {
    Object.assign(this.style, styles);
  };
  prototype.setCssProps = function (
    this: HTMLElement,
    props: Record<string, string>,
  ) {
    for (const [key, value] of Object.entries(props))
      this.style.setProperty(key, value);
  };
  prototype.show = function (this: HTMLElement) {
    this.hidden = false;
    this.style.display = "";
  };
  prototype.hide = function (this: HTMLElement) {
    this.hidden = true;
    this.style.display = "none";
  };
  prototype.isShown = function (this: HTMLElement) {
    return !this.hidden;
  };
  prototype.toggle = function (this: HTMLElement, value: boolean) {
    if (value) (this as HTMLElement).show();
    else (this as HTMLElement).hide();
  };
  prototype.find = function (this: HTMLElement, selector: string) {
    return this.querySelector(selector);
  };
  prototype.findAll = function (this: HTMLElement, selector: string) {
    return [...this.querySelectorAll(selector)];
  };
  prototype.onClickEvent = function (
    this: HTMLElement,
    callback: (event: MouseEvent) => unknown,
    options?: boolean | AddEventListenerOptions,
  ) {
    this.addEventListener("click", callback as EventListener, options);
  };
  installDomEvents();

  const fragment = DocumentFragment.prototype as unknown as Record<
    string,
    unknown
  >;
  fragment.createEl = function <K extends keyof HTMLElementTagNameMap>(
    this: DocumentFragment,
    tag: K,
    options?: DomElementInfo | string,
    callback?: (element: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    applyOptions(node, options);
    this.append(node);
    callback?.(node);
    return node;
  };
  fragment.createDiv = function (
    this: DocumentFragment,
    options?: DomElementInfo | string,
    callback?: (element: HTMLDivElement) => void,
  ) {
    return this.createEl("div", options, callback);
  };
  fragment.createSpan = function (
    this: DocumentFragment,
    options?: DomElementInfo | string,
    callback?: (element: HTMLSpanElement) => void,
  ) {
    return this.createEl("span", options, callback);
  };
  globalThis.createEl ??= (tag, options, callback) => {
    const node = document.createElement(tag);
    const parent = typeof options === "object" ? options.parent : undefined;
    applyOptions(
      node,
      typeof options === "object" ? { ...options, parent: undefined } : options,
    );
    callback?.(node);
    parent?.append(node);
    return node;
  };
  globalThis.createDiv ??= (options, callback) =>
    createEl("div", options, callback);
  globalThis.createSpan ??= (options, callback) =>
    createEl("span", options, callback);
}

export function createFragment(
  callback: (fragment: DocumentFragment) => unknown,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  callback(fragment);
  return fragment;
}

/** Documented DOM extensions Obsidian adds to native prototypes. */
function installDomHelpers(): void {
  const node = Node.prototype as unknown as Record<string, unknown>;
  const element = Element.prototype as unknown as Record<string, unknown>;
  const html = HTMLElement.prototype as unknown as Record<string, unknown>;
  const method = (target: Record<string, unknown>, name: string, value: unknown) => {
    if (!(name in target)) target[name] = value;
  };
  method(node, "detach", function (this: Node) { this.parentNode?.removeChild(this); });
  method(node, "empty", function (this: Node) {
    while (this.firstChild) this.removeChild(this.firstChild);
  });
  method(node, "insertAfter", function <T extends Node>(this: Node, child: T, after: Node | null): T {
    if (after) (after as ChildNode).after(child); else (this as ParentNode).prepend(child);
    return child;
  });
  method(node, "indexOf", function (this: Node, other: Node): number {
    return Array.prototype.indexOf.call(this.childNodes, other);
  });
  method(node, "setChildrenInPlace", function (this: Node, children: Node[]) {
    (this as ParentNode).replaceChildren(...children);
  });
  method(node, "appendText", function (this: Node, text: string) {
    this.appendChild(this.ownerDocument?.createTextNode(text) ?? document.createTextNode(text));
  });
  method(node, "instanceOf", function (this: Node, type: new (...args: never[]) => unknown) {
    return this instanceof type;
  });
  for (const [name, read] of [
    ["doc", function (this: Node) { return this.ownerDocument ?? document; }],
    ["win", function (this: Node) { return this.ownerDocument?.defaultView ?? window; }],
    ["constructorWin", function (this: Node) { return this.ownerDocument?.defaultView ?? window; }],
  ] as const) {
    if (!(name in node))
      Object.defineProperty(node, name, { configurable: true, get: read });
  }
  method(element, "getText", function (this: Element) { return this.textContent ?? ""; });
  method(element, "setText", function (this: Element, value: string | DocumentFragment) {
    if (typeof value === "string") this.textContent = value;
    else this.replaceChildren(value);
  });
  method(element, "addClass", function (this: Element, ...classes: string[]) { this.classList.add(...classes); });
  method(element, "addClasses", function (this: Element, classes: string[]) { this.classList.add(...classes); });
  method(element, "removeClass", function (this: Element, ...classes: string[]) { this.classList.remove(...classes); });
  method(element, "removeClasses", function (this: Element, classes: string[]) { this.classList.remove(...classes); });
  method(element, "toggleClass", function (this: Element, classes: string | string[], value?: boolean) {
    for (const cls of Array.isArray(classes) ? classes : [classes]) this.classList.toggle(cls, value);
  });
  method(element, "hasClass", function (this: Element, cls: string) { return this.classList.contains(cls); });
  method(element, "setAttr", function (this: Element, name: string, value: string | number | boolean | null) {
    if (value === null) this.removeAttribute(name); else this.setAttribute(name, String(value));
  });
  method(element, "setAttrs", function (this: Element, attrs: Record<string, string | number | boolean | null>) {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === null) this.removeAttribute(name); else this.setAttribute(name, String(value));
    }
  });
  method(element, "getAttr", function (this: Element, name: string) { return this.getAttribute(name); });
  method(element, "matchParent", function (this: Element, selector: string, lastParent?: Element): Element | null {
    let current: Element | null = this;
    while (current) {
      if (current.matches(selector)) return current;
      if (current === lastParent) return null;
      current = current.parentElement;
    }
    return null;
  });
  method(element, "getCssPropertyValue", function (this: Element, property: string, pseudo?: string) {
    return getComputedStyle(this, pseudo).getPropertyValue(property);
  });
  method(element, "isActiveElement", function (this: Element) { return this.ownerDocument.activeElement === this; });
  method(html, "hide", function (this: HTMLElement) {
    if (this.style.display !== "none") {
      this.dataset.basaltDisplay = this.style.display;
      this.style.display = "none";
    }
  });
  method(html, "show", function (this: HTMLElement) {
    this.style.display = this.dataset.basaltDisplay ?? "";
    delete this.dataset.basaltDisplay;
  });
  method(html, "toggle", function (this: HTMLElement, show: boolean) { show ? this.show() : this.hide(); });
  method(html, "toggleVisibility", function (this: HTMLElement, visible: boolean) { this.style.visibility = visible ? "" : "hidden"; });
  method(html, "isShown", function (this: HTMLElement) {
    return this.isConnected && !!(this.offsetWidth || this.offsetHeight || this.getClientRects().length);
  });
  method(html, "setCssStyles", function (this: HTMLElement, styles: Partial<CSSStyleDeclaration>) { Object.assign(this.style, styles); });
  method(html, "setCssProps", function (this: HTMLElement, props: Record<string, string>) {
    for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
  });
  for (const [name, size] of [["innerWidth", "Width"], ["innerHeight", "Height"]] as const) {
    if (!(name in html))
      Object.defineProperty(html, name, {
        configurable: true,
        get(this: HTMLElement) {
          const style = getComputedStyle(this);
          return (this as unknown as Record<string, number>)[`client${size}`] -
            parseFloat(style[`padding${size === "Width" ? "Left" : "Top"}`] || "0") -
            parseFloat(style[`padding${size === "Width" ? "Right" : "Bottom"}`] || "0");
        },
      });
  }
}

// Bundle the host's supported locales; date APIs never need ambient filesystem access.
obsidianMoment.locale(getLocale());

/** Obsidian extends built-ins exactly as documented in its global type patches. */
function installLanguageHelpers(): void {
  const add = (target: object, name: string, value: unknown): void => {
    if (name in target) return;
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      value,
    });
  };
  add(Array.prototype, "first", function (this: unknown[]) {
    return this[0];
  });
  add(Array.prototype, "last", function (this: unknown[]) {
    return this[this.length - 1];
  });
  add(Array.prototype, "contains", function (this: unknown[], value: unknown) {
    return this.includes(value);
  });
  add(Array.prototype, "remove", function (this: unknown[], value: unknown) {
    for (let index = this.length - 1; index >= 0; index--)
      if (this[index] === value) this.splice(index, 1);
  });
  add(Array.prototype, "shuffle", function (this: unknown[]) {
    for (let index = this.length - 1; index > 0; index--) {
      const other = Math.floor(Math.random() * (index + 1));
      [this[index], this[other]] = [this[other], this[index]];
    }
    return this;
  });
  add(Array.prototype, "unique", function (this: unknown[]) {
    return [...new Set(this)];
  });
  add(Array, "combine", (arrays: unknown[][]) => arrays.flat());
  add(Math, "clamp", (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value)),
  );
  add(Math, "square", (value: number) => value * value);
  add(String, "isString", (value: unknown) => typeof value === "string");
  add(String.prototype, "contains", function (this: string, value: string) {
    return this.includes(value);
  });
  add(String.prototype, "format", function (this: string, ...args: unknown[]) {
    return this.replace(/\{(\d+)\}/g, (match, index) =>
      index in args ? String(args[index]) : match,
    );
  });
  add(Number, "isNumber", (value: unknown) => typeof value === "number");
}

function installGlobals(): void {
  const scope = globalThis as typeof globalThis & {
    createFragment?: typeof createFragment;
    activeWindow?: Window;
    activeDocument?: Document;
    sleep?: (ms: number) => Promise<void>;
    moment?: typeof obsidianMoment;
  };
  installDomHelpers();
  installLanguageHelpers();
  scope.createFragment ??= createFragment;
  scope.activeWindow ??= window;
  scope.activeDocument ??= document;
  scope.sleep ??= (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  scope.moment ??= obsidianMoment;
}

function element(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Notice {
  readonly noticeEl: HTMLElement;
  readonly containerEl: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(message: string | DocumentFragment, duration = 5000) {
    const existing =
      document.body.querySelector<HTMLElement>(".notice-container");
    if (existing) this.containerEl = existing;
    else {
      this.containerEl = element("div", "notice-container");
      document.body.append(this.containerEl);
    }
    this.noticeEl = element("div", "notice");
    if (typeof message === "string") this.noticeEl.textContent = message;
    else this.noticeEl.append(message);
    this.containerEl.append(this.noticeEl);
    this.noticeEl.addEventListener("click", () => this.hide());
    this.timer = setTimeout(() => this.hide(), Math.max(1000, duration));
  }

  setMessage(message: string | DocumentFragment): this {
    if (typeof message === "string") this.noticeEl.textContent = message;
    else this.noticeEl.replaceChildren(message);
    return this;
  }

  hide(): this {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.noticeEl.remove();
    return this;
  }
}

export interface KeymapHandler {
  modifiers: string[] | null;
  key: string | null;
  func: (event: KeyboardEvent, context?: unknown) => unknown;
  scope: Scope;
}

export class Scope {
  constructor(private readonly parent?: Scope) {}
  private cleanups: Array<() => unknown> = [];
  keys: KeymapHandler[] = [];

  register(callback: () => unknown): void;
  register(
    modifiers: string[] | null,
    key: string | null,
    callback: (event: KeyboardEvent) => unknown,
  ): KeymapHandler;
  register(
    modifiersOrCallback: string[] | null | (() => unknown),
    key?: string | null,
    callback?: (event: KeyboardEvent) => unknown,
  ): KeymapHandler | void {
    if (typeof modifiersOrCallback === "function") {
      this.cleanups.push(modifiersOrCallback);
      return;
    }
    if (callback) {
      const handler: KeymapHandler = {
        modifiers: modifiersOrCallback,
        key: key?.toLowerCase() ?? null,
        func: callback,
        scope: this,
      };
      this.keys.push(handler);
      return handler;
    }
  }

  handle(event: KeyboardEvent): boolean {
    for (const binding of this.keys) {
      if (binding.key !== null && event.key.toLowerCase() !== binding.key) continue;
      if (binding.modifiers !== null) {
        const modifiers = new Set(binding.modifiers);
        if (modifiers.delete("Mod")) modifiers.add(/Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Ctrl");
        if (event.ctrlKey !== modifiers.has("Ctrl") || event.metaKey !== modifiers.has("Meta") ||
          event.shiftKey !== modifiers.has("Shift") || event.altKey !== modifiers.has("Alt")) continue;
      }
      return binding.func(event) !== true;
    }
    return this.parent?.handle(event) ?? false;
  }

  unregister(handler?: KeymapHandler): void {
    if (handler) { this.keys = this.keys.filter(value => value !== handler); return; }
    while (this.cleanups.length) this.cleanups.pop()!();
    this.keys = [];
  }
}

export class Modal {
  readonly containerEl: HTMLElement;
  readonly modalEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly contentEl: HTMLElement;
  readonly scope = new Scope();
  private isOpen = false;
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (this.scope.handle(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  constructor(readonly app: object) {
    this.containerEl = element("div", "modal-container basalt-plugin-modal");
    const background = element("div", "modal-bg");
    this.modalEl = element("div", "modal");
    const close = document.createElement("button");
    close.className = "modal-close-button";
    close.type = "button";
    close.setAttribute("aria-label", "Schließen");
    close.textContent = "×";
    close.addEventListener("click", () => this.close());
    this.titleEl = element("div", "modal-title");
    this.contentEl = element("div", "modal-content");
    this.modalEl.append(close, this.titleEl, this.contentEl);
    this.containerEl.append(background, this.modalEl);
    background.addEventListener("click", () => this.close());
  }

  setTitle(title: string): this {
    this.titleEl.textContent = title;
    return this;
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    document.body.append(this.containerEl);
    document.addEventListener("keydown", this.onKeyDown);
    this.onOpen();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    document.removeEventListener("keydown", this.onKeyDown);
    this.onClose();
    this.scope.unregister();
    this.containerEl.remove();
  }

  onOpen(): void {}
  onClose(): void {}
}

export class PluginSettingTab {
  static call(receiver: PluginSettingTab, app: object, plugin: Plugin): PluginSettingTab {
    return constructLegacy(this, receiver, [app, plugin]);
  }
  static apply(receiver: PluginSettingTab, args: ArrayLike<unknown>): PluginSettingTab {
    return constructLegacy(this, receiver, args);
  }

  readonly containerEl: HTMLElement;
  constructor(
    readonly app: object,
    readonly plugin: Plugin,
  ) {
    this.containerEl = element("div", "vertical-tab-content");
  }
  display(): void {}
  hide(): void {
    this.containerEl.replaceChildren();
  }
}

export class BaseComponent {
  disabled = false;
  then(callback: (component: this) => unknown): this {
    callback(this);
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
}

export abstract class ValueComponent<T> extends BaseComponent {
  abstract getValue(): T;
  abstract setValue(value: T): this;
  registerOptionListener(listeners: Record<string, (value?: T) => T>, key: string): this {
    listeners[key] = (value) => {
      if (value !== undefined) this.setValue(value);
      return this.getValue();
    };
    return this;
  }
}

class InputComponent<T> extends ValueComponent<T> {
  readonly inputEl: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  constructor(
    readonly settingEl: HTMLElement,
    tag: "input" | "textarea" | "select",
  ) {
    super();
    this.inputEl = document.createElement(tag) as
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  }
  protected value: T | undefined;
  setValue(value: T): this {
    this.value = value;
    return this;
  }
  getValue(): T {
    return this.value as T;
  }
  onChange(callback: (value: T) => unknown): this {
    this.inputEl.addEventListener("input", () => {
      this.read();
      callback(this.value as T);
    });
    return this;
  }
  override setDisabled(disabled: boolean): this {
    this.inputEl.disabled = disabled;
    return super.setDisabled(disabled);
  }
  protected read(): void {}
}

export class TextComponent extends InputComponent<string> {
  constructor(settingEl: HTMLElement) {
    super(settingEl, "input");
    (this.inputEl as HTMLInputElement).type = "text";
  }
  setPlaceholder(value: string): this {
    (this.inputEl as HTMLInputElement).placeholder = value;
    return this;
  }
  override setValue(value: string): this {
    this.inputEl.value = value;
    return super.setValue(value);
  }
  protected override read(): void {
    this.value = this.inputEl.value;
  }
}

export class SearchComponent extends TextComponent {
  readonly clearButtonEl: HTMLButtonElement;
  constructor(containerEl: HTMLElement) {
    const wrapper = element("div", "search-input-container");
    super(wrapper);
    (this.inputEl as HTMLInputElement).type = "search";
    this.clearButtonEl = document.createElement("button");
    this.clearButtonEl.type = "button";
    this.clearButtonEl.textContent = "×";
    this.clearButtonEl.setAttribute("aria-label", getLocale() === "de" ? "Suche leeren" : "Clear search");
    this.clearButtonEl.addEventListener("click", () => {
      this.setValue("");
      this.onChanged();
      this.inputEl.focus();
    });
    wrapper.append(this.inputEl, this.clearButtonEl);
    containerEl.append(wrapper);
  }
  override getValue(): string {
    return this.inputEl.value;
  }
  onChanged(): void {
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  }
  override setDisabled(disabled: boolean): this {
    this.clearButtonEl.disabled = disabled;
    return super.setDisabled(disabled);
  }
}

export class TextAreaComponent extends InputComponent<string> {
  constructor(settingEl: HTMLElement) {
    super(settingEl, "textarea");
  }
  setPlaceholder(value: string): this {
    (this.inputEl as HTMLTextAreaElement).placeholder = value;
    return this;
  }
  override setValue(value: string): this {
    this.inputEl.value = value;
    return super.setValue(value);
  }
  protected override read(): void {
    this.value = this.inputEl.value;
  }
}

export class ToggleComponent extends InputComponent<boolean> {
  constructor(settingEl: HTMLElement) {
    super(settingEl, "input");
    (this.inputEl as HTMLInputElement).type = "checkbox";
    this.inputEl.addEventListener("change", () =>
      this.inputEl.dispatchEvent(new Event("input")),
    );
  }
  override setValue(value: boolean): this {
    (this.inputEl as HTMLInputElement).checked = value;
    return super.setValue(value);
  }
  protected override read(): void {
    this.value = (this.inputEl as HTMLInputElement).checked;
  }
}

export class ButtonComponent extends BaseComponent {
  readonly buttonEl: HTMLButtonElement;
  constructor(settingEl: HTMLElement) {
    super();
    this.buttonEl = document.createElement("button");
    this.buttonEl.type = "button";
    this.buttonEl.className = "mod-cta";
    settingEl.append(this.buttonEl);
  }
  setButtonText(value: string): this {
    this.buttonEl.textContent = value;
    return this;
  }
  setCta(): this {
    this.buttonEl.classList.add("mod-cta");
    return this;
  }
  removeCta(): this {
    this.buttonEl.classList.remove("mod-cta");
    return this;
  }
  setTooltip(value: string, options: Record<string, unknown> = {}): this {
    setTooltip(this.buttonEl, value, options);
    return this;
  }
  setWarning(): this {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }
  setIcon(icon: string): this {
    setIcon(this.buttonEl, icon);
    return this;
  }
  override setDisabled(value: boolean): this {
    this.buttonEl.disabled = value;
    return super.setDisabled(value);
  }
  onClick(callback: (event: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener("click", callback);
    return this;
  }
}

export class ExtraButtonComponent extends BaseComponent {
  readonly extraSettingsEl: HTMLElement;
  constructor(settingEl: HTMLElement) {
    super();
    this.extraSettingsEl = element("button", "clickable-icon");
    (this.extraSettingsEl as HTMLButtonElement).type = "button";
    settingEl.append(this.extraSettingsEl);
  }
  setIcon(icon: string): this {
    setIcon(this.extraSettingsEl, icon);
    return this;
  }
  setTooltip(value: string): this {
    setTooltip(this.extraSettingsEl, value);
    return this;
  }
  override setDisabled(value: boolean): this {
    (this.extraSettingsEl as HTMLButtonElement).disabled = value;
    return super.setDisabled(value);
  }
  onClick(callback: (event: MouseEvent) => unknown): this {
    this.extraSettingsEl.addEventListener("click", callback);
    return this;
  }
}

export class DropdownComponent extends InputComponent<string> {
  constructor(settingEl: HTMLElement) {
    super(settingEl, "select");
  }
  addOption(value: string, display: string): this {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = display;
    this.inputEl.append(option);
    return this;
  }
  addOptions(options: Record<string, string>): this {
    for (const [value, display] of Object.entries(options))
      this.addOption(value, display);
    return this;
  }
  override setValue(value: string): this {
    this.inputEl.value = value;
    return super.setValue(value);
  }
  protected override read(): void {
    this.value = this.inputEl.value;
  }
}

export class SliderComponent extends InputComponent<number> {
  constructor(settingEl: HTMLElement) {
    super(settingEl, "input");
    (this.inputEl as HTMLInputElement).type = "range";
  }
  setLimits(min: number, max: number, step: number | "any"): this {
    const input = this.inputEl as HTMLInputElement;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    return this;
  }
  setDynamicTooltip(): this {
    return this;
  }
  override setValue(value: number): this {
    this.inputEl.value = String(value);
    return super.setValue(value);
  }
  protected override read(): void {
    this.value = Number(this.inputEl.value);
  }
}

export class ColorComponent extends InputComponent<string> {
  constructor(settingEl: HTMLElement) {
    super(settingEl, "input");
    (this.inputEl as HTMLInputElement).type = "color";
  }
  override setValue(value: string): this {
    this.inputEl.value = value;
    return super.setValue(value);
  }
  protected override read(): void {
    this.value = this.inputEl.value;
  }
}

export class Setting {
  readonly components: BaseComponent[] = [];
  private disabled = false;
  readonly settingEl: HTMLElement;
  readonly infoEl: HTMLElement;
  readonly nameEl: HTMLElement;
  readonly descEl: HTMLElement;
  readonly controlEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    this.settingEl = element("div", "setting-item");
    this.infoEl = element("div", "setting-item-info");
    this.nameEl = element("div", "setting-item-name");
    this.descEl = element("div", "setting-item-description");
    this.controlEl = element("div", "setting-item-control");
    this.infoEl.append(this.nameEl, this.descEl);
    this.settingEl.append(this.infoEl, this.controlEl);
    containerEl.append(this.settingEl);
  }
  setName(value: string): this {
    this.nameEl.textContent = value;
    return this;
  }
  setDesc(value: string): this {
    this.descEl.textContent = value;
    return this;
  }
  setHeading(): this {
    this.settingEl.classList.add("setting-item-heading");
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.settingEl.classList.toggle("is-disabled", disabled);
    for (const component of this.components) component.setDisabled(disabled);
    return this;
  }
  private addComponent<T extends BaseComponent>(component: T, callback: (component: T) => unknown): this {
    this.components.push(component);
    callback(component);
    if (this.disabled) component.setDisabled(true);
    return this;
  }
  /** Private host helper used by Excalidraw's export dialog. */
  setVisibility(visible: boolean): this {
    this.settingEl.hidden = !visible;
    return this;
  }
  setClass(value: string): this {
    this.settingEl.classList.add(...value.split(/\s+/));
    return this;
  }
  setTooltip(value: string): this {
    setTooltip(this.settingEl, value);
    return this;
  }
  addText(callback: (component: TextComponent) => unknown): this {
    const component = new TextComponent(this.controlEl);
    this.controlEl.append(component.inputEl);
    return this.addComponent(component, callback);
  }
  addTextArea(callback: (component: TextAreaComponent) => unknown): this {
    const component = new TextAreaComponent(this.controlEl);
    this.controlEl.append(component.inputEl);
    return this.addComponent(component, callback);
  }
  addToggle(callback: (component: ToggleComponent) => unknown): this {
    const component = new ToggleComponent(this.controlEl);
    this.controlEl.append(component.inputEl);
    return this.addComponent(component, callback);
  }
  addButton(callback: (component: ButtonComponent) => unknown): this {
    return this.addComponent(new ButtonComponent(this.controlEl), callback);
  }
  addExtraButton(callback: (component: ExtraButtonComponent) => unknown): this {
    return this.addComponent(new ExtraButtonComponent(this.controlEl), callback);
  }
  addDropdown(callback: (component: DropdownComponent) => unknown): this {
    const component = new DropdownComponent(this.controlEl);
    this.controlEl.append(component.inputEl);
    return this.addComponent(component, callback);
  }
  addSlider(callback: (component: SliderComponent) => unknown): this {
    const component = new SliderComponent(this.controlEl);
    this.controlEl.append(component.inputEl);
    return this.addComponent(component, callback);
  }
  addColorPicker(callback: (component: ColorComponent) => unknown): this {
    const component = new ColorComponent(this.controlEl);
    this.controlEl.append(component.inputEl);
    return this.addComponent(component, callback);
  }
}

export class SettingGroup {
  readonly listEl = element("div", "setting-group");
  private readonly headingEl = element("h3", "setting-group-heading");
  private readonly actionsEl = element("div", "setting-group-actions");
  constructor(containerEl: HTMLElement) {
    this.headingEl.hidden = true;
    containerEl.append(this.headingEl, this.actionsEl, this.listEl);
  }
  setHeading(text: string | DocumentFragment): this {
    this.headingEl.replaceChildren(text);
    this.headingEl.hidden = false;
    return this;
  }
  addClass(...classes: string[]): this {
    this.listEl.classList.add(...classes);
    return this;
  }
  addSetting(callback: (setting: Setting) => void): this {
    callback(new Setting(this.listEl));
    return this;
  }
  addSearch(callback: (component: SearchComponent) => unknown): this {
    const container = element("div", "setting-group-search");
    this.listEl.prepend(container);
    callback(new SearchComponent(container));
    return this;
  }
  addExtraButton(callback: (component: ExtraButtonComponent) => unknown): this {
    callback(new ExtraButtonComponent(this.actionsEl));
    return this;
  }
}

export abstract class PopoverSuggest<T> {
  readonly scope: Scope;
  protected readonly suggestEl = element("div", "suggestion-container basalt-input-suggest");
  constructor(readonly app: object, scope?: Scope) {
    this.scope = scope ?? new Scope();
    this.suggestEl.setAttribute("role", "listbox");
  }
  open(): void {
    if (!this.suggestEl.isConnected) document.body.append(this.suggestEl);
  }
  close(): void { this.suggestEl.remove(); }
  onHistoryBack(): void { this.close(); }
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract selectSuggestion(value: T, event: MouseEvent | KeyboardEvent): void;
}

export interface EditorSuggestTriggerInfo {
  start: EditorPosition;
  end: EditorPosition;
  query: string;
}

export interface EditorSuggestContext extends EditorSuggestTriggerInfo {
  editor: Editor;
  file: TFile;
}

// Base class for plugin suggestions; the host bridges instances into CodeMirror completions.
export abstract class EditorSuggest<T> extends PopoverSuggest<T> {
  context: EditorSuggestContext | null = null;
  limit = 100;
  constructor(app: object, scope?: Scope) {
    super(app, scope);
    // Obsidian's editor-suggest scope exposes an Escape handler plugins may replace.
    this.scope.register([], "Escape", () => false);
  }
  setInstructions(instructions: Array<{ command: string; purpose: string }>): void {
    this.suggestEl.querySelector(".suggestion-instructions")?.remove();
    const footer = element("div", "suggestion-instructions");
    for (const item of instructions) {
      const instruction = element("div", "suggestion-instruction");
      instruction.textContent = `${item.command} ${item.purpose}`;
      footer.append(instruction);
    }
    this.suggestEl.append(footer);
  }
  override close(): void { this.context = null; super.close(); }
  abstract onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null;
  abstract getSuggestions(context: EditorSuggestContext): T[] | Promise<T[]>;
}

export abstract class AbstractInputSuggest<T> extends PopoverSuggest<T> {
  limit = 100;
  private generation = 0;
  private suggestions: T[] = [];
  private selected = 0;
  private select?: (value: T, event: MouseEvent | KeyboardEvent) => unknown;

  constructor(app: object, private readonly textInputEl: HTMLInputElement | HTMLDivElement) {
    super(app);
    textInputEl.addEventListener("input", () => void this.refresh());
    textInputEl.addEventListener("focus", () => void this.refresh());
    textInputEl.addEventListener("blur", () => this.close());
    textInputEl.addEventListener("keydown", (event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (!this.suggestEl.isConnected) return;
      if (this.scope.handle(event)) { event.preventDefault(); return; }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.selected = (this.selected + (event.key === "ArrowDown" ? 1 : -1) + this.suggestions.length) % this.suggestions.length;
        this.markSelected();
      } else if (event.key === "Enter" && this.suggestions.length) {
        event.preventDefault();
        this.selectSuggestion(this.suggestions[this.selected], event);
      }
    });
  }
  setValue(value: string): void {
    if (this.textInputEl instanceof HTMLInputElement) this.textInputEl.value = value;
    else this.textInputEl.textContent = value;
  }
  getValue(): string {
    return this.textInputEl instanceof HTMLInputElement ? this.textInputEl.value : this.textInputEl.textContent ?? "";
  }
  protected abstract getSuggestions(query: string): T[] | Promise<T[]>;
  onSelect(callback: (value: T, event: MouseEvent | KeyboardEvent) => unknown): this {
    this.select = callback;
    return this;
  }
  selectSuggestion(value: T, event: MouseEvent | KeyboardEvent): void {
    this.select?.(value, event);
    this.close();
  }
  override close(): void {
    this.generation++;
    super.close();
  }
  override open(): void {
    const box = this.textInputEl.getBoundingClientRect();
    Object.assign(this.suggestEl.style, {
      position: "fixed", left: `${box.left}px`, top: `${box.bottom}px`, minWidth: `${box.width}px`,
    });
    super.open();
  }
  private markSelected(): void {
    [...this.suggestEl.children].forEach((el, i) => {
      el.classList.toggle("is-selected", i === this.selected);
      el.setAttribute("aria-selected", String(i === this.selected));
    });
  }
  private async refresh(): Promise<void> {
    const generation = ++this.generation;
    try {
      const values = await this.getSuggestions(this.getValue());
      if (generation !== this.generation || !this.textInputEl.isConnected) return;
      this.suggestions = this.limit > 0 ? values.slice(0, this.limit) : values;
      this.selected = 0;
      this.suggestEl.replaceChildren();
      if (!this.suggestions.length) { this.close(); return; }
      for (const value of this.suggestions) {
        const item = element("div", "suggestion-item");
        item.setAttribute("role", "option");
        this.renderSuggestion(value, item);
        item.addEventListener("mousedown", (event) => event.preventDefault());
        item.addEventListener("click", (event) => this.selectSuggestion(value, event));
        this.suggestEl.append(item);
      }
      this.markSelected();
      this.open();
    } catch (error) {
      if (generation !== this.generation) return;
      this.close();
      console.error("Plugin input suggestions failed", error);
    }
  }
}

export abstract class SuggestModal<T> extends Modal {
  readonly inputEl: HTMLInputElement;
  readonly resultContainerEl: HTMLElement;
  private suggestions: T[] = [];
  private readonly instructionsEl = element("div", "prompt-instructions");

  constructor(app: object) {
    super(app);
    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    this.inputEl.className = "prompt-input";
    this.resultContainerEl = element("div", "prompt-results");
    this.contentEl.append(this.inputEl, this.resultContainerEl, this.instructionsEl);
  }

  setInstructions(instructions: Array<{ command: string; purpose: string }>): void {
    this.instructionsEl.replaceChildren();
    for (const instruction of instructions) {
      const item = element("div", "prompt-instruction");
      item.append(element("span", "prompt-instruction-command", instruction.command), element("span", undefined, instruction.purpose));
      this.instructionsEl.append(item);
    }
  }

  setPlaceholder(value: string): void {
    this.inputEl.placeholder = value;
  }

  abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract onChooseSuggestion(
    value: T,
    evt: MouseEvent | KeyboardEvent,
  ): unknown;

  override onOpen(): void {
    this.inputEl.value = "";
    this.inputEl.focus();
    this.inputEl.addEventListener("input", () => void this.refresh());
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && this.suggestions.length)
        this.selectSuggestion(this.suggestions[0], event);
    });
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const suggestions = await this.getSuggestions(this.inputEl.value);
    this.suggestions = suggestions;
    this.resultContainerEl.replaceChildren();
    for (const suggestion of suggestions) {
      const item = element("div", "suggestion-item");
      this.renderSuggestion(suggestion, item);
      const choose = (event: MouseEvent) => {
        this.selectSuggestion(suggestion, event);
      };
      item.addEventListener("click", choose);
      this.resultContainerEl.append(item);
    }
    this.resultContainerEl
      .querySelector(".suggestion-item")
      ?.classList.add("is-selected");
  }

  selectSuggestion(value: T, event: MouseEvent | KeyboardEvent): void {
    this.onChooseSuggestion(value, event);
    this.close();
  }
}

export interface FuzzyMatch<T> {
  item: T;
  match: { score: number; matches: [number, number][] };
}

function fuzzyMatch(
  query: string,
  text: string,
): FuzzyMatch<unknown>["match"] | null {
  const matches: [number, number][] = [];
  if (!query) return { score: 0, matches };
  const target = text.toLowerCase();
  const needle = query.toLowerCase();
  let index = 0;
  let score = 0;
  let streak = 0;
  for (let offset = 0; offset < target.length; offset++) {
    if (target[offset] === needle[index]) {
      index++;
      streak++;
      score += streak;
      const last = matches.at(-1);
      if (last?.[1] === offset) last[1]++;
      else matches.push([offset, offset + 1]);
      if (index === needle.length) return { score, matches };
    } else {
      streak = 0;
    }
  }
  return null;
}

export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  onChooseItem(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
  override onChooseSuggestion(
    item: FuzzyMatch<T>,
    evt: MouseEvent | KeyboardEvent,
  ): void {
    this.onChooseItem(item.item, evt);
  }
  getSuggestions(query: string): FuzzyMatch<T>[] {
    return this.getItems()
      .map((item) => ({
        item,
        match: fuzzyMatch(query, this.getItemText(item)),
      }))
      .filter((entry): entry is FuzzyMatch<T> => entry.match !== null)
      .sort((first, second) => second.match.score - first.match.score);
  }
  renderSuggestion(item: FuzzyMatch<T>, el: HTMLElement): void {
    el.textContent = this.getItemText(item.item);
  }
}

export class MenuItem {
  constructor(
    private readonly itemEl: HTMLButtonElement,
    private readonly iconEl: HTMLElement,
    private readonly titleEl: HTMLElement,
    private readonly checkEl: HTMLElement,
    private readonly hide: () => void,
  ) {}

  setTitle(value: string): this {
    this.titleEl.textContent = value;
    return this;
  }

  setIcon(value: string): this {
    setIcon(this.iconEl, value);
    return this;
  }

  setChecked(value: boolean | null): this {
    this.itemEl.dataset.checked = value === null ? "" : String(value);
    if (value === true) setIcon(this.checkEl, "check");
    else this.checkEl.replaceChildren();
    return this;
  }

  setDisabled(value: boolean): this {
    this.itemEl.disabled = value;
    return this;
  }

  setSection(value: string): this {
    this.itemEl.dataset.section = value;
    return this;
  }

  setIsLabel(value: boolean): this {
    this.itemEl.dataset.label = String(value);
    return this;
  }

  onClick(callback: (event: MouseEvent) => unknown): this {
    this.itemEl.addEventListener("click", (event) => {
      this.hide();
      callback(event);
    });
    return this;
  }
}

export class Menu {
  readonly menuEl: HTMLElement;
  private hideCallbacks: Array<() => unknown> = [];
  private readonly dismiss: (event: MouseEvent) => void;
  private hostClose?: () => void;

  constructor() {
    this.menuEl = element("div", "menu basalt-plugin-menu");
    this.menuEl.hidden = true;
    this.dismiss = (event) => {
      if (!this.menuEl.contains(event.target as Node)) this.hide();
    };
    document.addEventListener("mousedown", this.dismiss);
    document.body.append(this.menuEl);
  }

  addItem(callback: (item: MenuItem) => unknown): this {
    const itemEl = element("button", "menu-item") as HTMLButtonElement;
    itemEl.type = "button";
    const iconEl = element("div", "menu-item-icon");
    const titleEl = element("span", "menu-item-title");
    const checkEl = element("div", "menu-item-check");
    itemEl.append(iconEl, titleEl, checkEl);
    const item = new MenuItem(itemEl, iconEl, titleEl, checkEl, () =>
      this.hide(),
    );
    this.menuEl.append(itemEl);
    callback(item);
    return this;
  }

  addSeparator(): this {
    this.menuEl.append(element("div", "menu-separator"));
    return this;
  }

  showAtMouseEvent(event: MouseEvent): this {
    return this.showAtPosition({ x: event.clientX, y: event.clientY });
  }

  showAtPosition(position: { x: number; y: number }): this {
    this.menuEl.hidden = false;
    this.menuEl.style.left = `${position.x}px`;
    this.menuEl.style.top = `${position.y}px`;
    return this;
  }

  /** Host bridge: keep plugin items and lifecycle in the shell's accessible menu. */
  showWithHostEntries(
    entries: MenuEntry[],
    at: { x: number; y: number } | HTMLElement,
  ): this {
    document.removeEventListener("mousedown", this.dismiss);
    this.hostClose = showMenu(entries, at, {
      menuEl: this.menuEl,
      onClose: () => this.hide(),
    });
    return this;
  }

  hide(): this {
    const visible = !this.menuEl.hidden;
    this.menuEl.hidden = true;
    this.hostClose?.();
    document.removeEventListener("mousedown", this.dismiss);
    this.menuEl.remove();
    if (visible) for (const callback of this.hideCallbacks) callback();
    return this;
  }

  onHide(callback: () => unknown): this {
    this.hideCallbacks.push(callback);
    return this;
  }
}

export class View extends Component {
  readonly containerEl: HTMLElement;
  readonly contentEl: HTMLElement;
  readonly navigation = false;
  icon = "file";
  constructor(
    readonly leaf: { app?: object; view?: unknown } | null,
    app?: object,
  ) {
    super();
    this.app = app ?? leaf?.app ?? null;
    this.containerEl = element("div", "view-content basalt-plugin-view");
    this.contentEl = element("div", "view-content-inner");
    this.containerEl.append(this.contentEl);
  }
  readonly app: object | null;
  getViewType(): string {
    return "empty";
  }
  getDisplayText(): string {
    return "View";
  }
  getIcon(): string {
    return this.icon;
  }
  getState(): Record<string, unknown> {
    return {};
  }
  setState(_state: unknown, _result?: unknown): Promise<void> {
    return Promise.resolve();
  }
  onOpen(): Promise<void> | void {}
  onClose(): Promise<void> | void {}
}

export class ItemView extends View {
  readonly actionsEl: HTMLElement;
  constructor(leaf: { app?: object; view?: unknown } | null) {
    super(leaf);
    this.actionsEl = element("div", "view-actions");
    this.containerEl.prepend(this.actionsEl);
  }
  addAction(icon: string, title: string, callback: (event: MouseEvent) => unknown): HTMLElement {
    const button = element("button", "clickable-icon");
    button.title = title;
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", title);
    setIcon(button, icon);
    this.registerDomEvent(button, "click", callback);
    this.actionsEl.append(button);
    return button;
  }
}

export class FileView extends ItemView {
  file: TFile | null = null;
  allowNoFile = false;
  async onLoadFile(_file: TFile): Promise<void> {}
  async onUnloadFile(_file: TFile): Promise<void> {}
  async loadFile(file: TFile): Promise<void> {
    this.file = file;
    await this.onLoadFile(file);
  }
  clear(): void {
    const file = this.file;
    this.file = null;
    this.contentEl.replaceChildren();
    if (file) void this.onUnloadFile(file);
  }
}

/** The slice of the vault a text view needs; keeps this module free of the storage layer. */
interface TextViewVault {
  read(file: TFile): Promise<string>;
  modify(file: TFile, data: string): Promise<TFile>;
}

export class TextFileView extends FileView {
  data = "";
  /** Last content read from or written to disk; `getViewData()` is the live buffer. */
  private saved = "";
  private readonly saveQueued = debounce(() => this.save(), 2000, true);

  private get textVault(): TextViewVault | null {
    const vault = (this.app as { vault?: TextViewVault } | null)?.vault;
    return vault && typeof vault.read === "function" ? vault : null;
  }

  getViewData(): string {
    return this.data;
  }
  setViewData(data: string, _clear: boolean): void {
    this.data = data;
  }
  override async loadFile(file: TFile): Promise<void> {
    this.file = file;
    const vault = this.textVault;
    if (vault) {
      const text = await vault.read(file);
      this.saved = text;
      this.data = text;
      this.setViewData(text, true);
    }
    await this.onLoadFile(file);
  }
  requestSave(): void {
    void this.saveQueued();
  }
  async save(clear = false): Promise<void> {
    this.saveQueued.cancel();
    const file = this.file;
    const vault = this.textVault;
    if (file && vault) {
      const data = this.getViewData();
      if (data !== this.saved) {
        await vault.modify(file, data);
        this.saved = data;
        this.data = data;
      }
    }
    if (clear) this.clear();
  }
  /** Pending edits are written before the view goes away, not dropped with the debouncer. */
  override async onunload(): Promise<void> {
    this.saveQueued.cancel();
    await this.save();
  }
  override clear(): void {
    this.saveQueued.cancel();
    this.data = "";
    this.saved = "";
    super.clear();
  }
}

export class MarkdownRenderChild extends Component {
  constructor(readonly containerEl: HTMLElement) {
    super();
  }
}

export class FileSystemAdapter {
  constructor(private readonly basePath = "") {}
  getBasePath(): string {
    return this.basePath;
  }
}

export interface ObsidianApiOptions {
  app: object;
  basePath?: string | null;
  renderMarkdown?: (markdown: string) => string;
  requestUrl?: RequestUrl;
}

export function createObsidianApi(
  options: ObsidianApiOptions,
): Record<string, unknown> {
  installDomCompat();
  installGlobals();
  const transport = options.requestUrl ?? fetchRequestUrl;
  const requestUrl = (
    input: RequestUrlParam | string,
  ): RequestUrlResponsePromise => {
    const request = typeof input === "string" ? { url: input } : input;
    const promise = transport(request).then((response) => {
      if (request.throw !== false && response.status >= 400)
        throw new Error(`Request failed with status ${response.status}`);
      return response;
    });
    // Lazy shortcuts avoid unhandled rejections for body promises nobody reads.
    return Object.defineProperties(promise, {
      arrayBuffer: {
        get: () => promise.then((response) => response.arrayBuffer),
      },
      json: { get: () => promise.then((response) => response.json) },
      text: { get: () => promise.then((response) => response.text) },
    }) as RequestUrlResponsePromise;
  };

  const renderMarkdown = (markdown: string): string =>
    options.renderMarkdown?.(markdown) ?? escapeHtml(markdown);

  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const tauri = "__TAURI_INTERNALS__" in window;
  const Platform = Object.freeze({
    isDesktop: !mobile,
    isMobile: mobile,
    isDesktopApp: tauri && !mobile,
    isMobileApp: tauri && mobile,
    isAndroidApp: tauri && /Android/i.test(navigator.userAgent),
    isIosApp: tauri && /iPhone|iPad|iPod/i.test(navigator.userAgent),
    isLinux: !mobile && /Linux/i.test(navigator.userAgent),
    isMacOS: /Mac OS X/i.test(navigator.userAgent),
    isWin: /Windows/i.test(navigator.userAgent),
  });

  return {
    Plugin,
    Component,
    Events,
    TAbstractFile,
    TFile,
    TFolder,
    MarkdownView,
    Workspace,
    WorkspaceSplit,
    WorkspaceSidedock,
    WorkspaceLeaf,
    Scope,
    Editor,
    Notice,
    Modal,
    PluginSettingTab,
    SettingPage,
    Setting,
    SettingGroup,
    BaseComponent,
    ValueComponent,
    TextComponent,
    SearchComponent,
    TextAreaComponent,
    ToggleComponent,
    ButtonComponent,
    ExtraButtonComponent,
    DropdownComponent,
    SliderComponent,
    ColorComponent,
    SuggestModal,
    FuzzySuggestModal,
    PopoverSuggest,
    EditorSuggest,
    AbstractInputSuggest,
    Menu,
    MenuItem,
    View,
    ItemView,
    FileView,
    TextFileView,
    MarkdownRenderChild,
    FileSystemAdapter,
    Platform,
    apiVersion: API_VERSION,
    // Expose the same language as the host UI.
    getLanguage: getLocale,
    moment: obsidianMoment,
    debounce,
    normalizePath,
    parseLinktext,
    createFragment,
    setTooltip,
    setIcon,
    getIcon,
    addIcon,
    removeIcon,
    getIconIds,
    sanitizeHTMLToDom,
    requireApiVersion,
    getLinkpath,
    stripHeading,
    stripHeadingForLink,
    getAllTags,
    arrayBufferToBase64,
    base64ToArrayBuffer,
    arrayBufferToHex,
    hexToArrayBuffer,
    getBlobArrayBuffer,
    requestUrl,
    request: (input: RequestUrlParam | string): Promise<string> => requestUrl(input).text,
    parseYaml,
    stringifyYaml,
    getFrontMatterInfo,
    parseFrontMatterEntry,
    parseFrontMatterStringArray,
    parseFrontMatterTags,
    parseFrontMatterAliases,
    loadPdfJs: async () => {
      throw new Error("PDF.js is not bundled in Basalt yet");
    },
    editorInfoField,
    editorLivePreviewField,
    MarkdownRenderer: {
      render: async (
        _app: object,
        markdown: string,
        el: HTMLElement,
        _sourcePath: string,
        _component: Component,
      ) => {
        el.innerHTML = renderMarkdown(markdown);
      },
      renderMarkdown: async (
        markdown: string,
        el: HTMLElement,
        _sourcePath: string,
        _component: Component,
      ) => {
        el.innerHTML = renderMarkdown(markdown);
      },
    },
    app: options.app,
  };
}
