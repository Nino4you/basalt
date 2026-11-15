import { t } from "../i18n";
import type { Component } from "../compat/component";
import { renderPluginMarkdown } from "../compat/plugin-markdown";
import { renderMarkdown, repeatsTitle } from "../markdown";
import { enhanceMath, enhanceMermaid } from "./rich-content";
import { RenderScope } from "./embed-render";
import { basename, errorMessage, h } from "../ui/dom";
import { notify } from "../ui/notice";
import type { App } from "./app";

/** Rendered reading view of one note, including embeds and plugin blocks. */
export class ReadingView {
  private revision = 0;
  private children: Component[] = [];
  private scope: RenderScope | null = null;
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
    this.scope?.dispose();
    this.scope = null;
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
    const scope = (this.scope = new RenderScope(this.app));
    scope.decorate(body, path);
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
    const footnote = link.dataset.footnoteRef ?? link.dataset.footnoteBack;
    if (footnote) {
      // Footnotes of an embedded note stay within that embed.
      const scope = link.closest(".markdown-embed") ?? this.el;
      const goal = scope.querySelector<HTMLElement>(
        link.dataset.footnoteRef
          ? `li[data-footnote="${footnote}"]`
          : `a[data-footnote-ref="${footnote}"]`,
      );
      goal?.scrollIntoView({ block: "center", behavior: "smooth" });
      goal?.classList.add("is-flashing");
      setTimeout(() => goal?.classList.remove("is-flashing"), 1200);
      return;
    }
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
