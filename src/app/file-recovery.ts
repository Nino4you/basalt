import { getLocale, plural, t } from "../i18n";
import { backend } from "../backend";
import type { BackupEntry } from "../backups";
import { h, icon } from "../ui/dom";
import { Modal } from "../ui/modal";
import { notify } from "../ui/notice";
import type { App } from "./app";
import { collapseDiff, diffLines } from "./line-diff";

/** Rows rendered at once; long histories grow on demand. */
const PAGE = 200;

type View = "versions" | "deleted";

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.(md|canvas|base)$/i, "");
}

function folder(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Seconds matter: autosave writes several versions a minute while typing. */
function formatTime(time: number): string {
  if (!time) return t("Unbekannter Zeitpunkt");
  return new Intl.DateTimeFormat(getLocale(), {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(time);
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600_000],
  ["month", 30 * 24 * 3600_000],
  ["week", 7 * 24 * 3600_000],
  ["day", 24 * 3600_000],
  ["hour", 3600_000],
  ["minute", 60_000],
];

function relativeTime(time: number, now = Date.now()): string {
  if (!time) return "";
  const format = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
  const elapsed = time - now;
  for (const [unit, size] of UNITS)
    if (Math.abs(elapsed) >= size)
      return format.format(Math.round(elapsed / size), unit);
  return format.format(0, "minute");
}

function formatSize(bytes: number): string {
  const kilo = bytes / 1024;
  return new Intl.NumberFormat(getLocale(), {
    style: "unit",
    unit: kilo < 1024 ? "kilobyte" : "megabyte",
    maximumFractionDigits: 1,
  }).format(kilo < 1024 ? kilo : kilo / 1024);
}

/**
 * Lists the backups the vault keeps (previous versions and deleted files)
 * and restores them without ever writing over a file blindly.
 */
class FileRecovery {
  private readonly modal = new Modal("mod-file-recovery");
  private readonly tabs = new Map<View, HTMLButtonElement>();
  private readonly list = h("div", { class: "recovery-list" });
  private readonly preview = h("div", {
    class: "recovery-preview",
    attrs: { "aria-live": "polite" },
  });
  private backups: BackupEntry[] = [];
  private view: View = "versions";
  /** The note whose versions are listed; `null` lists the notes. */
  private note: string | null = null;
  private selected: BackupEntry | null = null;
  private showChanges = true;
  private filter = "";
  private limit = PAGE;
  private readonly texts = new Map<string, Promise<string>>();
  /** Increments whenever the preview target changes, to drop stale reads. */
  private request = 0;

  constructor(
    private readonly app: App,
    focus?: string,
  ) {
    this.note = focus ?? null;
    this.modal.setTitle(t("Dateiwiederherstellung"));
    const tabs = h("div", {
      class: "recovery-tabs",
      attrs: { role: "tablist" },
    });
    for (const [view, label] of [
      ["versions", t("Versionen")],
      ["deleted", t("Gelöschte Dateien")],
    ] as const) {
      const tab = h("button", {
        class: "recovery-tab",
        text: label,
        attrs: { type: "button", role: "tab" },
        on: { click: () => this.setView(view) },
      });
      this.tabs.set(view, tab);
      tabs.append(tab);
    }
    this.list.addEventListener("keydown", (event) => this.moveFocus(event));
    this.modal.contentEl.append(
      tabs,
      h("div", "recovery-body", this.list, this.preview),
    );
  }

  async open(): Promise<void> {
    this.modal.open();
    this.renderTabs();
    this.list.replaceChildren(
      h("div", { class: "recovery-empty", text: t("Wird geladen …") }),
    );
    await this.reload();
  }

  private async reload(): Promise<void> {
    const vault = this.app.vault;
    if (!vault) return;
    try {
      this.backups = await backend.backups(vault.id);
    } catch (error) {
      this.backups = [];
      this.app.report(error);
    }
    if (vault !== this.app.vault) return this.modal.close();
    this.texts.clear();
    if (this.note && !this.selected)
      this.select(
        this.backups.find(
          (backup) => backup.kind === "version" && backup.path === this.note,
        ) ?? null,
      );
    this.render();
  }

  private setView(view: View): void {
    if (view === this.view) return;
    this.view = view;
    this.note = null;
    this.limit = PAGE;
    this.select(null);
    this.render();
  }

  private renderTabs(): void {
    for (const [view, tab] of this.tabs) {
      tab.setAttribute("aria-selected", String(view === this.view));
      tab.classList.toggle("is-active", view === this.view);
    }
  }

  private render(): void {
    this.renderTabs();
    this.modal.modalEl.classList.toggle("is-previewing", !!this.selected);
    if (this.view === "deleted") this.renderDeleted();
    else if (this.note) this.renderVersions(this.note);
    else this.renderNotes();
    this.renderPreview();
  }

  private row(
    content: Node[],
    onClick: () => void,
    selected = false,
  ): HTMLButtonElement {
    return h(
      "button",
      {
        class: `recovery-row${selected ? " is-selected" : ""}`,
        attrs: { type: "button", "aria-pressed": selected ? "true" : null },
        on: { click: onClick },
      },
      ...content,
    );
  }

  private more(total: number): HTMLElement | null {
    if (total <= this.limit) return null;
    return h("button", {
      class: "recovery-more",
      text: t("Weitere {count} anzeigen", {
        count: Math.min(PAGE, total - this.limit),
      }),
      attrs: { type: "button" },
      on: {
        click: () => {
          this.limit += PAGE;
          this.render();
        },
      },
    });
  }

  private empty(text: string): HTMLElement {
    return h("div", { class: "recovery-empty", text });
  }

  private demoHint(): HTMLElement | null {
    return this.app.vault?.platform === "browser"
      ? h("p", {
          class: "recovery-hint",
          text: t(
            "Die Browser-Demo behält nur die letzten Versionen jeder Notiz.",
          ),
        })
      : null;
  }

  private renderNotes(): void {
    const groups = new Map<string, BackupEntry[]>();
    for (const backup of this.backups)
      if (backup.kind === "version")
        groups.set(backup.path, [...(groups.get(backup.path) ?? []), backup]);
    const search = h("input", {
      class: "recovery-filter",
      attrs: {
        type: "search",
        placeholder: t("Notizen filtern …"),
        "aria-label": t("Notizen filtern …"),
        value: this.filter,
      },
    });
    const rows = h("div", "recovery-rows");
    const fill = () => {
      const needle = this.filter.toLocaleLowerCase();
      const notes = [...groups].filter(([path]) =>
        path.toLocaleLowerCase().includes(needle),
      );
      rows.replaceChildren(
        ...(notes.length
          ? notes.slice(0, this.limit).map(([path, versions]) =>
              this.row(
                [
                  h(
                    "span",
                    "recovery-row-title",
                    icon("file-text", 16),
                    basename(path),
                  ),
                  h("span", {
                    class: "recovery-row-meta",
                    text: [
                      folder(path),
                      plural(versions.length, {
                        one: "{count} Version",
                        other: "{count} Versionen",
                      }),
                      relativeTime(versions[0].time),
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  }),
                ],
                () => {
                  this.note = path;
                  this.limit = PAGE;
                  this.select(versions[0]);
                  this.render();
                  this.focusSelected();
                },
              ),
            )
          : [
              this.empty(
                groups.size
                  ? t("Keine Treffer.")
                  : t(
                      "Noch keine Sicherungen. Basalt legt vor jedem Speichern eine an.",
                    ),
              ),
            ]),
        this.more(notes.length) ?? "",
      );
    };
    search.addEventListener("input", () => {
      this.filter = search.value;
      this.limit = PAGE;
      fill();
    });
    fill();
    this.list.replaceChildren(search, rows, this.demoHint() ?? "");
  }

  private renderVersions(path: string): void {
    const versions = this.backups.filter(
      (backup) => backup.kind === "version" && backup.path === path,
    );
    const back = h(
      "button",
      {
        class: "recovery-back",
        attrs: { type: "button" },
        on: {
          click: () => {
            this.note = null;
            this.limit = PAGE;
            this.select(null);
            this.render();
          },
        },
      },
      icon("chevron-left", 16),
      t("Alle Notizen"),
    );
    this.list.replaceChildren(
      back,
      h("div", { class: "recovery-list-title", text: path }),
      ...(versions.length
        ? versions.slice(0, this.limit).map((backup) =>
            this.row(
              [
                h("span", {
                  class: "recovery-row-title",
                  text: formatTime(backup.time),
                }),
                h("span", {
                  class: "recovery-row-meta",
                  text: [relativeTime(backup.time), formatSize(backup.size)]
                    .filter(Boolean)
                    .join(" · "),
                }),
              ],
              () => this.choose(backup),
              backup === this.selected,
            ),
          )
        : [this.empty(t("Für diese Notiz gibt es noch keine Versionen."))]),
      this.more(versions.length) ?? "",
    );
  }

  private renderDeleted(): void {
    const deleted = this.backups.filter((backup) => backup.kind === "deleted");
    this.list.replaceChildren(
      ...(deleted.length
        ? deleted.slice(0, this.limit).map((backup) =>
            this.row(
              [
                h(
                  "span",
                  "recovery-row-title",
                  icon(
                    /\.canvas$/i.test(backup.path)
                      ? "layout-dashboard"
                      : "file-text",
                    16,
                  ),
                  basename(backup.path),
                ),
                h("span", {
                  class: "recovery-row-meta",
                  text: [folder(backup.path), formatTime(backup.time)]
                    .filter(Boolean)
                    .join(" · "),
                }),
              ],
              () => this.choose(backup),
              backup === this.selected,
            ),
          )
        : [this.empty(t("Keine gelöschten Dateien."))]),
      this.more(deleted.length) ?? "",
    );
  }

  private choose(backup: BackupEntry): void {
    this.select(backup);
    this.render();
    this.focusSelected();
  }

  private select(backup: BackupEntry | null): void {
    this.selected = backup;
    this.request++;
  }

  private focusSelected(): void {
    this.list.querySelector<HTMLElement>(".recovery-row.is-selected")?.focus();
  }

  private moveFocus(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...this.list.querySelectorAll<HTMLElement>(".recovery-row")];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    rows[
      Math.max(
        0,
        Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
      )
    ]?.focus();
  }

  private backupText(backup: BackupEntry): Promise<string> {
    let text = this.texts.get(backup.location);
    if (!text) {
      text = backend.readBackup(backup.location, this.app.vault?.id);
      // A failed read may succeed later; do not cache it.
      text.catch(() => this.texts.delete(backup.location));
      this.texts.set(backup.location, text);
    }
    return text;
  }

  /** What the user sees now: an open draft wins over the saved file. */
  private async currentText(path: string): Promise<string | null> {
    if (!this.app.index.has(path)) return null;
    const open = this.app.store?.notes.get(path);
    if (open) return open.text;
    return backend.read(path, this.app.vault?.id);
  }

  private renderPreview(): void {
    const backup = this.selected;
    if (!backup) {
      this.preview.replaceChildren(
        this.empty(t("Wähle eine Sicherung, um sie anzusehen.")),
      );
      return;
    }
    const request = this.request;
    const exists = this.app.index.has(backup.path);
    const copy = backup.kind === "deleted" && exists;
    const restore = h("button", {
      class: "mod-cta",
      text: copy ? t("Als Kopie wiederherstellen") : t("Wiederherstellen"),
      attrs: { type: "button", disabled: true },
    });
    const copyText = h("button", {
      text: t("Inhalt kopieren"),
      attrs: { type: "button", disabled: true },
    });
    const mode = h("div", { class: "recovery-mode", attrs: { role: "group" } });
    for (const [changes, label] of [
      [true, t("Änderungen")],
      [false, t("Inhalt")],
    ] as const)
      mode.append(
        h("button", {
          class: `recovery-mode-button${changes === this.showChanges ? " is-active" : ""}`,
          text: label,
          attrs: {
            type: "button",
            "aria-pressed": String(changes === this.showChanges),
          },
          on: {
            click: () => {
              this.showChanges = changes;
              this.renderPreview();
            },
          },
        }),
      );
    const body = h(
      "div",
      { class: "recovery-content" },
      this.empty(t("Wird geladen …")),
    );
    const note = h("p", {
      class: "recovery-note",
      text:
        backup.kind === "version" && exists
          ? t("Die aktuelle Fassung bleibt als Sicherung erhalten.")
          : copy
            ? t(
                "Der Name ist inzwischen vergeben; die Datei wird als Kopie wiederhergestellt.",
              )
            : t("Die Datei existiert nicht mehr und wird neu angelegt."),
    });
    const back = h(
      "button",
      {
        class: "recovery-preview-back",
        attrs: { type: "button" },
        on: {
          click: () => {
            this.select(null);
            this.render();
          },
        },
      },
      icon("chevron-left", 16),
      t("Zurück"),
    );
    this.preview.replaceChildren(
      back,
      h(
        "div",
        "recovery-preview-header",
        h(
          "div",
          "recovery-preview-title",
          h("strong", {
            text:
              backup.kind === "deleted" ? backup.path : formatTime(backup.time),
          }),
          h("span", {
            text: [
              backup.kind === "deleted" ? formatTime(backup.time) : backup.path,
              formatSize(backup.size),
            ].join(" · "),
          }),
        ),
        exists ? mode : null,
      ),
      body,
      note,
      h("div", "modal-button-container", copyText, restore),
    );

    void Promise.all([
      this.backupText(backup),
      exists ? this.currentText(backup.path) : Promise.resolve(null),
    ])
      .then(([text, current]) => {
        if (request !== this.request) return;
        body.replaceChildren(this.content(text, current));
        copyText.disabled = false;
        // Restoring identical content would only add a backup.
        restore.disabled = current === text;
        copyText.addEventListener("click", () => {
          void navigator.clipboard
            ?.writeText(text)
            .then(() => notify(t("Inhalt kopiert.")))
            .catch(() => notify(t("Kopieren nicht möglich."), true));
        });
        restore.addEventListener("click", () => {
          restore.disabled = true;
          void this.restore(backup, text, exists).finally(() => {
            restore.disabled = false;
          });
        });
      })
      .catch((error) => {
        if (request !== this.request) return;
        body.replaceChildren(
          h("p", {
            class: "field-error",
            text: String(error instanceof Error ? error.message : error),
          }),
        );
      });
  }

  private content(text: string, current: string | null): Node {
    if (current === null || !this.showChanges)
      return h("pre", { class: "recovery-text", text });
    if (current === text)
      return this.empty(t("Identisch mit dem aktuellen Stand."));
    const lines = diffLines(current, text);
    if (!lines)
      return h(
        "div",
        null,
        this.empty(t("Zu viele Änderungen für eine Gegenüberstellung.")),
        h("pre", { class: "recovery-text", text }),
      );
    const legend = h(
      "div",
      "recovery-legend",
      h("span", { class: "is-remove", text: `− ${t("Aktueller Stand")}` }),
      h("span", { class: "is-add", text: `+ ${t("Diese Sicherung")}` }),
    );
    const diff = h("div", { class: "recovery-diff" });
    for (const line of collapseDiff(lines, 2))
      diff.append(
        line.type === "skip"
          ? h("div", {
              class: "recovery-diff-skip",
              text: plural(line.count, {
                one: "{count} unveränderte Zeile",
                other: "{count} unveränderte Zeilen",
              }),
            })
          : h("div", {
              class: `recovery-diff-line is-${line.type}`,
              text: `${line.type === "add" ? "+" : line.type === "remove" ? "−" : " "} ${line.text}`,
            }),
      );
    return h("div", null, legend, diff);
  }

  private async restore(
    backup: BackupEntry,
    text: string,
    exists: boolean,
  ): Promise<void> {
    try {
      let path = backup.path;
      if (backup.kind === "version" && exists) {
        await this.app.restoreVersion(path, text);
        notify(
          t("Version vom {time} wiederhergestellt.", {
            time: formatTime(backup.time),
          }),
        );
      } else {
        path = await this.app.restoreDeleted(path, text);
        notify(t("Wiederhergestellt als „{path}“.", { path }));
      }
      this.modal.close();
      await this.app.openPath(path);
    } catch (error) {
      this.app.report(error);
    }
  }
}

/** Opens the recovery dialog; with `path`, directly on that note's versions. */
export function openFileRecovery(app: App, path?: string): void {
  void new FileRecovery(app, path).open();
}
