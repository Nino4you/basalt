import { getLocale, languages, t } from "../i18n";
import { backend, native } from "../backend";
import { APP_VERSION } from "../version";
import {
  basename,
  clear,
  errorMessage,
  formatHotkey,
  h,
  icon,
  iconButton,
  trackSliderFill,
} from "../ui/dom";
import { confirmAction, Modal } from "../ui/modal";
import {
  listSnippets,
  listThemes,
  SNIPPET_FOLDER,
  THEME_FOLDER,
  type Appearance,
} from "./vault-styles";
import {
  cleanBackups,
  formatBytes,
  type CleanupResult,
} from "./backup-cleanup";
import { notify } from "../ui/notice";
import { eventHotkey, isAssignable, type Command } from "./commands";
import { formatDate } from "../dates";
import { templatePaths } from "./templates";
import {
  confirmUninstall,
  findUpdates,
  installFromFiles,
  openPluginCatalog,
  promptGithubInstall,
  updatePlugin,
} from "./plugin-install";
import type { App } from "./app";
import { DEFAULT_ACCENT, type Settings } from "./settings";

interface Row {
  el: HTMLElement;
  control: HTMLElement;
}

function row(parent: HTMLElement, name: string, description = ""): Row {
  const control = h("div", "setting-item-control");
  const el = h(
    "div",
    "setting-item",
    h(
      "div",
      "setting-item-info",
      h("div", { class: "setting-item-name", text: name }),
      description
        ? h("div", { class: "setting-item-description", text: description })
        : null,
    ),
    control,
  );
  parent.append(el);
  return { el, control };
}

/**
 * One command's hotkey with buttons to record a new one, remove it and go
 * back to the default. Recording takes the next key combination; Escape
 * cancels, and combinations that would type text are refused.
 */
function hotkeyRow(target: Row, app: App, command: Command): void {
  const registry = app.commands;
  const name = command.name;
  const render = (recording = false): void => {
    const hotkey = registry.hotkeyOf(command.id);
    const children: HTMLElement[] = [
      recording
        ? h("kbd", {
            class: "setting-hotkey mod-recording",
            text: t("Tastenkombination drücken …"),
          })
        : hotkey
          ? h("kbd", { class: "setting-hotkey", text: formatHotkey(hotkey) })
          : h("span", { class: "setting-hotkey mod-empty", text: t("Leer") }),
    ];
    if (!recording) {
      if (registry.isCustomized(command.id))
        children.push(
          iconButton(
            "rotate-ccw",
            t("„{name}“ auf das Standardkürzel zurücksetzen", { name }),
            () => {
              const displaced = registry.resetHotkey(command.id);
              if (displaced) moved(displaced);
              render();
            },
          ),
        );
      if (hotkey)
        children.push(
          iconButton("x", t("Tastenkürzel von „{name}“ entfernen", { name }), () => {
            registry.setHotkey(command.id, null);
            render();
          }),
        );
      const record = iconButton(
        "keyboard",
        t("Tastenkürzel für „{name}“ festlegen", { name }),
        () => {
          render(true);
          const cancel = target.control.querySelector<HTMLElement>(
            ".mod-recording",
          );
          cancel?.setAttribute("tabindex", "-1");
          cancel?.focus();
          const listen = (event: KeyboardEvent) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") return stop();
            const pressed = eventHotkey(event);
            if (!pressed) return;
            if (!isAssignable(pressed)) {
              notify(t("Bitte mit Strg, Alt oder einer F-Taste kombinieren."), true);
              return;
            }
            const displaced = registry.setHotkey(command.id, pressed);
            if (displaced) moved(displaced);
            stop();
          };
          const stop = () => {
            window.removeEventListener("keydown", listen, true);
            window.removeEventListener("pointerdown", stop, true);
            render();
            target.control.querySelector<HTMLElement>("button")?.focus();
          };
          // Capture before the modal's own Escape and the app's hotkeys.
          window.addEventListener("keydown", listen, true);
          window.addEventListener("pointerdown", stop, true);
        },
      );
      children.push(record);
    }
    target.control.replaceChildren(...children);
  };
  const moved = (displaced: Command) =>
    notify(
      t("Das Tastenkürzel wurde von „{name}“ entfernt.", { name: displaced.name }),
    );
  render();
  target.el.classList.add("mod-hotkey");
}

function heading(parent: HTMLElement, text: string): void {
  parent.append(
    h(
      "div",
      "setting-item setting-item-heading",
      h(
        "div",
        "setting-item-info",
        h("div", { class: "setting-item-name", text }),
      ),
    ),
  );
}

function toggle(
  target: Row,
  label: string,
  value: boolean,
  onChange: (value: boolean) => void,
): void {
  const input = h("input", {
    label,
    attrs: { type: "checkbox", role: "switch" },
  });
  input.checked = value;
  const box = h(
    "label",
    `checkbox-container${value ? " is-enabled" : ""}`,
    input,
  );
  input.addEventListener("change", () => {
    box.classList.toggle("is-enabled", input.checked);
    onChange(input.checked);
  });
  target.control.append(box);
  target.el.classList.add("mod-toggle");
}

function dropdown<T extends string>(
  target: Row,
  label: string,
  options: Array<[T, string]>,
  value: T,
  onChange: (value: T) => void,
): void {
  const select = h(
    "select",
    { class: "dropdown", label },
    ...options.map(([id, text]) => {
      const option = h("option", { text, attrs: { value: id } });
      option.selected = id === value;
      return option;
    }),
  );
  select.addEventListener("change", () => onChange(select.value as T));
  target.control.append(select);
}

/** A text field that applies its value when it is committed (Enter or leaving it). */
function textField(
  target: Row,
  label: string,
  value: string,
  onChange: (value: string) => void,
  placeholder = "",
): HTMLInputElement {
  const input = h("input", {
    label,
    attrs: { type: "text", placeholder, spellcheck: "false", autocomplete: "off" },
  });
  input.value = value;
  input.addEventListener("change", () => onChange(input.value.trim()));
  target.control.append(input);
  return input;
}

/** Retention of `.basalt/history` and `.basalt/trash`, with manual cleanup. */
function backupSettings(app: App, content: HTMLElement): void {
  const settings = app.settings;
  heading(content, t("Sicherungen"));
  content.append(
    h("p", {
      class: "setting-item-description settings-paragraph",
      text: t("Vor jeder Änderung und jedem Löschen sichert Basalt die Datei in .basalt/history/ und .basalt/trash/ im Vault."),
    }),
  );
  const days = (count: number) =>
    count ? t("{count} Tage", { count }) : t("Unbegrenzt");
  dropdown(
    row(
      content,
      t("Sicherungen aufbewahren"),
      t("Ältere Versionen und gelöschte Dateien werden einmal am Tag entfernt."),
    ),
    t("Sicherungen aufbewahren"),
    [7, 30, 90, 180, 365, 0].map(
      (count) => [String(count), days(count)] as [string, string],
    ),
    String(settings.get("backupMaxAgeDays")),
    (value) => settings.set("backupMaxAgeDays", Number(value)),
  );
  dropdown(
    row(
      content,
      t("Versionen pro Datei"),
      t("Nur die neuesten Versionen jeder Datei bleiben erhalten."),
    ),
    t("Versionen pro Datei"),
    [0, 10, 25, 50, 100].map(
      (count) =>
        [String(count), count ? String(count) : t("Unbegrenzt")] as [
          string,
          string,
        ],
    ),
    String(settings.get("backupMaxVersions")),
    (value) => settings.set("backupMaxVersions", Number(value)),
  );
  const usage = row(content, t("Belegter Platz"), t("Wird berechnet …"));
  const description = usage.el.querySelector(".setting-item-description")!;
  const vaultId = app.vault?.id;
  const refresh = async () => {
    if (!vaultId) return;
    const backups = await backend.backups(vaultId, true);
    const size = (kind: string) =>
      backups
        .filter((backup) => backup.kind === kind)
        .reduce((sum, backup) => sum + backup.size, 0);
    description.textContent = t(
      "{versions} Versionen ({versionSize}), {deleted} gelöschte Dateien ({deletedSize})",
      {
        versions: backups.filter((backup) => backup.kind === "version").length,
        versionSize: formatBytes(size("version"), getLocale()),
        deleted: backups.filter((backup) => backup.kind === "deleted").length,
        deletedSize: formatBytes(size("deleted"), getLocale()),
      },
    );
  };
  const failed = (error: unknown) => {
    description.textContent = "";
    app.report(error);
  };
  void refresh().catch(failed);
  const report = (result: CleanupResult) =>
    notify(
      result.removed
        ? t("{removed} Sicherungen entfernt, {size} frei.", {
            removed: result.removed,
            size: formatBytes(result.freed, getLocale()),
          })
        : t("Nichts zu entfernen."),
    );
  usage.control.append(
    h("button", {
      text: t("Jetzt aufräumen"),
      attrs: { type: "button" },
      on: {
        click: () => {
          if (!vaultId) return;
          const policy = {
            maxAgeDays: settings.get("backupMaxAgeDays"),
            maxVersions: settings.get("backupMaxVersions"),
          };
          void cleanBackups(backend, vaultId, { policy })
            .then(report)
            .then(refresh)
            .catch(failed);
        },
      },
    }),
    h("button", {
      class: "mod-warning",
      text: t("Papierkorb leeren"),
      attrs: { type: "button" },
      on: {
        click: () => {
          if (!vaultId) return;
          confirmAction({
            title: t("Papierkorb leeren"),
            text: t("Alle gelöschten Dateien in .basalt/trash/ endgültig entfernen? Das kann nicht rückgängig gemacht werden."),
            confirm: t("Endgültig löschen"),
            warning: true,
            run: async () => {
              report(await cleanBackups(backend, vaultId, { emptyTrash: true }));
              await refresh();
            },
            onError: (error) => app.report(error),
          });
        },
      },
    }),
  );
}

/** Themes and CSS snippets from Basalt/Config (Obsidian's .obsidian folder). */
function vaultStyleSettings(app: App, content: HTMLElement): void {
  const section = h("div", "vault-style-settings");
  content.append(section);
  const render = () => {
    section.replaceChildren();
    const session = app.compatibility;
    heading(section, t("Themes und CSS-Snippets"));
    if (!session) {
      section.append(
        h("p", {
          class: "setting-item-description settings-paragraph",
          text: t("Themes und CSS-Snippets aus dem Vault gibt es nur in der nativen App."),
        }),
      );
      return;
    }
    const vault = session.configVault;
    const appearance = app.appearance;
    const save = (next: Appearance) =>
      void app.setAppearance(next).then(render, (error) => {
        app.report(error);
        render();
      });
    const themes = listThemes(vault);
    dropdown(
      row(
        section,
        t("Theme"),
        t("Ordner mit theme.css unter {folder}/.", { folder: THEME_FOLDER }),
      ),
      t("Theme"),
      [
        ["", t("Basalt (Standard)")],
        ...themes.map((name) => [name, name] as [string, string]),
        ...(appearance.cssTheme && !themes.includes(appearance.cssTheme)
          ? [[appearance.cssTheme, t("{name} (fehlt)", { name: appearance.cssTheme })] as [string, string]]
          : []),
      ],
      appearance.cssTheme,
      (cssTheme) => save({ ...appearance, cssTheme }),
    );
    const snippets = listSnippets(vault);
    const actions = row(
      section,
      t("CSS-Snippets"),
      t("CSS-Dateien unter {folder}/ ändern das Aussehen. Sie werden nach dem Theme geladen.", {
        folder: SNIPPET_FOLDER,
      }),
    );
    actions.control.append(
      h(
        "button",
        {
          class: "clickable-icon",
          label: t("Neu laden"),
          attrs: { type: "button" },
          on: {
            click: () =>
              void session.configVault
                .refresh()
                .then(() => app.applyVaultStyles())
                .then(render, (error) => app.report(error)),
          },
        },
        icon("refresh-cw", 16),
      ),
    );
    if (!snippets.length)
      section.append(
        h("p", { class: "pane-empty", text: t("Keine Snippets gefunden.") }),
      );
    for (const name of snippets)
      toggle(
        row(section, name),
        t("Snippet {name}", { name }),
        appearance.enabledCssSnippets.includes(name),
        (enabled) =>
          save({
            ...appearance,
            enabledCssSnippets: enabled
              ? [...appearance.enabledCssSnippets, name]
              : appearance.enabledCssSnippets.filter((entry) => entry !== name),
          }),
      );
  };
  render();
}

type CoreTab =
  "general" | "editor" | "files" | "appearance" | "hotkeys" | "plugins";
/** Core pages, or `plugin:<id>:<index>` for a community plugin's setting tab. */
type TabId = CoreTab | `plugin:${string}`;

const TABS: Array<[CoreTab, string, string]> = [
  ["general", t("Allgemein"), "settings"],
  ["editor", t("Editor"), "pencil"],
  ["files", t("Dateien und Links"), "folder-closed"],
  ["appearance", t("Darstellung"), "palette"],
  ["hotkeys", t("Tastenkürzel"), "keyboard"],
  ["plugins", t("Community-Plugins"), "puzzle"],
];

interface PluginTab {
  id: TabId;
  title: string;
  tab: { containerEl: HTMLElement; display: () => void; hide?: () => void };
}

/** Setting tabs of enabled plugins, in the order the sidebar lists them. */
function pluginTabs(app: App): PluginTab[] {
  const session = app.compatibility;
  if (!session) return [];
  const result: PluginTab[] = [];
  for (const id of session.plugins.enabledPlugins) {
    session.services.getSettingTabs(id).forEach((value, index) => {
      const tab = value as {
        containerEl?: HTMLElement;
        display?: () => void;
        hide?: () => void;
        plugin?: { manifest?: { name?: string } };
      };
      if (!tab.containerEl || typeof tab.display !== "function") return;
      result.push({
        id: `plugin:${id}:${index}`,
        title: tab.plugin?.manifest?.name ?? id,
        tab: tab as PluginTab["tab"],
      });
    });
  }
  return result;
}

let lastTab: TabId = "general";

/**
 * Obsidian-style settings: a sidebar of grouped categories and a page of
 * setting rows. On phones the sidebar is a page of its own (`mod-nav`) and a
 * category opens as a second page with a back button.
 */
export function openSettings(app: App, initial: TabId = lastTab): void {
  const modal = new Modal("mod-settings");
  modal.modalEl.setAttribute("aria-label", t("Einstellungen"));
  modal.modalEl.id = "settings";
  const content = h("div", {
    class: "vertical-tab-content",
    attrs: { role: "tabpanel" },
  });
  const nav = h("div", {
    class: "vertical-tab-header",
    attrs: { role: "tablist", "aria-label": t("Kategorien") },
  });
  const pageTitle = h("h2", { class: "settings-page-title" });
  const back = h(
    "button",
    {
      class: "clickable-icon settings-back-button",
      label: t("Zurück"),
      attrs: { type: "button" },
      on: { click: () => showNav() },
    },
    icon("chevron-left", 22),
  );
  const settings = app.settings;
  const set =
    <K extends keyof Settings>(key: K) =>
    (value: Settings[K]) =>
      settings.set(key, value);
  let plugins = pluginTabs(app);
  let shownPlugin: PluginTab | null = null;

  const releasePlugin = () => {
    const previous = shownPlugin;
    shownPlugin = null;
    try {
      previous?.tab.hide?.();
    } catch (error) {
      console.warn(
        "Plugin-Einstellungen konnten nicht geschlossen werden",
        error,
      );
    }
  };

  const renderers: Record<CoreTab, () => void> = {
    general() {
      content.append(
        h(
          "div",
          "settings-about",
          h("img", {
            attrs: { src: "/basalt.svg", alt: "", width: "48", height: "48" },
          }),
          h(
            "div",
            "settings-about-text",
            h("div", { class: "settings-about-name", text: "Basalt" }),
            h("div", {
              class: "setting-item-description",
              text: t("Ein ruhiger Ort für vernetzte Gedanken. Lokale Markdown-Dateien, ein Rust-Kern und eine eigenständige Oberfläche."),
            }),
          ),
        ),
      );
      heading(content, t("App"));
      const version = row(
        content,
        t("Aktuelle Version"),
        app.availableUpdate
          ? t("Basalt {version} ist verfügbar.", { version: app.availableUpdate.version })
          : "",
      );
      version.control.append(
        h("span", { class: "setting-value", text: APP_VERSION }),
      );
      const showUpdate = () => {
        const update = app.availableUpdate;
        version.control.querySelector(".mod-update")?.remove();
        if (!update) return;
        version.control.append(
          h("button", {
            class: "mod-cta mod-update",
            text: t("Herunterladen"),
            attrs: { type: "button" },
            on: { click: () => app.openExternal(update.url) },
          }),
        );
      };
      showUpdate();
      const checks = row(
        content,
        t("Automatisch nach Updates suchen"),
        t("Fragt einmal am Tag bei GitHub nach einer neuen Version. Dabei wird nichts über dich oder deine Notizen gesendet. Installiert wird nie automatisch."),
      );
      checks.control.append(
        h("button", {
          text: t("Jetzt prüfen"),
          attrs: { type: "button" },
          on: {
            click: (event) => {
              const button = event.currentTarget as HTMLButtonElement;
              button.disabled = true;
              void app
                .checkForUpdates(true)
                .then(showUpdate, (error) => app.report(error))
                .finally(() => (button.disabled = false));
            },
          },
        }),
      );
      toggle(
        checks,
        t("Automatisch nach Updates suchen"),
        settings.get("updateCheck"),
        set("updateCheck"),
      );
      row(
        content,
        t("Umgebung"),
        native ? t("Native App") : t("Browser-Demo mit lokalem Speicher"),
      ).control.append(
        h("span", {
          class: "setting-value",
          text: app.shell.environment.textContent ?? "",
        }),
      );
      const language = row(
        content,
        t("Sprache"),
        t("Die Oberfläche wird nach dem Speichern offener Änderungen neu geladen."),
      );
      dropdown(
        language,
        t("Sprache"),
        languages.map(({ id, name }) => [id, name]),
        settings.get("language"),
        (value) => {
          const select = language.control.querySelector("select")!;
          select.disabled = true;
          void app.changeLanguage(value).finally(() => {
            select.value = settings.get("language");
            select.disabled = false;
          });
        },
      );
      heading(content, t("Vault"));
      const vault = row(content, app.vault?.name ?? t("Vault"));
      vault.el.querySelector(".setting-item-info")!.append(
        h("div", {
          class: "setting-item-description",
          id: "settings-vault",
          text: native
            ? (app.vault?.id ?? "")
            : t("Browser-Demo · nicht mit einem Ordner verbunden"),
        }),
      );
      vault.control.append(
        h("button", {
          id: "settings-folder",
          text: t("Ordner öffnen"),
          attrs: { type: "button" },
          on: {
            click: () => {
              modal.close();
              void app.chooseVault();
            },
          },
        }),
      );
    },

    editor() {
      dropdown(
        row(
          content,
          t("Standardansicht für neue Tabs"),
          t("In welcher Ansicht neue Tabs geöffnet werden."),
        ),
        t("Standardansicht für neue Tabs"),
        [
          ["edit", t("Bearbeitungsansicht")],
          ["read", t("Leseansicht")],
        ],
        settings.get("defaultReading") ? "read" : "edit",
        (value) => settings.set("defaultReading", value === "read"),
      );
      dropdown(
        row(
          content,
          t("Standard-Bearbeitungsmodus"),
          t("Die Live-Vorschau blendet Markdown-Zeichen aus, solange der Cursor nicht dort steht. Der Quellcode-Modus zeigt sie immer."),
        ),
        t("Standard-Bearbeitungsmodus"),
        [
          ["live", t("Live-Vorschau")],
          ["source", t("Quellcode-Modus")],
        ],
        settings.get("editingMode"),
        set("editingMode"),
      );
      heading(content, t("Anzeige"));
      toggle(
        row(
          content,
          t("Lesbare Zeilenlänge"),
          t("Begrenzt die maximale Zeilenlänge. Weniger Inhalt auf dem Bildschirm, aber lange Absätze lesen sich leichter."),
        ),
        t("Lesbare Zeilenlänge"),
        settings.get("readableLineLength"),
        set("readableLineLength"),
      );
      toggle(
        row(
          content,
          t("Inline-Titel anzeigen"),
          t("Zeigt den Dateinamen als Titel über dem Inhalt der Notiz."),
        ),
        t("Inline-Titel anzeigen"),
        settings.get("inlineTitle"),
        set("inlineTitle"),
      );
      toggle(
        row(
          content,
          t("Zeilennummern anzeigen"),
          t("Zeilennummern am Rand des Editors."),
        ),
        t("Zeilennummern anzeigen"),
        settings.get("lineNumbers"),
        set("lineNumbers"),
      );
      toggle(
        row(
          content,
          t("Eigenschaften im Dokument"),
          t("Zeigt das Frontmatter in der Live-Vorschau als bearbeitbare Felder statt als YAML."),
        ),
        t("Eigenschaften im Dokument"),
        settings.get("propertiesInDocument"),
        set("propertiesInDocument"),
      );
      toggle(
        row(
          content,
          t("Einklappen"),
          t("Pfeile am Rand klappen Abschnitte unter Überschriften, Listen und Blöcke ein."),
        ),
        t("Einklappen"),
        settings.get("folding"),
        set("folding"),
      );
      heading(content, t("Verhalten"));
      toggle(
        row(content, t("Rechtschreibprüfung"), t("Nutzt die Prüfung des Systems.")),
        t("Rechtschreibprüfung"),
        settings.get("spellcheck"),
        set("spellcheck"),
      );
      toggle(
        row(
          content,
          t("Klammern automatisch schließen"),
          t("Ergänzt schließende Klammern und Anführungszeichen."),
        ),
        t("Klammern automatisch schließen"),
        settings.get("autoPair"),
        set("autoPair"),
      );
    },

    files() {
      dropdown(
        row(
          content,
          t("Standard-Speicherort für neue Notizen"),
          t("Wo neu erstellte Notizen abgelegt werden."),
        ),
        t("Standard-Speicherort für neue Notizen"),
        [
          ["root", t("Vault-Stammordner")],
          ["current", t("Gleicher Ordner wie aktuelle Datei")],
        ],
        settings.get("newNoteLocation"),
        set("newNoteLocation"),
      );
      toggle(
        row(
          content,
          t("Interne Links automatisch aktualisieren"),
          t("Passt Links an, wenn eine Notiz oder Canvas umbenannt oder verschoben wird. Jede geänderte Datei wird vorher gesichert."),
        ),
        t("Interne Links automatisch aktualisieren"),
        settings.get("updateLinks"),
        set("updateLinks"),
      );
      textField(
        row(
          content,
          t("Speicherort für neue Anhänge"),
          t("Für eingefügte und hineingezogene Dateien. „/“ ist der Vault-Stammordner, „./“ der Ordner der Notiz, „./Anhänge“ ein Unterordner daneben, sonst ein Ordner im Vault."),
        ),
        t("Speicherort für neue Anhänge"),
        settings.get("attachmentFolder"),
        (value) => settings.set("attachmentFolder", value || "/"),
        "/",
      );
      heading(content, t("Vorlagen"));
      textField(
        row(
          content,
          t("Vorlagenordner"),
          t("Notizen in diesem Ordner stehen unter „Vorlage einfügen“ zur Wahl. Leer: jeder Ordner namens „_templates“."),
        ),
        t("Vorlagenordner"),
        settings.get("templateFolder"),
        set("templateFolder"),
        "_templates",
      );
      heading(content, t("Tagesnotizen"));
      textField(
        row(
          content,
          t("Ordner für neue Tagesnotizen"),
          t("Leer lassen für den Vault-Stammordner. Fehlende Ordner werden angelegt."),
        ),
        t("Ordner für neue Tagesnotizen"),
        settings.get("dailyFolder"),
        set("dailyFolder"),
        t("Tagebuch"),
      );
      const formatRow = row(
        content,
        t("Datumsformat"),
        t("Moment.js-Format, Text in [eckigen Klammern] bleibt wörtlich."),
      );
      const example = h("div", { class: "setting-item-description" });
      formatRow.el.querySelector(".setting-item-info")!.append(example);
      const showExample = (pattern: string) => {
        example.textContent = t("Beispiel: {name}", {
          name: formatDate(new Date(), pattern || "YYYY-MM-DD", getLocale()),
        });
      };
      const formatInput = textField(
        formatRow,
        t("Datumsformat"),
        settings.get("dailyFormat"),
        (value) => settings.set("dailyFormat", value || "YYYY-MM-DD"),
        "YYYY-MM-DD",
      );
      formatInput.addEventListener("input", () => showExample(formatInput.value.trim()));
      showExample(settings.get("dailyFormat"));
      dropdown(
        row(
          content,
          t("Vorlage"),
          t("Eine Notiz aus dem Vorlagenordner. {date} und {title} werden ersetzt.", {
            date: "{{date}}",
            title: "{{title}}",
          }),
        ),
        t("Vorlage"),
        [
          ["", t("Keine Vorlage")],
          ...templatePaths(app.index.files, settings.get("templateFolder")).map(
            (path) => [path, path] as [string, string],
          ),
        ],
        settings.get("dailyTemplate"),
        set("dailyTemplate"),
      );
      backupSettings(app, content);
      heading(content, t("Archivierte Entwürfe"));
      content.append(
        h("p", {
          class: "setting-item-description settings-paragraph",
          text: t("Lokale Fassungen, die beim Laden eines geänderten Dateistands gesichert wurden."),
        }),
      );
      const list = h("div", { id: "recovery-list" });
      content.append(list);
      let recoveries: ReturnType<NonNullable<App["store"]>["recoveries"]> = [];
      try {
        recoveries = app.store?.recoveries() ?? [];
      } catch (error) {
        app.report(error);
      }
      if (!recoveries.length)
        list.append(
          h("p", { class: "pane-empty", text: t("Keine archivierten Entwürfe.") }),
        );
      for (const recovery of recoveries) {
        const item = row(
          list,
          t("Archivierter Entwurf: {name}", { name: basename(recovery.path) }),
          new Date(recovery.savedAt).toLocaleString(getLocale()),
        );
        item.control.append(
          h("button", {
            text: t("Exportieren"),
            attrs: { type: "button" },
            on: {
              click: () =>
                void backend
                  .export(recovery.path, recovery.text)
                  .catch((error) => app.report(error)),
            },
          }),
        );
      }
    },

    appearance() {
      dropdown(
        row(content, t("Grundfarbschema"), t("Wähle das Farbschema von Basalt.")),
        t("Grundfarbschema"),
        [
          ["dark", t("Dunkel")],
          ["light", t("Hell")],
          ["system", t("An System anpassen")],
        ],
        settings.get("theme"),
        set("theme"),
      );
      const accent = row(
        content,
        t("Akzentfarbe"),
        t("Farbe für Links, Auswahl und Schaltflächen."),
      );
      const color = h("input", {
        label: t("Akzentfarbe"),
        attrs: { type: "color" },
      });
      color.value = settings.get("accent");
      color.addEventListener("input", () =>
        settings.set("accent", color.value),
      );
      accent.control.append(
        h(
          "button",
          {
            class: "clickable-icon",
            label: t("Standard wiederherstellen"),
            attrs: { type: "button" },
            on: {
              click: () => {
                settings.set("accent", DEFAULT_ACCENT);
                color.value = DEFAULT_ACCENT;
              },
            },
          },
          icon("rotate-ccw", 16),
        ),
        color,
      );
      heading(content, t("Schrift"));
      const size = row(
        content,
        t("Schriftgröße"),
        t("Schriftgröße des Notizinhalts in Pixeln."),
      );
      const value = h("span", {
        class: "setting-slider-value",
        text: String(settings.get("fontSize")),
      });
      const slider = h("input", {
        class: "slider",
        label: t("Schriftgröße"),
        attrs: { type: "range", min: "12", max: "24", step: "1" },
      });
      slider.value = String(settings.get("fontSize"));
      trackSliderFill(slider);
      slider.addEventListener("input", () => {
        value.textContent = slider.value;
        settings.set("fontSize", Number(slider.value));
      });
      size.control.append(value, slider);
      vaultStyleSettings(app, content);
      heading(content, t("Oberfläche"));
      toggle(
        row(
          content,
          t("Ribbon anzeigen"),
          t("Die schmale Werkzeugleiste am linken Rand."),
        ),
        t("Ribbon anzeigen"),
        settings.get("showRibbon"),
        set("showRibbon"),
      );
    },

    hotkeys() {
      const filter = h("input", {
        class: "settings-search-input",
        label: t("Tastenkürzel filtern"),
        attrs: {
          type: "search",
          placeholder: t("Tastenkürzel filtern …"),
          spellcheck: "false",
        },
      });
      const list = h("div", "settings-hotkey-list");
      const empty = h("p", {
        class: "pane-empty",
        text: t("Keine passenden Befehle."),
      });
      empty.hidden = true;
      content.append(
        h("div", "settings-search", icon("search", 16), filter),
        list,
        empty,
      );
      const commands = app.commands
        .list()
        .sort((a, b) => a.name.localeCompare(b.name, getLocale()));
      for (const command of commands)
        hotkeyRow(row(list, command.name), app, command);
      heading(list, t("Im Editor"));
      for (const [name, hotkey] of [
        [t("Fett"), "Mod+B"],
        [t("Kursiv"), "Mod+I"],
        [t("Link einfügen"), "Mod+K"],
        [t("Aufgabe umschalten"), "Mod+L"],
        [t("In aktueller Datei suchen"), "Mod+F"],
        [t("Rückgängig"), "Mod+Z"],
      ])
        row(list, name).control.append(
          h("kbd", { class: "setting-hotkey", text: formatHotkey(hotkey) }),
        );
      filter.addEventListener("input", () => {
        const query = filter.value.trim().toLocaleLowerCase(getLocale());
        let visible = 0;
        for (const item of list.querySelectorAll<HTMLElement>(
          ".setting-item:not(.setting-item-heading)",
        )) {
          const match =
            !query ||
            (item.textContent ?? "").toLocaleLowerCase(getLocale()).includes(query);
          item.hidden = !match;
          if (match) visible++;
        }
        for (const title of list.querySelectorAll<HTMLElement>(
          ".setting-item-heading",
        ))
          title.hidden = Boolean(query);
        empty.hidden = visible > 0;
      });
    },

    plugins() {
      content.append(
        h(
          "p",
          "settings-note",
          t("Die Plugin-Kompatibilität ist noch unvollständig. Basalt lädt ausschließlich ausdrücklich aktivierte Bundles aus "),
          h("code", { text: "Basalt/Plugins/<id>" }),
          t("; fremder Code erhält Zugriff auf die Oberfläche."),
        ),
        h("p", {
          class: "compat-status",
          id: "compat-status",
          text: app.compatStatus,
        }),
      );
      const bundles = h("div", { id: "plugin-bundles" });
      const firstTab = (id: string) =>
        plugins.find((entry) => entry.id.startsWith(`plugin:${id}:`));
      const hooks: BundleHooks = {
        hasSettings: (id) => Boolean(firstTab(id)),
        openSettings: (id) => {
          const entry = firstTab(id);
          if (entry) show(entry.id);
        },
        changed: () => {
          plugins = pluginTabs(app);
          renderNav();
        },
        updates: new Map(),
      };
      const rerender = () => {
        hooks.changed();
        void renderBundles(app, bundles, hooks);
      };
      const filePicker = h("input", {
        attrs: {
          type: "file",
          multiple: true,
          accept: ".json,.js,.css",
          hidden: true,
          "aria-label": t("Plugin-Dateien auswählen"),
        },
      });
      filePicker.addEventListener("change", () => {
        const files = [...(filePicker.files ?? [])];
        filePicker.value = "";
        if (files.length) void installFromFiles(app, files, rerender);
      });
      const nativeOnly = !app.compatibility;
      const checkUpdates = h("button", {
        text: t("Nach Updates suchen"),
        attrs: { type: "button", disabled: nativeOnly },
      });
      checkUpdates.addEventListener("click", () => {
        checkUpdates.disabled = true;
        checkUpdates.textContent = t("Wird geprüft …");
        void findUpdates(app)
          .then((updates) => {
            hooks.updates = updates;
            const status = document.getElementById("compat-status");
            if (status)
              status.textContent = updates.size
                ? t("Updates verfügbar: {count}", { count: updates.size })
                : t("Alle Plugins sind aktuell.");
            void renderBundles(app, bundles, hooks);
          })
          .catch((error) => app.report(error))
          .finally(() => {
            checkUpdates.disabled = false;
            checkUpdates.textContent = t("Nach Updates suchen");
          });
      });
      content.append(
        h(
          "div",
          "plugin-actions",
          h(
            "button",
            {
              class: "mod-cta",
              attrs: { type: "button" },
              on: { click: () => openPluginCatalog(app, rerender) },
            },
            icon("search", 16),
            t("Durchsuchen"),
          ),
          h(
            "button",
            {
              attrs: { type: "button", disabled: nativeOnly },
              on: { click: () => promptGithubInstall(app, rerender) },
            },
            icon("download", 16),
            t("Von GitHub"),
          ),
          h(
            "button",
            {
              attrs: { type: "button", disabled: nativeOnly },
              on: { click: () => filePicker.click() },
            },
            icon("file-plus", 16),
            t("Aus Dateien"),
          ),
          checkUpdates,
          filePicker,
        ),
      );
      heading(content, t("Installierte Plugins"));
      content.append(bundles);
      void renderBundles(app, bundles, hooks);
    },
  };

  const renderPlugin = (entry: PluginTab) => {
    shownPlugin = entry;
    const section = h("div", "plugin-settings-tab");
    section.append(entry.tab.containerEl);
    content.append(section);
    try {
      entry.tab.hide?.();
      entry.tab.display();
    } catch (error) {
      section.append(
        h("p", {
          class: "compat-status",
          text: t("Einstellungen konnten nicht gerendert werden: {error}", { error: errorMessage(error) }),
        }),
      );
    }
  };

  const titleOf = (id: TabId) =>
    TABS.find(([tab]) => tab === id)?.[1] ??
    plugins.find((entry) => entry.id === id)?.title ??
    "";

  let current: TabId = "general";
  const markActive = () => {
    for (const button of nav.querySelectorAll<HTMLElement>(
      ".vertical-tab-nav-item",
    )) {
      const selected = button.dataset.tab === current;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected) content.setAttribute("aria-labelledby", button.id);
    }
  };

  const show = (requested: TabId) => {
    const plugin = plugins.find((entry) => entry.id === requested);
    // A plugin disabled since the last visit falls back to the plugin list.
    const id: TabId =
      requested.startsWith("plugin:") && !plugin ? "plugins" : requested;
    releasePlugin();
    current = id;
    lastTab = id;
    markActive();
    clear(content);
    content.scrollTop = 0;
    content.dataset.tab = id;
    pageTitle.textContent = titleOf(id);
    if (plugin) renderPlugin(plugin);
    else renderers[id as CoreTab]();
    modal.modalEl.classList.remove("mod-nav");
  };

  function showNav() {
    modal.modalEl.classList.add("mod-nav");
    nav.querySelector<HTMLElement>(".vertical-tab-nav-item.is-active")?.focus();
  }

  const navItem = (id: TabId, title: string, iconId: string) =>
    h(
      "button",
      {
        class: "vertical-tab-nav-item",
        id: `settings-tab-${id.replace(/[^\w-]/g, "-")}`,
        attrs: { type: "button", role: "tab" },
        data: { tab: id },
        on: {
          click: () => {
            show(id);
            // Phones swap pages: move focus onto the new page.
            if (back.offsetParent) back.focus();
          },
        },
      },
      h("span", "vertical-tab-nav-item-icon", icon(iconId, 18)),
      h("span", { class: "vertical-tab-nav-item-title", text: title }),
      h("span", "vertical-tab-nav-item-chevron", icon("chevron-right", 16)),
    );

  const group = (title: string, items: HTMLElement[]) =>
    h(
      "div",
      "vertical-tab-header-group",
      h("div", { class: "vertical-tab-header-group-title", text: title }),
      h("div", "vertical-tab-header-group-items", ...items),
    );

  function renderNav() {
    nav.replaceChildren(
      h("div", { class: "settings-nav-title", text: t("Einstellungen") }),
      group(
        t("Optionen"),
        TABS.map(([id, title, iconId]) => navItem(id, title, iconId)),
      ),
      ...(plugins.length
        ? [
            group(
              t("Community-Plugins"),
              plugins.map((entry) => navItem(entry.id, entry.title, "plug")),
            ),
          ]
        : []),
    );
    markActive();
  }

  nav.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [
      ...nav.querySelectorAll<HTMLElement>(".vertical-tab-nav-item"),
    ];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    event.preventDefault();
    items[next]?.focus();
  });

  renderNav();
  modal.contentEl.append(
    nav,
    h(
      "div",
      "vertical-tab-content-container",
      h("div", "settings-page-header", back, pageTitle),
      content,
    ),
  );
  modal.titleEl.remove();
  modal.closeButton.dataset.close = "settings";
  modal.onClose = releasePlugin;
  show(initial);
  // Phones start on the category list, like Obsidian's mobile app.
  modal.modalEl.classList.add("mod-nav");
  modal.open();
}

interface BundleHooks {
  hasSettings: (id: string) => boolean;
  openSettings: (id: string) => void;
  changed: () => void;
  /** Newer releases found by "Check for updates", by plugin id. */
  updates: Map<string, { repo: string; version: string }>;
}

async function renderBundles(
  app: App,
  container: HTMLElement,
  hooks: BundleHooks,
): Promise<void> {
  const session = app.compatibility;
  const message = (...children: Array<Node | string>) =>
    container.replaceChildren(h("p", "compat-status", ...children));
  if (!session) {
    message(t("Der Plugin-Loader ist nur in der nativen App verfügbar."));
    return;
  }
  message(t("Suche nach lokalen Bundles …"));
  try {
    await session.refresh();
  } catch (error) {
    console.warn("Plugin-Ordner konnte nicht aktualisiert werden", error);
  }
  if (session !== app.compatibility) return;
  let listings;
  try {
    listings = await session.bundleHost.list();
  } catch (error) {
    message(t("Plugin-Ordner konnte nicht gelesen werden: {error}", { error: String(error) }));
    return;
  }
  if (session !== app.compatibility) return;
  if (!listings.length) {
    message(
      t("Keine Bundles gefunden. Lege "),
      h("code", { text: "Basalt/Plugins/<id>/manifest.json" }),
      t(" und "),
      h("code", { text: "main.js" }),
      t(" im Vault ab."),
    );
    return;
  }
  container.replaceChildren(
    ...listings.map((listing) => {
      const enabled = session.bundleHost.isEnabled(listing.id);
      const failure = listing.error ?? app.pluginErrors.get(listing.id);
      const name = listing.manifest?.name ?? listing.id;
      const meta = h("div", {
        class: "setting-item-description",
        text: `Version ${listing.manifest?.version ?? "?"} · ${listing.id}`,
      });
      const detail = h("div", {
        class: "setting-item-description plugin-error",
        text: failure ?? "",
      });
      detail.hidden = !failure;
      const input = h("input", {
        label: t("{name} aktivieren", { name }),
        // Broken manifests must not prevent unloading an already-running plugin.
        attrs: {
          type: "checkbox",
          role: "switch",
          disabled: !enabled && listing.error !== null,
        },
      });
      input.checked = enabled;
      const box = h(
        "label",
        `checkbox-container${enabled ? " is-enabled" : ""}`,
        input,
      );
      input.addEventListener("change", () => {
        box.classList.toggle("is-enabled", input.checked);
        void (async () => {
          input.disabled = true;
          try {
            if (enabled) {
              app.releasePluginUi();
              await session.bundleHost.disable(listing.id);
            } else await session.bundleHost.enable(listing.id);
            if (session !== app.compatibility) return;
            app.pluginErrors.delete(listing.id);
            session.saveEnabledPlugins();
            const status = document.getElementById("compat-status");
            if (status)
              status.textContent = enabled
                ? t("Plugin {id} deaktiviert.", { id: listing.id })
                : t("Plugin {id} aktiviert.", { id: listing.id });
          } catch (error) {
            if (session !== app.compatibility) return;
            app.pluginErrors.set(listing.id, errorMessage(error));
            detail.textContent = errorMessage(error);
            detail.hidden = false;
            app.report(error);
          } finally {
            if (session === app.compatibility) {
              app.refreshPluginUi();
              hooks.changed();
              await renderBundles(app, container, hooks);
            }
          }
        })();
      });
      const control = h("div", "setting-item-control");
      const update = hooks.updates.get(listing.id);
      if (update)
        control.append(
          h("button", {
            class: "mod-cta",
            text: t("Auf {version} aktualisieren", { version: update.version }),
            attrs: { type: "button" },
            on: {
              click: (event) => {
                const button = event.currentTarget as HTMLButtonElement;
                button.disabled = true;
                void updatePlugin(app, listing.id, update.repo, () => {
                  hooks.updates.delete(listing.id);
                  hooks.changed();
                })
                  .catch((error) => app.report(error))
                  .finally(() => void renderBundles(app, container, hooks));
              },
            },
          }),
        );
      control.append(
        h(
          "button",
          {
            class: "clickable-icon",
            label: t("{name} deinstallieren", { name }),
            attrs: { type: "button" },
            on: {
              click: () =>
                confirmUninstall(app, listing.id, name, () => {
                  hooks.updates.delete(listing.id);
                  hooks.changed();
                  void renderBundles(app, container, hooks);
                }),
            },
          },
          icon("trash-2", 18),
        ),
      );
      if (enabled && hooks.hasSettings(listing.id))
        control.append(
          h(
            "button",
            {
              class: "clickable-icon",
              label: t("Optionen von {name}", { name }),
              attrs: { type: "button" },
              on: { click: () => hooks.openSettings(listing.id) },
            },
            icon("settings", 18),
          ),
        );
      control.append(box);
      return h(
        "div",
        `setting-item mod-toggle plugin-card${failure ? " mod-error" : ""}`,
        h(
          "div",
          "setting-item-info",
          h("div", { class: "setting-item-name", text: name }),
          meta,
          detail,
        ),
        control,
      );
    }),
  );
}
