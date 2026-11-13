import { documentOutline } from "../markdown";
import { basename, clear, debounce, dirname, h, icon } from "../ui/dom";
import { showMenu } from "../ui/menu";
import type { App } from "./app";
import { LocalGraph } from "./graph";
import type { PanelId } from "./shell";
import type { Mention } from "./vault-index";

function empty(text: string): HTMLElement {
  return h("div", { class: "pane-empty", text });
}

function sectionHeader(title: string, count?: number): HTMLElement {
  return h(
    "div",
    "tree-item-self pane-section-header",
    h("div", { class: "tree-item-inner", text: title }),
    count === undefined
      ? null
      : h("div", { class: "tree-item-flair", text: String(count) }),
  );
}

function fileRow(path: string, extra?: HTMLElement | null): HTMLElement {
  const folder = dirname(path);
  return h(
    "div",
    {
      class: "tree-item-self is-clickable pane-file-row",
      attrs: { tabindex: "0", role: "button" },
      data: { path },
    },
    icon("file-text", 14),
    h(
      "div",
      "tree-item-inner",
      h("span", { text: basename(path) }),
      folder
        ? h("span", { class: "search-result-folder", text: folder })
        : null,
    ),
    extra,
  );
}

/** Context line around a link, with the link itself highlighted. */
function mentionRow(mention: Mention): HTMLElement {
  const from = Math.max(0, mention.col - 60);
  const to = Math.min(mention.text.length, mention.col + mention.length + 90);
  return h(
    "div",
    {
      class: "search-result-file-match",
      attrs: { tabindex: "0", role: "button" },
      data: { line: String(mention.line), col: String(mention.col) },
    },
    (from > 0 ? "…" : "") + mention.text.slice(from, mention.col),
    h("span", {
      class: "search-result-file-matched-text",
      text: mention.text.slice(mention.col, mention.col + mention.length),
    }),
    mention.text.slice(mention.col + mention.length, to) +
      (to < mention.text.length ? "…" : ""),
  );
}

const INFO_PANELS = ["backlinks", "outgoing", "tags", "outline"] as const;
type InfoPanel = (typeof INFO_PANELS)[number];

/** Backlinks, outgoing links, tags and outline of the active note, wherever they are docked. */
export class SidePanels {
  private readonly schedule = debounce(() => this.render(), 60);
  private readonly renderedKeys = new Map<InfoPanel, string>();
  private readonly panes: Record<InfoPanel, HTMLElement>;
  private readonly localGraph: LocalGraph;

  constructor(
    private readonly app: App,
    panes: Record<PanelId, HTMLElement>,
  ) {
    this.panes = {
      backlinks: panes.backlinks,
      outgoing: panes.outgoing,
      tags: panes.tags,
      outline: panes.outline,
    };
    this.localGraph = new LocalGraph(app, panes.graph);
    for (const event of ["active", "index", "doc", "files"] as const)
      app.on(event, () => this.schedule());
    // The graph pane is not listed: it handles its own input.
    for (const pane of Object.values(this.panes)) {
      pane.addEventListener("click", (event) => this.onClick(event));
      pane.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        (event.target as HTMLElement).click();
      });
    }
  }

  refresh(): void {
    this.schedule();
  }

  private render(): void {
    for (const tab of INFO_PANELS)
      if (this.app.isPanelVisible(tab)) this.renderPane(tab);
    // The graph keeps its DOM and layout between renders.
    if (this.app.isPanelVisible("graph"))
      this.localGraph.render(this.app.activeNote?.path ?? null);
  }

  private renderPane(tab: InfoPanel): void {
    const app = this.app;
    const path = app.activeNote?.path ?? null;
    // Skip work when nothing this pane depends on has changed.
    const key = `${path}|${app.index.revision}|${app.activeNote?.text.length ?? 0}`;
    if (key === this.renderedKeys.get(tab)) return;
    this.renderedKeys.set(tab, key);
    const pane = this.panes[tab];
    const scroll = pane.scrollTop;
    clear(pane);
    if (tab === "tags") this.renderTags(pane);
    else if (!path) pane.append(empty("Keine Datei geöffnet."));
    else if (tab === "backlinks") this.renderBacklinks(pane, path);
    else if (tab === "outgoing") this.renderOutgoing(pane, path);
    else this.renderOutline(pane);
    pane.scrollTop = scroll;
  }

  private renderBacklinks(pane: HTMLElement, path: string): void {
    const mentions = this.app.index.backlinks(path);
    const bySource = new Map<string, Mention[]>();
    for (const mention of mentions) {
      const list = bySource.get(mention.source);
      if (list) list.push(mention);
      else bySource.set(mention.source, [mention]);
    }
    pane.append(sectionHeader("Verlinkte Erwähnungen", bySource.size));
    if (!bySource.size) {
      pane.append(
        empty(
          this.app.indexing
            ? "Index wird aufgebaut …"
            : "Keine Rückverweise gefunden.",
        ),
      );
      return;
    }
    const sources = [...bySource.keys()].sort((a, b) =>
      basename(a).localeCompare(basename(b), "de"),
    );
    for (const source of sources)
      pane.append(
        h(
          "div",
          { class: "search-result", data: { path: source } },
          fileRow(
            source,
            h("div", {
              class: "tree-item-flair",
              text: String(bySource.get(source)!.length),
            }),
          ),
          h(
            "div",
            "search-result-file-matches",
            ...bySource.get(source)!.map(mentionRow),
          ),
        ),
      );
  }

  private renderOutgoing(pane: HTMLElement, path: string): void {
    const links = this.app.index.outgoing(path);
    const resolved = links.filter((link) => link.resolved);
    const unresolved = links.filter((link) => !link.resolved);
    pane.append(sectionHeader("Links", resolved.length));
    if (!resolved.length) pane.append(empty("Keine ausgehenden Links."));
    for (const link of resolved)
      pane.append(
        h(
          "div",
          { class: "search-result", data: { path: link.resolved! } },
          fileRow(link.resolved!),
        ),
      );
    if (unresolved.length) {
      pane.append(sectionHeader("Unaufgelöste Links", unresolved.length));
      for (const link of unresolved)
        pane.append(
          h(
            "div",
            {
              class: "tree-item-self is-clickable pane-file-row is-unresolved",
              attrs: { tabindex: "0", role: "button" },
              data: { create: link.target },
            },
            icon("file-plus", 14),
            h("div", { class: "tree-item-inner", text: link.target }),
          ),
        );
    }
  }

  private renderTags(pane: HTMLElement): void {
    const tags = [...this.app.index.tags()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "de"),
    );
    if (!tags.length) {
      pane.append(
        empty(
          this.app.indexing ? "Index wird aufgebaut …" : "Keine Tags gefunden.",
        ),
      );
      return;
    }
    for (const [tag, paths] of tags)
      pane.append(
        h(
          "div",
          {
            class: "tree-item-self is-clickable tag-pane-tag",
            attrs: { tabindex: "0", role: "button" },
            data: { tag },
          },
          h(
            "div",
            "tree-item-inner",
            h("span", { class: "tag-pane-tag-hash", text: "#" }),
            tag,
          ),
          h("div", { class: "tree-item-flair", text: String(paths.length) }),
        ),
      );
  }

  private renderOutline(pane: HTMLElement): void {
    const note = this.app.activeNote;
    const headings = note ? documentOutline(note.text) : [];
    if (!headings.length) {
      pane.append(empty("Keine Überschriften gefunden."));
      return;
    }
    const base = Math.min(...headings.map((heading) => heading.depth));
    for (const heading of headings)
      pane.append(
        h(
          "div",
          {
            class: "tree-item-self is-clickable outline-item",
            attrs: {
              tabindex: "0",
              role: "button",
              style: `--depth:${heading.depth - base}`,
            },
            data: { offset: String(heading.offset), heading: heading.text },
          },
          h("div", { class: "tree-item-inner", text: heading.text }),
        ),
      );
  }

  private onClick(event: MouseEvent): void {
    const app = this.app;
    const target = event.target as Element;
    const newTab = event.ctrlKey || event.metaKey;
    const outline = target.closest<HTMLElement>(".outline-item");
    if (outline && app.activePath) {
      void app.openPath(app.activePath, {
        reveal: app.active.reading
          ? { heading: outline.dataset.heading }
          : { offset: Number(outline.dataset.offset) },
      });
      return;
    }
    const tag = target.closest<HTMLElement>(".tag-pane-tag");
    if (tag) {
      app.searchFor(`tag:#${tag.dataset.tag}`);
      return;
    }
    const create = target.closest<HTMLElement>("[data-create]");
    if (create && app.activePath) {
      app.openLink(create.dataset.create!, app.activePath, newTab);
      return;
    }
    const result = target.closest<HTMLElement>(".search-result");
    const path = result?.dataset.path;
    if (!path) return;
    const match = target.closest<HTMLElement>(".search-result-file-match");
    if (match) {
      const text = app.index.content(path) ?? "";
      const lines = text.split("\n");
      const line = Number(match.dataset.line);
      let offset = Number(match.dataset.col);
      for (let i = 0; i < line && i < lines.length; i++)
        offset += lines[i].length + 1;
      void app.openPath(path, { newTab, reveal: { offset } });
    } else void app.openPath(path, { newTab });
  }
}

export class BookmarksView {
  constructor(
    private readonly app: App,
    private readonly container: HTMLElement,
  ) {
    app.on("bookmarks", () => this.render());
    app.on("files", () => this.render());
    container.addEventListener("click", (event) => {
      const row = (event.target as Element).closest<HTMLElement>("[data-path]");
      if (row)
        void app.openPath(row.dataset.path!, {
          newTab: event.ctrlKey || event.metaKey,
        });
    });
    container.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      (event.target as HTMLElement).click();
    });
    container.addEventListener("contextmenu", (event) => {
      const row = (event.target as Element).closest<HTMLElement>("[data-path]");
      if (!row) return;
      event.preventDefault();
      app.showFileMenu(
        row.dataset.path!,
        {
          x: event.clientX,
          y: event.clientY,
        },
        undefined,
        "bookmarks",
      );
    });
    this.render();
  }

  private render(): void {
    const paths = this.app.ws.bookmarks.filter((path) =>
      this.app.index.has(path),
    );
    clear(this.container);
    this.container.append(sectionHeader("Lesezeichen", paths.length));
    if (!paths.length) {
      this.container.append(
        empty(
          "Noch keine Lesezeichen. Füge Notizen über das Kontextmenü hinzu.",
        ),
      );
      return;
    }
    for (const path of paths)
      this.container.append(
        fileRow(path, h("div", "nav-file-bookmark", icon("bookmark", 12))),
      );
  }
}
