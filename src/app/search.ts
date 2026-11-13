import { basename, clear, debounce, dirname, h, icon } from "../ui/dom";
import type { App } from "./app";
import { parseQuery, searchNote, type SearchResult } from "./vault-index";

const MAX_FILES = 200;
const CHUNK = 150;

/** Vault-wide full-text search; runs in slices so typing never blocks. */
export class SearchView {
  private readonly input: HTMLInputElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly infoEl: HTMLElement;
  private readonly resultsEl: HTMLElement;
  private run = 0;
  private results: SearchResult[] = [];
  private readonly collapsed = new Set<string>();
  private readonly schedule = debounce(() => this.execute(), 140);

  constructor(
    private readonly app: App,
    private readonly container: HTMLElement,
  ) {
    this.input = h("input", {
      class: "search-input",
      label: "Im Vault suchen",
      attrs: {
        type: "search",
        placeholder: "Suchen …",
        autocomplete: "off",
        spellcheck: "false",
        enterkeyhint: "search",
      },
    });
    this.clearButton = h(
      "button",
      {
        class: "search-input-clear-button",
        label: "Suche leeren",
        attrs: { type: "button", hidden: true },
        on: { click: () => this.setQuery("") },
      },
      icon("x", 14),
    );
    this.infoEl = h("div", "search-results-info");
    this.resultsEl = h("div", "search-result-container");
    container.append(
      h(
        "div",
        "search-row",
        h(
          "div",
          "search-input-container",
          icon("search", 14),
          this.input,
          this.clearButton,
        ),
      ),
      this.infoEl,
      this.resultsEl,
    );
    this.input.addEventListener("input", () => {
      this.clearButton.hidden = !this.input.value;
      this.schedule();
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.schedule.flush();
        this.resultItems()[0]?.focus();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        this.schedule.flush();
        this.resultItems()[0]?.focus();
      } else if (event.key === "Escape" && this.input.value) {
        event.stopPropagation();
        this.setQuery("");
      }
    });
    this.resultsEl.addEventListener("click", (event) => this.onClick(event));
    this.resultsEl.addEventListener("keydown", (event) => {
      const item =
        event.target instanceof HTMLElement
          ? event.target.closest<HTMLElement>(
              ".search-result-file-match, .search-result-file-title",
            )
          : null;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = this.resultItems();
        const index = item ? items.indexOf(item) : -1;
        if (event.key === "ArrowUp" && index <= 0) {
          this.input.focus();
          return;
        }
        const next =
          event.key === "ArrowDown"
            ? Math.min(items.length - 1, index + 1)
            : index - 1;
        items[next]?.focus();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (item && event.key === "Enter" && (event.ctrlKey || event.metaKey))
          this.openResult(item, true);
        else (item ?? (event.target as HTMLElement)).click();
      }
    });
    // New index data (still loading, or an edit) refreshes visible results.
    app.on("index", () => {
      if (!container.hidden && this.input.value.trim()) this.schedule();
    });
    this.showHelp();
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  setQuery(query: string): void {
    this.input.value = query;
    this.clearButton.hidden = !query;
    this.schedule.cancel();
    this.execute();
    this.focus();
  }

  private resultItems(): HTMLElement[] {
    return Array.from(
      this.resultsEl.querySelectorAll<HTMLElement>(
        ".search-result-file-match, .search-result-file-title",
      ),
    );
  }

  private showHelp(): void {
    this.infoEl.textContent = "";
    clear(this.resultsEl);
    const row = (operator: string, text: string) =>
      h(
        "div",
        "search-suggest-item",
        h("span", { class: "search-suggest-operator", text: operator }),
        h("span", { text }),
      );
    this.resultsEl.append(
      h(
        "div",
        "search-suggest",
        h("div", { class: "search-suggest-heading", text: "Suchoptionen" }),
        row("tag:", "Notizen mit einem Tag finden"),
        row("path:", "auf einen Ordnerpfad eingrenzen"),
        row("file:", "nach Dateinamen filtern"),
        row('"…"', "exakte Wortfolge"),
        row("-", "Treffer ausschließen"),
      ),
    );
  }

  private execute(): void {
    const run = ++this.run;
    const raw = this.input.value.trim();
    if (!raw) {
      this.results = [];
      this.showHelp();
      return;
    }
    const query = parseQuery(raw);
    const files = this.app.index.files.filter((path) => /\.md$/i.test(path));
    const results: SearchResult[] = [];
    let cursor = 0;
    const step = () => {
      if (run !== this.run) return;
      const end = Math.min(files.length, cursor + CHUNK);
      for (; cursor < end; cursor++) {
        const result = searchNote(this.app.index, files[cursor], query);
        if (result) results.push(result);
      }
      if (cursor < files.length) {
        setTimeout(step);
        return;
      }
      // File-name hits first, then the notes with the most matches.
      results.sort(
        (a, b) =>
          Number(b.nameMatch) - Number(a.nameMatch) ||
          b.matches.length - a.matches.length ||
          a.path.localeCompare(b.path, "de"),
      );
      this.results = results;
      this.render();
    };
    step();
  }

  private render(): void {
    const results = this.results;
    const total = results.reduce(
      (sum, result) => sum + result.matches.length,
      0,
    );
    this.infoEl.textContent = !results.length
      ? this.app.indexing
        ? "Index wird aufgebaut …"
        : "Keine Treffer gefunden."
      : `${results.length} ${results.length === 1 ? "Datei" : "Dateien"}${total ? ` · ${total} Treffer` : ""}${this.app.indexing ? " · Index wird aufgebaut …" : ""}`;
    const fragment = document.createDocumentFragment();
    for (const result of results.slice(0, MAX_FILES)) {
      const closed = this.collapsed.has(result.path);
      const folder = dirname(result.path);
      const file = h(
        "div",
        {
          class: `search-result${closed ? " is-collapsed" : ""}`,
          data: { path: result.path },
        },
        h(
          "div",
          {
            class: "search-result-file-title tree-item-self is-clickable",
            attrs: { tabindex: "0", role: "button" },
          },
          h("div", "tree-item-icon collapse-icon", icon("chevron-right", 14)),
          h(
            "div",
            "tree-item-inner",
            h("span", { text: basename(result.path) }),
            folder
              ? h("span", { class: "search-result-folder", text: folder })
              : null,
          ),
          result.matches.length
            ? h("div", {
                class: "tree-item-flair",
                text: String(result.matches.length),
              })
            : null,
        ),
      );
      if (!closed && result.matches.length)
        file.append(this.renderMatches(result));
      fragment.append(file);
    }
    if (results.length > MAX_FILES)
      fragment.append(
        h("div", {
          class: "search-results-more",
          text: `${results.length - MAX_FILES} weitere Dateien – verfeinere die Suche.`,
        }),
      );
    this.resultsEl.replaceChildren(fragment);
    this.resultsEl.scrollTop = 0;
  }

  private renderMatches(result: SearchResult): HTMLElement {
    return h(
      "div",
      "search-result-file-matches",
      ...result.matches.map((match) =>
        h(
          "div",
          {
            class: "search-result-file-match",
            attrs: { tabindex: "0", role: "button" },
            data: {
              offset: String(match.offset),
              length: String(match.length),
            },
          },
          match.text.slice(0, match.start),
          h("span", {
            class: "search-result-file-matched-text",
            text: match.text.slice(match.start, match.start + match.length),
          }),
          match.text.slice(match.start + match.length),
        ),
      ),
    );
  }

  private onClick(event: MouseEvent): void {
    const target = event.target as Element;
    const file = target.closest<HTMLElement>(".search-result");
    const path = file?.dataset.path;
    if (!file || !path) return;
    if (target.closest(".collapse-icon")) {
      const result = this.results.find((entry) => entry.path === path);
      const closed = file.classList.toggle("is-collapsed");
      if (closed) {
        this.collapsed.add(path);
        file.querySelector(".search-result-file-matches")?.remove();
      } else {
        this.collapsed.delete(path);
        if (result?.matches.length) file.append(this.renderMatches(result));
      }
      return;
    }
    this.openResult(target, event.ctrlKey || event.metaKey);
  }

  private openResult(target: Element, newTab: boolean): void {
    const path = target.closest<HTMLElement>(".search-result")?.dataset.path;
    if (!path) return;
    const match = target.closest<HTMLElement>(".search-result-file-match");
    if (match) {
      void this.app.openPath(path, {
        newTab,
        reveal: {
          offset: Number(match.dataset.offset),
          length: Number(match.dataset.length),
        },
      });
      return;
    }
    if (target.closest(".search-result-file-title")) {
      const first = this.results.find((entry) => entry.path === path)
        ?.matches[0];
      void this.app.openPath(path, {
        newTab,
        reveal: first
          ? { offset: first.offset, length: first.length }
          : undefined,
      });
    }
  }
}
