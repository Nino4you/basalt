import { t } from "../i18n";
import { clear, h, icon } from "../ui/dom";
import {
  FileValue,
  LinkValue,
  toText,
  type EvalHost,
  type FileRecord,
  type Value,
} from "./expr";
import { parseBase, setViewSort, type BaseConfig, type SortSpec } from "./model";
import { runView, type Row, type ViewResult } from "./query";

export interface BaseViewHost {
  /** Every Markdown note in the vault as a file record. */
  records(): FileRecord[];
  record(path: string): FileRecord | null;
  evalHost(): EvalHost;
  openFile(path: string, newTab: boolean): void;
  /** Resolves a link target from `source` to a vault path. */
  resolve(target: string, source: string): string | null;
  /** Object URL for a vault image, or null when it cannot be shown. */
  loadImage(path: string): Promise<string | null>;
  /** The user changed the base (sort, source edit). */
  onChange(path: string, text: string): void;
}

const FILE_LABELS: Record<string, () => string> = {
  "file.name": () => t("Dateiname"),
  "file.basename": () => t("Dateiname"),
  "file.path": () => t("Pfad"),
  "file.folder": () => t("Ordner"),
  "file.ext": () => t("Dateiendung"),
  "file.size": () => t("Größe"),
  "file.ctime": () => t("Erstellt"),
  "file.mtime": () => t("Geändert"),
  "file.tags": () => t("Tags"),
  "file.links": () => t("Links"),
  "file.backlinks": () => t("Rückverweise"),
};

/** A `.base` file shown as a table or as cards, with the YAML one click away. */
export class BaseView {
  readonly el: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly body: HTMLElement;
  private readonly source: HTMLTextAreaElement;
  private path: string | null = null;
  private text = "";
  private config: BaseConfig | null = null;
  /** Selected view per base file, for this session. */
  private readonly selected = new Map<string, number>();
  private editing = false;
  private objectUrls: string[] = [];
  private renderToken = 0;

  constructor(private readonly host: BaseViewHost) {
    this.bar = h("div", { class: "bases-toolbar" });
    this.body = h("div", { class: "bases-body" });
    this.source = h("textarea", {
      class: "bases-source",
      label: t("Base-Quelltext"),
      attrs: { spellcheck: "false", autocomplete: "off", hidden: true },
    });
    this.source.addEventListener("input", () => {
      if (!this.path) return;
      this.text = this.source.value;
      this.host.onChange(this.path, this.text);
    });
    this.el = h("div", { class: "bases-view" }, this.bar, this.source, this.body);
  }

  load(path: string, text: string): void {
    const changed = path !== this.path;
    this.path = path;
    if (changed) this.editing = false;
    this.setText(text, true);
  }

  /** New file content from outside (load, external change, restore). */
  setText(text: string, force = false): void {
    if (!force && text === this.text) return;
    this.text = text;
    if (this.source.value !== text) this.source.value = text;
    this.config = parseBase(text);
    this.render();
  }

  /** Re-runs the query after vault changes. */
  refresh(): void {
    if (this.path && !this.editing) this.render();
  }

  suspend(): void {
    this.releaseImages();
    this.renderToken++;
  }

  focus(): void {
    if (this.editing) this.source.focus();
  }

  private get viewIndex(): number {
    const count = this.config?.views.length ?? 0;
    const index = this.selected.get(this.path ?? "") ?? 0;
    return Math.min(index, Math.max(0, count - 1));
  }

  private releaseImages(): void {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
  }

  private render(): void {
    const config = this.config;
    const path = this.path;
    if (!config || !path) return;
    this.releaseImages();
    const token = ++this.renderToken;
    const index = this.viewIndex;
    const view = config.views[index];
    const self = this.host.record(path);
    const result = view && !this.editing
      ? runView(config, view, this.host.records(), this.host.evalHost(), self)
      : null;
    this.renderBar(config, index, result);
    this.source.hidden = !this.editing;
    this.body.hidden = this.editing;
    clear(this.body);
    if (this.editing) return;
    const errors = [...config.errors, ...(result?.errors ?? [])];
    if (errors.length)
      this.body.append(
        h(
          "div",
          { class: "bases-errors", attrs: { role: "alert" } },
          h("strong", { text: t("Fehler in der Base") }),
          h("ul", null, ...errors.slice(0, 8).map((error) => h("li", { text: error }))),
        ),
      );
    if (!view) {
      this.body.append(
        h("p", {
          class: "bases-empty",
          text: t("Diese Base hat noch keine Ansicht. Lege im Quelltext unter „views“ eine an."),
        }),
      );
      return;
    }
    if (!result) return;
    if (!result.total) {
      this.body.append(h("p", { class: "bases-empty", text: t("Keine Notizen passen zu den Filtern.") }));
      return;
    }
    if (view.type === "cards") this.renderCards(config, result, view.image, token);
    else this.renderTable(config, index, result);
  }

  private renderBar(config: BaseConfig, index: number, result: ViewResult | null): void {
    const tabs = h("div", { class: "bases-view-tabs", attrs: { role: "tablist" } });
    config.views.forEach((view, i) => {
      const tab = h(
        "button",
        {
          class: `bases-view-tab${i === index ? " is-active" : ""}`,
          attrs: { type: "button", role: "tab", "aria-selected": String(i === index) },
          on: {
            click: () => {
              this.selected.set(this.path ?? "", i);
              this.editing = false;
              this.render();
            },
          },
        },
        icon(view.type === "cards" ? "layout-grid" : "table", 16),
        h("span", { text: view.name }),
      );
      tabs.append(tab);
    });
    const count = result
      ? h("span", {
          class: "bases-count",
          text:
            result.total === 1
              ? t("1 Ergebnis")
              : t("{count} Ergebnisse", { count: result.total }),
        })
      : null;
    const sourceButton = h(
      "button",
      {
        class: `bases-source-toggle clickable-icon${this.editing ? " is-active" : ""}`,
        attrs: {
          type: "button",
          "aria-pressed": String(this.editing),
          "aria-label": this.editing ? t("Ansicht zeigen") : t("Quelltext bearbeiten"),
        },
        on: {
          click: () => {
            this.editing = !this.editing;
            if (!this.editing) this.config = parseBase(this.text);
            this.render();
            if (this.editing) this.source.focus();
          },
        },
      },
      icon(this.editing ? "table" : "code", 16),
    );
    this.bar.replaceChildren(tabs, h("div", "bases-toolbar-spacer"), ...(count ? [count] : []), sourceButton);
  }

  private label(config: BaseConfig, property: string): string {
    const custom = config.displayNames.get(property);
    if (custom) return custom;
    if (FILE_LABELS[property]) return FILE_LABELS[property]();
    return property.replace(/^(note|formula|file|this)\./, "");
  }

  private renderTable(config: BaseConfig, index: number, result: ViewResult): void {
    const view = config.views[index];
    const sort = view.sort;
    const head = h("tr");
    for (const column of result.columns) {
      const active = sort[0]?.property === column ? sort[0].direction : null;
      const button = h(
        "button",
        {
          class: "bases-sort",
          attrs: { type: "button", title: t("Sortieren") },
          on: { click: () => this.toggleSort(index, column, active) },
        },
        h("span", { text: this.label(config, column) }),
        active ? icon(active === "ASC" ? "arrow-up" : "arrow-down", 14) : null,
      );
      head.append(
        h(
          "th",
          {
            attrs: {
              scope: "col",
              "aria-sort": active === "ASC" ? "ascending" : active === "DESC" ? "descending" : "none",
            },
          },
          button,
        ),
      );
    }
    const body = h("tbody");
    const grouped = !!view.groupBy;
    for (const group of result.groups) {
      if (grouped)
        body.append(
          h(
            "tr",
            "bases-group-row",
            h(
              "th",
              { attrs: { colspan: String(result.columns.length), scope: "rowgroup" } },
              this.groupTitle(config, view.groupBy!.property, group.key),
              h("span", { class: "bases-group-count", text: String(group.rows.length) }),
            ),
          ),
        );
      for (const row of group.rows) {
        const tr = h("tr");
        for (const column of result.columns) {
          const cell = h("td");
          if (column === "file.name" || column === "file.basename") cell.append(this.fileLink(row.file));
          else this.renderValue(cell, row.value(column), row.file.path);
          tr.append(cell);
        }
        body.append(tr);
      }
    }
    const table = h(
      "table",
      { class: "bases-table", label: view.name },
      h("thead", null, head),
      body,
    );
    this.body.append(h("div", "bases-table-wrapper", table));
  }

  private groupTitle(config: BaseConfig, property: string, key: Value): HTMLElement {
    const el = h("span", { class: "bases-group-title" });
    el.append(h("span", { class: "bases-group-label", text: `${this.label(config, property)}: ` }));
    if (key === null) el.append(h("span", { class: "bases-group-none", text: t("(leer)") }));
    else this.renderValue(el, key, this.path ?? "");
    return el;
  }

  private renderCards(config: BaseConfig, result: ViewResult, image: string | null, token: number): void {
    const view = config.views[this.viewIndex];
    const columns = result.columns.filter((column) => column !== "file.name" && column !== "file.basename");
    for (const group of result.groups) {
      if (view.groupBy)
        this.body.append(
          h(
            "div",
            "bases-cards-group",
            this.groupTitle(config, view.groupBy.property, group.key),
            h("span", { class: "bases-group-count", text: String(group.rows.length) }),
          ),
        );
      const grid = h("div", { class: "bases-cards", attrs: { role: "list" } });
      for (const row of group.rows) grid.append(this.card(config, row, columns, image, token));
      this.body.append(grid);
    }
  }

  private card(config: BaseConfig, row: Row, columns: string[], image: string | null, token: number): HTMLElement {
    const cover = h("div", { class: "bases-card-cover" });
    if (image) this.fillCover(cover, row.value(image), row.file.path, token);
    else cover.hidden = true;
    const props = h("dl", { class: "bases-card-properties" });
    for (const column of columns) {
      const value = row.value(column);
      if (value === null || (Array.isArray(value) && !value.length) || value === "") continue;
      const dd = h("dd");
      this.renderValue(dd, value, row.file.path);
      props.append(h("dt", { text: this.label(config, column) }), dd);
    }
    const title = this.fileLink(row.file);
    title.classList.add("bases-card-title");
    const card = h("div", { class: "bases-card", attrs: { role: "listitem" } }, cover, title, props);
    card.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("a, button, input")) return;
      this.host.openFile(row.file.path, event.ctrlKey || event.metaKey);
    });
    return card;
  }

  private fillCover(cover: HTMLElement, value: Value, source: string, token: number): void {
    const text = value instanceof LinkValue || value instanceof FileValue ? null : toText(value);
    if (text && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(text.trim())) {
      cover.style.background = text.trim();
      return;
    }
    if (text && /^(?:rgb|hsl)a?\([\d\s.,%]+\)$/i.test(text.trim())) {
      cover.style.background = text.trim();
      return;
    }
    const path =
      value instanceof FileValue
        ? value.path
        : value instanceof LinkValue
          ? this.host.resolve(value.target, source)
          : text
            ? this.host.resolve(text.replace(/^!?\[\[|\]\]$/g, "").split("|")[0], source)
            : null;
    if (!path) {
      cover.classList.add("is-empty");
      return;
    }
    cover.classList.add("is-loading");
    void this.host.loadImage(path).then((url) => {
      cover.classList.remove("is-loading");
      if (token !== this.renderToken) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      if (!url) {
        cover.classList.add("is-empty");
        return;
      }
      this.objectUrls.push(url);
      cover.append(h("img", { attrs: { src: url, alt: "", loading: "lazy" } }));
    });
  }

  private fileLink(file: FileRecord): HTMLElement {
    const name = file.path.slice(file.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
    return h("a", {
      class: "internal-link",
      text: name,
      attrs: { href: "#", "data-href": file.path, title: file.path },
      on: {
        click: (event) => {
          event.preventDefault();
          this.host.openFile(file.path, event.ctrlKey || event.metaKey);
        },
      },
    });
  }

  private renderValue(parent: HTMLElement, value: Value, source: string): void {
    if (value === null) return;
    if (typeof value === "boolean") {
      const box = h("input", {
        class: "task-list-item-checkbox",
        attrs: { type: "checkbox", disabled: true, "aria-label": value ? t("Ja") : t("Nein") },
      });
      box.checked = value;
      parent.append(box);
      return;
    }
    if (value instanceof LinkValue || value instanceof FileValue) {
      const path = value instanceof FileValue ? value.path : this.host.resolve(value.target, source);
      const link = h("a", {
        class: `internal-link${path ? "" : " is-unresolved"}`,
        text: toText(value),
        attrs: { href: "#" },
        on: {
          click: (event) => {
            event.preventDefault();
            if (path) this.host.openFile(path, event.ctrlKey || event.metaKey);
          },
        },
      });
      parent.append(link);
      return;
    }
    if (Array.isArray(value)) {
      const list = h("span", "bases-list");
      for (const item of value) {
        const chip = h("span", {
          class: typeof item === "string" && item.startsWith("#") ? "bases-chip tag" : "bases-chip",
        });
        this.renderValue(chip, item, source);
        list.append(chip);
      }
      parent.append(list);
      return;
    }
    if (typeof value === "number") parent.classList.add("is-number");
    parent.append(document.createTextNode(toText(value, this.host.evalHost().locale)));
  }

  private toggleSort(index: number, property: string, current: "ASC" | "DESC" | null): void {
    const config = this.config;
    const path = this.path;
    if (!config || !path) return;
    const view = config.views[index];
    // A header click sorts by that column alone: ascending, descending, off.
    const next: SortSpec[] =
      current === null
        ? [{ property, direction: "ASC" }]
        : current === "ASC"
          ? [{ property, direction: "DESC" }]
          : [];
    const text = setViewSort(this.text, index, next);
    if (text === null) return;
    this.host.onChange(path, text);
    this.setText(text);
  }
}
