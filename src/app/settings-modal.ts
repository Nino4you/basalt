import { backend, native } from "../backend";
import {
  basename,
  clear,
  errorMessage,
  formatHotkey,
  h,
  icon,
  trackSliderFill,
} from "../ui/dom";
import { Modal } from "../ui/modal";
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

type CoreTab =
  "general" | "editor" | "files" | "appearance" | "hotkeys" | "plugins";
/** Core pages, or `plugin:<id>:<index>` for a community plugin's setting tab. */
type TabId = CoreTab | `plugin:${string}`;

const TABS: Array<[CoreTab, string, string]> = [
  ["general", "Allgemein", "settings"],
  ["editor", "Editor", "pencil"],
  ["files", "Dateien und Links", "folder-closed"],
  ["appearance", "Darstellung", "palette"],
  ["hotkeys", "Tastenkürzel", "keyboard"],
  ["plugins", "Community-Plugins", "puzzle"],
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
  modal.modalEl.setAttribute("aria-label", "Einstellungen");
  modal.modalEl.id = "settings";
  const content = h("div", {
    class: "vertical-tab-content",
    attrs: { role: "tabpanel" },
  });
  const nav = h("div", {
    class: "vertical-tab-header",
    attrs: { role: "tablist", "aria-label": "Kategorien" },
  });
  const pageTitle = h("h2", { class: "settings-page-title" });
  const back = h(
    "button",
    {
      class: "clickable-icon settings-back-button",
      label: "Zurück",
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
              text: "Ein ruhiger Ort für vernetzte Gedanken. Lokale Markdown-Dateien, ein Rust-Kern und eine eigenständige Oberfläche.",
            }),
          ),
        ),
      );
      heading(content, "App");
      row(content, "Aktuelle Version", "Entwicklungsversion").control.append(
        h("span", { class: "setting-value", text: "0.2.0" }),
      );
      row(
        content,
        "Umgebung",
        native ? "Native App" : "Browser-Demo mit lokalem Speicher",
      ).control.append(
        h("span", {
          class: "setting-value",
          text: app.shell.environment.textContent ?? "",
        }),
      );
      row(
        content,
        "Sprache",
        "Die Oberfläche ist derzeit nur auf Deutsch verfügbar.",
      ).control.append(h("span", { class: "setting-value", text: "Deutsch" }));
      heading(content, "Vault");
      const vault = row(content, app.vault?.name ?? "Vault");
      vault.el.querySelector(".setting-item-info")!.append(
        h("div", {
          class: "setting-item-description",
          id: "settings-vault",
          text: native
            ? (app.vault?.id ?? "")
            : "Browser-Demo · nicht mit einem Ordner verbunden",
        }),
      );
      vault.control.append(
        h("button", {
          id: "settings-folder",
          text: "Ordner öffnen",
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
          "Standardansicht für neue Tabs",
          "In welcher Ansicht neue Tabs geöffnet werden.",
        ),
        "Standardansicht für neue Tabs",
        [
          ["edit", "Bearbeitungsansicht"],
          ["read", "Leseansicht"],
        ],
        settings.get("defaultReading") ? "read" : "edit",
        (value) => settings.set("defaultReading", value === "read"),
      );
      dropdown(
        row(
          content,
          "Standard-Bearbeitungsmodus",
          "Die Live-Vorschau blendet Markdown-Zeichen aus, solange der Cursor nicht dort steht. Der Quellcode-Modus zeigt sie immer.",
        ),
        "Standard-Bearbeitungsmodus",
        [
          ["live", "Live-Vorschau"],
          ["source", "Quellcode-Modus"],
        ],
        settings.get("editingMode"),
        set("editingMode"),
      );
      heading(content, "Anzeige");
      toggle(
        row(
          content,
          "Lesbare Zeilenlänge",
          "Begrenzt die maximale Zeilenlänge. Weniger Inhalt auf dem Bildschirm, aber lange Absätze lesen sich leichter.",
        ),
        "Lesbare Zeilenlänge",
        settings.get("readableLineLength"),
        set("readableLineLength"),
      );
      toggle(
        row(
          content,
          "Inline-Titel anzeigen",
          "Zeigt den Dateinamen als Titel über dem Inhalt der Notiz.",
        ),
        "Inline-Titel anzeigen",
        settings.get("inlineTitle"),
        set("inlineTitle"),
      );
      toggle(
        row(
          content,
          "Zeilennummern anzeigen",
          "Zeilennummern am Rand des Editors.",
        ),
        "Zeilennummern anzeigen",
        settings.get("lineNumbers"),
        set("lineNumbers"),
      );
      heading(content, "Verhalten");
      toggle(
        row(content, "Rechtschreibprüfung", "Nutzt die Prüfung des Systems."),
        "Rechtschreibprüfung",
        settings.get("spellcheck"),
        set("spellcheck"),
      );
      toggle(
        row(
          content,
          "Klammern automatisch schließen",
          "Ergänzt schließende Klammern und Anführungszeichen.",
        ),
        "Klammern automatisch schließen",
        settings.get("autoPair"),
        set("autoPair"),
      );
    },

    files() {
      dropdown(
        row(
          content,
          "Standard-Speicherort für neue Notizen",
          "Wo neu erstellte Notizen abgelegt werden.",
        ),
        "Standard-Speicherort für neue Notizen",
        [
          ["root", "Vault-Stammordner"],
          ["current", "Gleicher Ordner wie aktuelle Datei"],
        ],
        settings.get("newNoteLocation"),
        set("newNoteLocation"),
      );
      heading(content, "Archivierte Entwürfe");
      content.append(
        h("p", {
          class: "setting-item-description settings-paragraph",
          text: "Lokale Fassungen, die beim Laden eines geänderten Dateistands gesichert wurden.",
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
          h("p", { class: "pane-empty", text: "Keine archivierten Entwürfe." }),
        );
      for (const recovery of recoveries) {
        const item = row(
          list,
          `Archivierter Entwurf: ${basename(recovery.path)}`,
          new Date(recovery.savedAt).toLocaleString("de"),
        );
        item.control.append(
          h("button", {
            text: "Exportieren",
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
        row(content, "Grundfarbschema", "Wähle das Farbschema von Basalt."),
        "Grundfarbschema",
        [
          ["dark", "Dunkel"],
          ["light", "Hell"],
          ["system", "An System anpassen"],
        ],
        settings.get("theme"),
        set("theme"),
      );
      const accent = row(
        content,
        "Akzentfarbe",
        "Farbe für Links, Auswahl und Schaltflächen.",
      );
      const color = h("input", {
        label: "Akzentfarbe",
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
            label: "Standard wiederherstellen",
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
      heading(content, "Schrift");
      const size = row(
        content,
        "Schriftgröße",
        "Schriftgröße des Notizinhalts in Pixeln.",
      );
      const value = h("span", {
        class: "setting-slider-value",
        text: String(settings.get("fontSize")),
      });
      const slider = h("input", {
        class: "slider",
        label: "Schriftgröße",
        attrs: { type: "range", min: "12", max: "24", step: "1" },
      });
      slider.value = String(settings.get("fontSize"));
      trackSliderFill(slider);
      slider.addEventListener("input", () => {
        value.textContent = slider.value;
        settings.set("fontSize", Number(slider.value));
      });
      size.control.append(value, slider);
      heading(content, "Oberfläche");
      toggle(
        row(
          content,
          "Ribbon anzeigen",
          "Die schmale Werkzeugleiste am linken Rand.",
        ),
        "Ribbon anzeigen",
        settings.get("showRibbon"),
        set("showRibbon"),
      );
    },

    hotkeys() {
      const filter = h("input", {
        class: "settings-search-input",
        label: "Tastenkürzel filtern",
        attrs: {
          type: "search",
          placeholder: "Tastenkürzel filtern …",
          spellcheck: "false",
        },
      });
      const list = h("div", "settings-hotkey-list");
      const empty = h("p", {
        class: "pane-empty",
        text: "Keine passenden Befehle.",
      });
      empty.hidden = true;
      content.append(
        h("div", "settings-search", icon("search", 16), filter),
        list,
        empty,
      );
      const commands = app.commands
        .list()
        .sort((a, b) => a.name.localeCompare(b.name, "de"));
      for (const command of commands) {
        const item = row(list, command.name);
        item.control.append(
          command.hotkey
            ? h("kbd", {
                class: "setting-hotkey",
                text: formatHotkey(command.hotkey),
              })
            : h("span", { class: "setting-hotkey mod-empty", text: "Leer" }),
        );
      }
      heading(list, "Im Editor");
      for (const [name, hotkey] of [
        ["Fett", "Mod+B"],
        ["Kursiv", "Mod+I"],
        ["Link einfügen", "Mod+K"],
        ["Aufgabe umschalten", "Mod+L"],
        ["In aktueller Datei suchen", "Mod+F"],
        ["Rückgängig", "Mod+Z"],
      ])
        row(list, name).control.append(
          h("kbd", { class: "setting-hotkey", text: formatHotkey(hotkey) }),
        );
      filter.addEventListener("input", () => {
        const query = filter.value.trim().toLocaleLowerCase("de");
        let visible = 0;
        for (const item of list.querySelectorAll<HTMLElement>(
          ".setting-item:not(.setting-item-heading)",
        )) {
          const match =
            !query ||
            (item.textContent ?? "").toLocaleLowerCase("de").includes(query);
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
          "Die Plugin-Kompatibilität ist noch unvollständig. Basalt lädt ausschließlich ausdrücklich aktivierte Bundles aus ",
          h("code", { text: "Basalt/Plugins/<id>" }),
          "; fremder Code erhält Zugriff auf die Oberfläche.",
        ),
        h("p", {
          class: "compat-status",
          id: "compat-status",
          text: app.compatStatus,
        }),
      );
      heading(content, "Installierte Plugins");
      const bundles = h("div", { id: "plugin-bundles" });
      content.append(bundles);
      const firstTab = (id: string) =>
        plugins.find((entry) => entry.id.startsWith(`plugin:${id}:`));
      void renderBundles(app, bundles, {
        hasSettings: (id) => Boolean(firstTab(id)),
        openSettings: (id) => {
          const entry = firstTab(id);
          if (entry) show(entry.id);
        },
        changed: () => {
          plugins = pluginTabs(app);
          renderNav();
        },
      });
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
          text: `Einstellungen konnten nicht gerendert werden: ${errorMessage(error)}`,
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
      h("div", { class: "settings-nav-title", text: "Einstellungen" }),
      group(
        "Optionen",
        TABS.map(([id, title, iconId]) => navItem(id, title, iconId)),
      ),
      ...(plugins.length
        ? [
            group(
              "Community-Plugins",
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
    message("Der Plugin-Loader ist nur in der nativen App verfügbar.");
    return;
  }
  message("Suche nach lokalen Bundles …");
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
    message(`Plugin-Ordner konnte nicht gelesen werden: ${String(error)}`);
    return;
  }
  if (session !== app.compatibility) return;
  if (!listings.length) {
    message(
      "Keine Bundles gefunden. Lege ",
      h("code", { text: "Basalt/Plugins/<id>/manifest.json" }),
      " und ",
      h("code", { text: "main.js" }),
      " im Vault ab.",
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
        label: `${name} aktivieren`,
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
                ? `Plugin ${listing.id} deaktiviert.`
                : `Plugin ${listing.id} aktiviert.`;
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
      if (enabled && hooks.hasSettings(listing.id))
        control.append(
          h(
            "button",
            {
              class: "clickable-icon",
              label: `Optionen von ${name}`,
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
