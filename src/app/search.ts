import { getLocale, plural, t } from "../i18n";
import { basename, clear, debounce, dirname, h, icon } from "../ui/dom";
import { confirmAction } from "../ui/modal";
import { notify } from "../ui/notice";
import type { App } from "./app";
import { replaceableTerm, replaceTerm } from "./search-replace";
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
  private readonly replaceToggle: HTMLButtonElement;
  private readonly replaceRow: HTMLElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly matchCaseButton: HTMLButtonElement;
  private readonly replaceAllButton: HTMLButtonElement;
  private matchCase = false;
  private replacing = false;

  constructor(
    private readonly app: App,
    private readonly container: HTMLElement,
  ) {
    this.input = h("input", {
      class: "search-input",
      label: t("Im Vault suchen"),
      attrs: {
        type: "search",
        placeholder: t("Suchen …"),
        autocomplete: "off",
        spellcheck: "false",
        enterkeyhint: "search",
      },
    });
    this.clearButton = h(
      "button",
      {
        class: "search-input-clear-button",
        label: t("Suche leeren"),
        attrs: { type: "button", hidden: true },
        on: { click: () => this.setQuery("") },
      },
      icon("x", 14),
    );
    this.infoEl = h("div", "search-results-info");
    this.resultsEl = h("div", "search-result-container");
    this.replaceToggle = h(
      "button",
      {
        class: "clickable-icon search-replace-toggle",
        label: t("Ersetzen"),
        attrs: { type: "button", "aria-pressed": "false" },
        on: { click: () => this.toggleReplace() },
      },
      icon("replace", 16),
    );
    this.replaceInput = h("input", {
      class: "search-input",
      label: t("Ersetzen durch"),
      attrs: {
        type: "text",
        placeholder: t("Ersetzen durch …"),
        autocomplete: "off",
        spellcheck: "false",
      },
    });
    this.replaceInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.replaceIn(this.results.map((result) => result.path));
      }
    });
    this.matchCaseButton = h(
      "button",
      {
        class: "clickable-icon search-match-case",
        label: t("Groß-/Kleinschreibung beachten"),
        attrs: { type: "button", "aria-pressed": "false" },
        on: {
          click: () => {
            this.matchCase = !this.matchCase;
            this.matchCaseButton.setAttribute(
              "aria-pressed",
              String(this.matchCase),
            );
            this.matchCaseButton.classList.toggle("is-active", this.matchCase);
          },
        },
      },
      icon("case-sensitive", 16),
    );
    this.replaceAllButton = h("button", {
      class: "search-replace-all",
      text: t("Alle ersetzen"),
      attrs: { type: "button" },
      on: {
        click: () => this.replaceIn(this.results.map((result) => result.path)),
      },
    });
    this.replaceRow = h(
      "div",
      { class: "search-row search-replace-row", attrs: { hidden: true } },
      h(
        "div",
        "search-input-container",
        icon("corner-down-right", 14),
        this.replaceInput,
      ),
      this.matchCaseButton,
      this.replaceAllButton,
    );
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
        this.replaceToggle,
      ),
      this.replaceRow,
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

  private toggleReplace(open = this.replaceRow.hidden): void {
    this.replaceRow.hidden = !open;
    this.replaceToggle.setAttribute("aria-pressed", String(open));
    this.replaceToggle.classList.toggle("is-active", open);
    this.container.classList.toggle("is-replacing", open);
    if (open) this.replaceInput.focus();
  }

  /**
   * Replaces the query's single term in `paths`, counted on the current
   * text. Several files ask first; each changed file is backed up and saved
   * like an edit, and one that fails stays unchanged.
   */
  private replaceIn(paths: string[]): void {
    if (this.replacing) return;
    const term = replaceableTerm(this.input.value.trim());
    if (!term) {
      notify(
        t(
          "Ersetzen braucht genau einen Suchbegriff, zum Beispiel ein Wort oder eine „Wortfolge“.",
        ),
        true,
      );
      return;
    }
    const replacement = this.replaceInput.value;
    const matchCase = this.matchCase;
    let count = 0;
    const targets: string[] = [];
    for (const path of paths) {
      const found = replaceTerm(
        this.app.index.content(path) ?? "",
        term,
        replacement,
        matchCase,
      ).count;
      if (!found) continue;
      count += found;
      targets.push(path);
    }
    if (!count) {
      notify(t("Keine Treffer zum Ersetzen."));
      return;
    }
    const run = async () => {
      this.replacing = true;
      try {
        const { updated, failed } = await this.app.rewriteNotes(
          targets,
          (text) => {
            const result = replaceTerm(text, term, replacement, matchCase);
            return result.count ? result.text : null;
          },
        );
        if (updated.length)
          notify(
            plural(updated.length, {
              one: "In {count} Datei ersetzt.",
              other: "In {count} Dateien ersetzt.",
            }),
          );
        if (failed.length)
          notify(
            t("{files} konnten nicht geändert werden und sind unverändert.", {
              files: failed.map((path) => `„${basename(path)}“`).join(", "),
            }),
            true,
          );
      } finally {
        this.replacing = false;
        this.execute();
      }
    };
    if (targets.length === 1 && paths.length === 1) {
      void run().catch((error) => this.app.report(error));
      return;
    }
    confirmAction({
      title: t("Alle ersetzen"),
      text: t(
        "„{term}“ {occurrences}-mal in {files} Dateien durch „{replacement}“ ersetzen? Jede geänderte Datei wird vorher gesichert.",
        {
          term,
          occurrences: count,
          files: targets.length,
          replacement,
        },
      ),
      confirm: t("Ersetzen"),
      run,
      onError: (error) => this.app.report(error),
    });
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
        h("div", { class: "search-suggest-heading", text: t("Suchoptionen") }),
        row("tag:", t("Notizen mit einem Tag finden")),
        row("path:", t("auf einen Ordnerpfad eingrenzen")),
        row("file:", t("nach Dateinamen filtern")),
        row("line:", t("Begriffe in derselben Zeile, z. B. line:(a b)")),
        row("section:", t("Begriffe im selben Abschnitt")),
        row("task:", t("in Aufgaben suchen")),
        row("task-todo:", t("in offenen Aufgaben suchen")),
        row("task-done:", t("in erledigten Aufgaben suchen")),
        row("/…/", t("regulärer Ausdruck")),
        row('"…"', t("exakte Wortfolge")),
        row("-", t("Treffer ausschließen")),
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
          a.path.localeCompare(b.path, getLocale()),
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
        ? t("Index wird aufgebaut …")
        : t("Keine Treffer gefunden.")
      : plural(results.length, {
          one: "{count} Datei",
          other: "{count} Dateien",
        }) +
        (total ? t(" · {count} Treffer", { count: total }) : "") +
        (this.app.indexing ? t(" · Index wird aufgebaut …") : "");
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
          result.matches.length
            ? h(
                "button",
                {
                  class: "clickable-icon search-result-replace",
                  label: t("In dieser Datei ersetzen"),
                  attrs: { type: "button", tabindex: "-1" },
                },
                icon("replace", 14),
              )
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
          text: t("{count} weitere Dateien – verfeinere die Suche.", {
            count: results.length - MAX_FILES,
          }),
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
    if (target.closest(".search-result-replace")) {
      this.replaceIn([path]);
      return;
    }
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
