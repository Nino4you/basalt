import { t } from "../i18n";
import { LanguageDescription } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import type { Component } from "../compat/component";
import { renderPluginMarkdown } from "../compat/plugin-markdown";
import { TFile } from "../compat/files";
import { renderMarkdown, repeatsTitle } from "../markdown";
import { IMAGE_TYPES, MAX_ATTACHMENT_BYTES, MEDIA_TYPES } from "../attachments";
import { enhanceMath, enhanceMermaid } from "./rich-content";
import { PdfView } from "./pdf";
import { codeLanguages, markdownHighlight } from "../editor/syntax";
import { basename, errorMessage, extension, h, icon } from "../ui/dom";
import { notify } from "../ui/notice";
import { calloutIcon } from "../ui/callouts";
import type { App } from "./app";

/** Rendered reading view of one note, including embeds and plugin blocks. */
export class ReadingView {
  private revision = 0;
  private children: Component[] = [];
  private objectUrls: string[] = [];
  private pdfs: PdfView[] = [];
  private renderedFor: { path: string; text: string } | null = null;

  constructor(
    private readonly app: App,
    readonly el: HTMLElement,
  ) {
    el.addEventListener("click", (event) => this.onClick(event));
    el.addEventListener("auxclick", (event) => {
      if (event.button === 1) this.onClick(event);
    });
    el.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target as HTMLElement;
      const box = target.closest<HTMLElement>(".task-box");
      if (box && !box.closest(".markdown-embed")) {
        event.preventDefault();
        this.toggleTaskBox(box);
        return;
      }
      const title = target.closest<HTMLElement>(".callout-title[role='button']");
      if (!title || target.closest("a")) return;
      event.preventDefault();
      this.toggleCallout(title);
    });
    el.addEventListener("pointerover", (event) => {
      if (event.pointerType === "touch") return;
      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(
        "a.internal-link",
      );
      if (!link || link.classList.contains("is-embed")) return;
      const target = link.dataset.note ?? "";
      const source = link.dataset.source ?? this.renderedFor?.path;
      if (!target || !source) return;
      this.app.previewLink(target, source, link.getBoundingClientRect());
    });
    el.addEventListener("pointerout", (event) => {
      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(
        "a.internal-link",
      );
      if (!link) return;
      const next = event.relatedTarget as Node | null;
      if (!next || !link.contains(next)) this.app.hideLinkPreview();
    });
  }

  clear(): void {
    this.revision++;
    this.renderedFor = null;
    this.dispose();
    this.el.replaceChildren();
  }

  private dispose(): void {
    const children = this.children;
    this.children = [];
    for (const child of children)
      void child
        .unloadAsync()
        .catch((error) => notify(errorMessage(error), true));
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
    for (const pdf of this.pdfs) pdf.dispose();
    this.pdfs = [];
  }

  render(path: string, text: string): void {
    if (this.renderedFor?.path === path && this.renderedFor.text === text)
      return;
    const keepScroll = this.renderedFor?.path === path ? this.el.scrollTop : 0;
    this.renderedFor = { path, text };
    const revision = ++this.revision;
    this.dispose();
    const sizer = h("div", "markdown-preview-sizer markdown-preview-section");
    if (!repeatsTitle(text, basename(path)))
      sizer.append(h("div", { class: "inline-title", text: basename(path) }));
    const body = h("div", "markdown-rendered-body");
    body.innerHTML = renderMarkdown(text);
    sizer.append(body);
    this.decorate(body, path, 0, new Set([path]));
    enhanceMath(body, () => revision === this.revision);
    enhanceMermaid(body, () => revision === this.revision);
    this.el.replaceChildren(sizer);
    this.el.scrollTop = keepScroll;
    void this.renderPlugins(revision, path, body).catch((error) =>
      this.app.report(error),
    );
  }

  private async renderPlugins(revision: number, path: string, body: HTMLElement): Promise<void> {
    const session = this.app.compatibility;
    if (!session) return;
    await renderPluginMarkdown(
      body,
      session.services,
      {
        sourcePath: path,
        app: session,
        embeds: session.embedRegistry,
        addChild: (child) => {
          child.load();
          this.children.push(child);
        },
      },
      () => revision === this.revision && session === this.app.compatibility,
    );
  }

  /** Link states, callout icons, copy buttons and embeds for freshly rendered HTML. */
  private decorate(
    root: HTMLElement,
    path: string,
    depth: number,
    chain: Set<string>,
  ): void {
    const index = this.app.index;
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
    const revision = this.revision;
    const text = code.textContent ?? "";
    if (text.length > 60000) return;
    try {
      const support = await description.load();
      // A plugin code-block processor may have replaced the block meanwhile.
      if (revision !== this.revision || !code.isConnected) return;
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
    chain: Set<string>,
  ): void {
    const name = target.split("#")[0];
    const type = extension(name);
    if (IMAGE_TYPES[type]) {
      const image = h("img", { attrs: { alt: name, loading: "lazy" } });
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
      const fragment = target.split("#")[1] ?? "";
      const height = /(?:^|[#&|])height=(\d+)/.exec(fragment);
      if (height) holder.style.height = `${height[1]}px`;
      const paragraph = link.parentElement;
      if (paragraph?.tagName === "P" && paragraph.childNodes.length === 1)
        paragraph.replaceWith(holder);
      else link.replaceWith(holder);
      void this.loadMedia(element, resolved, media.mime, target);
      return;
    }
    const text = resolved ? this.app.index.content(resolved) : undefined;
    if (!resolved || text === undefined || depth >= 3 || chain.has(resolved)) {
      link.classList.add("is-unresolved-embed");
      if (!resolved) link.classList.add("is-unresolved");
      link.setAttribute("data-source", source);
      return;
    }
    const content = h("div", "markdown-embed-content");
    content.innerHTML = renderMarkdown(text);
    const open = h(
      "a",
      {
        class: "markdown-embed-link internal-link",
        label: t("Notiz öffnen"),
        attrs: { href: "#" },
        data: { note: resolved, source },
      },
      icon("link", 14),
    );
    const container = h(
      "div",
      {
        class: "internal-embed markdown-embed",
        // Post processors resolve drawing transclusions through Obsidian's src attribute.
        attrs: { src: resolved + (target.includes("#") ? target.slice(target.indexOf("#")) : "") },
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
    this.decorate(content, resolved, depth + 1, new Set([...chain, resolved]));
  }

  /** Vault images are only readable through the native binary bridge. */
  private async loadImage(
    image: HTMLImageElement,
    path: string,
  ): Promise<void> {
    const revision = this.revision;
    const session = this.app.compatibility;
    const mime = IMAGE_TYPES[extension(path)];
    const file = session?.vault.getAbstractFileByPath(path);
    if (!session || !mime || !(file instanceof TFile)) {
      image.classList.add("is-unavailable");
      image.alt = t("{name} (Bild nicht verfügbar)", { name: image.alt || path });
      return;
    }
    if (file.stat.size > MAX_ATTACHMENT_BYTES) {
      image.classList.add("is-unavailable");
      image.alt = t("{name} (größer als 64 MiB)", { name: image.alt || path });
      return;
    }
    try {
      const data = await session.vault.readBinary(file);
      if (revision !== this.revision) return;
      const url = URL.createObjectURL(new Blob([data], { type: mime }));
      this.objectUrls.push(url);
      image.src = url;
    } catch (error) {
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
    const revision = this.revision;
    const session = this.app.compatibility;
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
      if (revision !== this.revision) return;
      if (mime === "application/pdf") {
        const pdf = new PdfView();
        this.pdfs.push(pdf);
        element.append(pdf.el);
        const page = Number(/(?:^|[#&])page=(\d+)/.exec(target)?.[1] ?? 1);
        void pdf.load(data, page);
        return;
      }
      const url = URL.createObjectURL(new Blob([data], { type: mime }));
      this.objectUrls.push(url);
      const page = /(?:^|[#&])page=(\d+)/.exec(target)?.[1];
      element.setAttribute("src", page ? `${url}#page=${page}` : url);
    } catch (error) {
      element.closest(".internal-embed")?.classList.add("is-unavailable");
      console.warn(t("Medien-Datei konnte nicht geladen werden"), error);
    }
  }

  private toggleCallout(title: HTMLElement): void {
    const callout = title.closest<HTMLElement>(".callout");
    if (!callout) return;
    const collapsed = callout.classList.toggle("is-collapsed");
    title.setAttribute("aria-expanded", String(!collapsed));
  }

  private toggleTaskBox(box: HTMLElement): void {
    const boxes = [...this.el.querySelectorAll(".task-box")].filter(
      (node) => !node.closest(".markdown-embed"),
    );
    this.app.toggleTask(boxes.indexOf(box));
  }

  private onClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const calloutTitle = target.closest<HTMLElement>(".callout-title[role='button']");
    if (calloutTitle && !target.closest("a")) {
      this.toggleCallout(calloutTitle);
      return;
    }
    const copy = target.closest<HTMLElement>(".copy-code-button");
    if (copy) {
      const code = copy.parentElement?.querySelector("code")?.textContent ?? "";
      void navigator.clipboard
        ?.writeText(code)
        .then(() => notify(t("Code kopiert.")))
        .catch(() => notify(t("Kopieren nicht möglich."), true));
      return;
    }
    const box = target.closest<HTMLElement>(".task-box");
    if (box && !box.closest(".markdown-embed")) {
      this.toggleTaskBox(box);
      return;
    }
    const link = target.closest<HTMLAnchorElement>("a");
    if (!link) return;
    event.preventDefault();
    const newTab = event.ctrlKey || event.metaKey || event.button === 1;
    if (link.dataset.tag) this.app.searchFor(`tag:#${link.dataset.tag}`);
    else if (link.dataset.note !== undefined) {
      const source =
        link.dataset.source ?? this.renderedFor?.path ?? this.app.activePath;
      if (source) this.app.openLink(link.dataset.note, source, newTab);
    } else {
      const href = link.getAttribute("href") ?? "";
      if (href.startsWith("#")) {
        const id = decodeURIComponent(href.slice(1));
        this.scrollToHeading(id);
      } else this.app.openExternal(href);
    }
  }

  scrollToHeading(text: string): boolean {
    const wanted = text.trim().toLowerCase();
    for (const heading of this.el.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
      if (heading.closest(".markdown-embed")) continue;
      if ((heading.textContent ?? "").trim().toLowerCase() === wanted) {
        heading.scrollIntoView({ block: "start", behavior: "smooth" });
        return true;
      }
    }
    return false;
  }
}
