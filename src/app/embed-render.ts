import { t } from "../i18n";
import { LanguageDescription } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import type { CompatibilitySession } from "../compat/session";
import { TFile } from "../compat/files";
import { renderMarkdown } from "../markdown";
import { IMAGE_TYPES, MAX_ATTACHMENT_BYTES, MEDIA_TYPES } from "../attachments";
import { codeLanguages, markdownHighlight } from "../editor/syntax";
import { extractSubpath, parseImageSize, splitTarget } from "../subpath";
import { basename, extension, h, icon } from "../ui/dom";
import { calloutIcon } from "../ui/callouts";
import { cachedImageUrl, ImageCacheCleared } from "./image-cache";
import { PdfView } from "./pdf";

/** The part of the app that rendered Markdown needs. */
export interface RenderHost {
  readonly index: {
    resolve(target: string, source: string): string | null;
    content(path: string): string | undefined;
  };
  readonly compatibility: CompatibilitySession | null;
  /**
   * Browser demo only: the text of an SVG image, because the demo vault
   * keeps text files only and has no binary storage.
   */
  demoImage?(path: string): Promise<string | null>;
}

/** Nested note embeds stop at this depth. */
const MAX_DEPTH = 3;

/**
 * Turns freshly rendered Markdown HTML into the finished view: link states,
 * callout icons, code highlighting, images, media and note embeds. One scope
 * owns the object URLs and PDF views it created; `dispose` releases them and
 * makes pending loads drop their results.
 */
export class RenderScope {
  private live = true;
  private objectUrls: string[] = [];
  private pdfs: PdfView[] = [];

  constructor(
    private readonly host: RenderHost,
    /** Called when content changed size after it was attached (images, PDFs). */
    private readonly onResize: () => void = () => {},
  ) {}

  get alive(): boolean {
    return this.live;
  }

  dispose(): void {
    this.live = false;
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
    for (const pdf of this.pdfs) pdf.dispose();
    this.pdfs = [];
  }

  /** Link states, callout icons, copy buttons and embeds for rendered HTML. */
  decorate(
    root: HTMLElement,
    path: string,
    depth = 0,
    chain: ReadonlySet<string> = new Set([path]),
  ): void {
    const index = this.host.index;
    for (const link of root.querySelectorAll<HTMLAnchorElement>(
      "a.internal-link",
    )) {
      const target = link.dataset.note ?? "";
      const resolved = index.resolve(target, path);
      if (link.classList.contains("is-embed")) {
        this.embed(link, target, resolved, path, depth, chain);
        continue;
      }
      if (!resolved) link.classList.add("is-unresolved");
      link.setAttribute("data-source", path);
    }
    for (const holder of root.querySelectorAll<HTMLElement>(".callout-icon")) {
      const type =
        holder.closest<HTMLElement>(".callout")?.dataset.callout ?? "";
      holder.replaceChildren(icon(calloutIcon(type), 16));
    }
    for (const pre of root.querySelectorAll("pre")) {
      if (pre.querySelector(":scope > .copy-code-button")) continue;
      const code = pre.querySelector("code");
      const language = [...(code?.classList ?? [])]
        .find((name) => name.startsWith("language-"))
        ?.slice(9);
      if (code && language) void this.highlight(code, language);
      const button = h(
        "button",
        {
          class: "copy-code-button",
          label: t("Code kopieren"),
          attrs: { type: "button" },
        },
        icon("copy", 14),
      );
      pre.append(button);
    }
    for (const table of root.querySelectorAll("table")) {
      if (table.parentElement?.classList.contains("table-wrapper")) continue;
      const wrapper = h("div", "table-wrapper");
      table.replaceWith(wrapper);
      wrapper.append(table);
    }
    for (const image of root.querySelectorAll<HTMLImageElement>("img[src]")) {
      const source = image.getAttribute("src") ?? "";
      if (/^(data:|blob:|[a-z][a-z0-9+.-]*:)/i.test(source)) continue;
      image.removeAttribute("src");
      let decoded = source;
      try {
        decoded = decodeURIComponent(source);
      } catch {
        // Keep the literal path.
      }
      // `![Alt|300](image.png)` sizes Markdown images like wiki embeds.
      const size = parseImageSize(image.getAttribute("alt") ?? "");
      if (size.width) {
        image.alt = size.alt;
        applySize(image, size);
      }
      const resolved = index.resolve(decoded, path) ?? decoded;
      void this.loadImage(image, resolved);
    }
  }

  /** Colours a code block with the same parsers and classes as the editor. */
  private async highlight(code: HTMLElement, language: string): Promise<void> {
    const description = LanguageDescription.matchLanguageName(
      codeLanguages,
      language,
      false,
    );
    if (!description) return;
    const text = code.textContent ?? "";
    if (text.length > 60000) return;
    try {
      const support = await description.load();
      // A plugin code-block processor may have replaced the block meanwhile.
      if (!this.live || !code.isConnected) return;
      const tree = support.language.parser.parse(text);
      const fragment = document.createDocumentFragment();
      let position = 0;
      highlightTree(tree, markdownHighlight, (from, to, classes) => {
        if (from > position) fragment.append(text.slice(position, from));
        fragment.append(
          h("span", { class: classes, text: text.slice(from, to) }),
        );
        position = to;
      });
      fragment.append(text.slice(position));
      code.replaceChildren(fragment);
    } catch (error) {
      console.warn(t("Code konnte nicht hervorgehoben werden"), error);
    }
  }

  private embed(
    link: HTMLAnchorElement,
    target: string,
    resolved: string | null,
    source: string,
    depth: number,
    chain: ReadonlySet<string>,
  ): void {
    const { name, subpath } = splitTarget(target);
    const type = extension(name);
    // The renderer writes `↗ label`; the label is the alias, if any.
    const label = (link.textContent ?? "").replace(/^↗ /, "");
    const alias = label.trim() === target ? "" : label;
    if (IMAGE_TYPES[type]) {
      const size = parseImageSize(alias);
      const image = h("img", {
        attrs: { alt: size.alt || name, loading: "lazy" },
      });
      applySize(image, size);
      const holder = h("span", "internal-embed image-embed", image);
      link.replaceWith(holder);
      void this.loadImage(image, resolved ?? name);
      return;
    }
    const media = MEDIA_TYPES[type];
    if (media) {
      if (!resolved) {
        link.classList.add("is-unresolved-embed", "is-unresolved");
        link.setAttribute("data-source", source);
        return;
      }
      const element =
        media.kind === "pdf"
          ? h("div", { class: "pdf-frame", attrs: { "aria-label": name } })
          : h(media.kind, { attrs: { controls: "", preload: "metadata" } });
      const holder = h(
        "div",
        `internal-embed media-embed ${media.kind}-embed`,
        element,
      );
      const height = /(?:^|[#&|])height=(\d+)/.exec(subpath);
      if (height) holder.style.height = `${height[1]}px`;
      const paragraph = link.parentElement;
      if (paragraph?.tagName === "P" && paragraph.childNodes.length === 1)
        paragraph.replaceWith(holder);
      else link.replaceWith(holder);
      void this.loadMedia(element, resolved, media.mime, target);
      return;
    }
    const text = resolved ? this.host.index.content(resolved) : undefined;
    // A section may embed another section of the same note, never itself.
    const key = subpath ? `${resolved}#${subpath}` : (resolved ?? "");
    if (
      !resolved ||
      text === undefined ||
      depth >= MAX_DEPTH ||
      chain.has(key)
    ) {
      link.classList.add("is-unresolved-embed");
      if (!resolved) link.classList.add("is-unresolved");
      link.setAttribute("data-source", source);
      return;
    }
    const part = subpath ? extractSubpath(text, subpath) : text;
    const content = h("div", "markdown-embed-content");
    if (part === null)
      content.append(
        h("p", {
          class: "markdown-embed-missing",
          text: subpath.startsWith("^")
            ? t("Block „{name}“ nicht gefunden.", { name: subpath.slice(1) })
            : t("Abschnitt „{name}“ nicht gefunden.", { name: subpath }),
        }),
      );
    else content.innerHTML = renderMarkdown(part);
    const open = h(
      "a",
      {
        class: "markdown-embed-link internal-link",
        label: t("Notiz öffnen"),
        attrs: { href: "#" },
        data: { note: subpath ? `${resolved}#${subpath}` : resolved, source },
      },
      icon("link", 14),
    );
    const container = h(
      "div",
      {
        class: `internal-embed markdown-embed${subpath ? " is-section" : ""}`,
        // Post processors resolve drawing transclusions through Obsidian's src attribute.
        attrs: { src: resolved + (subpath ? `#${subpath}` : "") },
      },
      h("div", { class: "markdown-embed-title", text: basename(resolved) }),
      content,
      open,
    );
    // An embed inside a paragraph must not stay inline.
    const paragraph = link.parentElement;
    if (paragraph?.tagName === "P" && paragraph.childNodes.length === 1)
      paragraph.replaceWith(container);
    else link.replaceWith(container);
    // Whole notes recurse by path, sections by path and subpath.
    const next = new Set(chain);
    next.add(key);
    this.decorate(content, resolved, depth + 1, next);
  }

  /** Vault images are only readable through the native binary bridge. */
  private async loadImage(
    image: HTMLImageElement,
    path: string,
  ): Promise<void> {
    image.addEventListener("load", () => this.onResize(), { once: true });
    const session = this.host.compatibility;
    const mime = IMAGE_TYPES[extension(path)];
    if (!session && mime === "image/svg+xml" && this.host.demoImage) {
      const svg = await this.host.demoImage(path).catch(() => null);
      if (!this.live) return;
      if (svg !== null) {
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        return;
      }
    }
    const file = session?.vault.getAbstractFileByPath(path);
    if (!session || !mime || !(file instanceof TFile)) {
      image.classList.add("is-unavailable");
      image.alt = t("{name} (Bild nicht verfügbar)", {
        name: image.alt || path,
      });
      return;
    }
    if (file.stat.size > MAX_ATTACHMENT_BYTES) {
      image.classList.add("is-unavailable");
      image.alt = t("{name} (größer als 64 MiB)", { name: image.alt || path });
      return;
    }
    try {
      const url = await cachedImageUrl(
        session,
        `${file.path}\0${file.stat.size}\0${file.stat.mtime}`,
        async () =>
          new Blob([await session.vault.readBinary(file)], { type: mime }),
      );
      if (!this.live) return;
      image.src = url;
    } catch (error) {
      if (!this.live || error instanceof ImageCacheCleared) return;
      image.classList.add("is-unavailable");
      console.warn(t("Bild konnte nicht geladen werden"), error);
    }
  }

  private async loadMedia(
    element: HTMLDivElement | HTMLMediaElement,
    path: string,
    mime: string,
    target: string,
  ): Promise<void> {
    const session = this.host.compatibility;
    const file = session?.vault.getAbstractFileByPath(path);
    if (!session || !(file instanceof TFile)) {
      element.closest(".internal-embed")?.classList.add("is-unavailable");
      return;
    }
    if (file.stat.size > MAX_ATTACHMENT_BYTES) {
      const embed = element.closest<HTMLElement>(".internal-embed");
      embed?.classList.add("is-unavailable");
      if (embed) embed.title = t("Datei ist größer als 64 MiB.");
      return;
    }
    try {
      const data = await session.vault.readBinary(file);
      if (!this.live) return;
      if (mime === "application/pdf") {
        const pdf = new PdfView();
        this.pdfs.push(pdf);
        element.append(pdf.el);
        const page = Number(/(?:^|[#&])page=(\d+)/.exec(target)?.[1] ?? 1);
        void pdf.load(data, page).then(() => this.live && this.onResize());
        return;
      }
      const url = URL.createObjectURL(new Blob([data], { type: mime }));
      this.objectUrls.push(url);
      const page = /(?:^|[#&])page=(\d+)/.exec(target)?.[1];
      element.setAttribute("src", page ? `${url}#page=${page}` : url);
      element.addEventListener("loadedmetadata", () => this.onResize(), {
        once: true,
      });
    } catch (error) {
      element.closest(".internal-embed")?.classList.add("is-unavailable");
      console.warn(t("Medien-Datei konnte nicht geladen werden"), error);
    }
  }
}

function applySize(
  image: HTMLImageElement,
  size: { width?: number; height?: number },
): void {
  if (size.width) image.setAttribute("width", String(size.width));
  // `WxH` fits the image into that box without distorting it.
  if (size.height) {
    image.setAttribute("height", String(size.height));
    image.style.height = `${size.height}px`;
    image.style.objectFit = "contain";
  }
}
