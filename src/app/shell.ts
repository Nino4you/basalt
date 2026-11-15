import { t } from "../i18n";
import { h, icon } from "../ui/dom";
import { DOCK_AREAS, type DockArea, type PanelSpec } from "./dock";

/** Every dockable side panel with its default area. */
export const PANELS = [
  { id: "files", label: t("Dateiexplorer"), icon: "folder-closed", area: "left" },
  { id: "search", label: t("Suche"), icon: "search", area: "left" },
  { id: "bookmarks", label: t("Lesezeichen"), icon: "bookmark", area: "left" },
  { id: "backlinks", label: t("Rückverweise"), icon: "link", area: "right" },
  {
    id: "outgoing",
    label: t("Ausgehende Links"),
    icon: "arrow-up-right",
    area: "right",
  },
  { id: "tags", label: t("Tags"), icon: "tags", area: "right" },
  { id: "outline", label: t("Gliederung"), icon: "list", area: "right" },
  { id: "graph", label: t("Lokaler Graph"), icon: "waypoints", area: "right" },
] as const satisfies readonly PanelSpec[];

export type PanelId = (typeof PANELS)[number]["id"];
/** A sidebar view that a plugin opened (`plugin:<view type>`). */
export type PluginPanelId = `plugin:${string}`;
export type DockPanelId = PanelId | PluginPanelId;

export const isPluginPanel = (id: string): id is PluginPanelId =>
  id.startsWith("plugin:");

export const AREA_LABELS: Record<DockArea, string> = {
  left: t("Linke Seitenleiste"),
  "left-bottom": t("Links unten"),
  right: t("Rechte Seitenleiste"),
  bottom: t("Unterer Bereich"),
};

/** Button that runs a registered command; label and hotkey double as tooltip. */
function commandButton(
  command: string,
  iconId: string,
  label: string,
  extra = "",
  tooltip: "bottom" | "right" | "top" = "bottom",
): HTMLButtonElement {
  return h(
    "button",
    {
      class: `clickable-icon${extra ? ` ${extra}` : ""}`,
      label,
      attrs: { type: "button" },
      data: { command, tooltipPosition: tooltip },
    },
    icon(iconId),
  );
}

/** Tab header of a dockable panel; it is moved between dock areas. */
export function panelTab(spec: PanelSpec): HTMLButtonElement {
  return h(
    "button",
    {
      class: "clickable-icon workspace-tab-header mod-dock",
      label: spec.label,
      attrs: {
        type: "button",
        role: "tab",
        "aria-selected": "false",
        draggable: "true",
      },
      data: { panel: spec.id },
    },
    icon(spec.icon),
  );
}

export function pane(spec: PanelSpec): HTMLElement {
  return h("div", {
    class: "workspace-leaf-content",
    label: spec.label,
    attrs: { role: "tabpanel", hidden: true },
    data: { pane: spec.id },
  });
}

/** Tab strip plus content box of one dock area. */
function dockSlot(area: DockArea) {
  const tabs = h("div", {
    class: "workspace-tab-header-container mod-dock-header",
    attrs: { role: "tablist" },
    label: t("Ansichten: {area}", { area: AREA_LABELS[area] }),
    data: { dockArea: area },
  });
  // Lists the closed panels; only shown while there are any.
  const add = h(
    "button",
    {
      class: "clickable-icon dock-add-panel",
      label: t("Geschlossene Ansicht öffnen"),
      attrs: { type: "button", hidden: true },
      data: { tooltipPosition: "bottom" },
    },
    icon("plus"),
  );
  const empty = h("div", {
    class: "dock-empty",
    text: t("Ziehe eine Ansicht hierher oder verschiebe sie über ihr Kontextmenü."),
  });
  const content = h(
    "div",
    { class: "workspace-tab-container", data: { dockArea: area } },
    empty,
  );
  return { tabs, content, empty, add };
}

/** Tab strip and frame of one editor group; the views are placed by the app. */
export function buildGroup(id: number) {
  const tabList = h("div", {
    class: "workspace-tab-header-container-inner",
    attrs: { role: "tablist" },
  });
  const spacer = h("div", "workspace-tab-header-spacer");
  const strip = h(
    "div",
    "workspace-tab-header-container mod-root",
    tabList,
    commandButton(
      "new-tab",
      "plus",
      t("Neuer Tab"),
      "workspace-tab-header-new-tab",
    ),
    spacer,
  );
  const el = h(
    "div",
    { class: "workspace-group", data: { group: String(id) } },
    strip,
  );
  return { el, strip, tabList, spacer };
}

export function buildShell(root: HTMLElement) {
  const pluginRibbon = h("div", {
    class: "side-dock-plugins",
    id: "plugin-ribbon",
  });
  // Tablets turn the ribbon into a navigation rail: a new-note button and
  // one labelled button per left-sidebar view (filled in by the app).
  const railPanels = h("div", {
    class: "side-dock-panels",
    label: t("Ansichten"),
    attrs: { role: "group" },
  });
  const ribbon = h(
    "nav",
    { class: "workspace-ribbon side-dock-ribbon mod-left", label: t("Werkzeuge") },
    commandButton(
      "toggle-left-sidebar",
      "panel-left",
      t("Linke Seitenleiste umschalten"),
      "sidebar-toggle-button mod-left",
      "right",
    ),
    commandButton("new-note", "plus", t("Neue Notiz"), "rail-fab", "right"),
    railPanels,
    h(
      "div",
      "side-dock-actions",
      commandButton(
        "quick-switcher",
        "file-search",
        t("Schnellauswahl öffnen"),
        "",
        "right",
      ),
      commandButton(
        "daily-note",
        "calendar",
        t("Heutige Tagesnotiz öffnen"),
        "",
        "right",
      ),
      commandButton(
        "command-palette",
        "terminal",
        t("Befehlspalette öffnen"),
        "",
        "right",
      ),
      commandButton(
        "open-graph",
        "git-fork",
        t("Graphansicht öffnen"),
        "",
        "right",
      ),
      pluginRibbon,
    ),
    h(
      "div",
      "side-dock-settings",
      commandButton(
        "toggle-theme",
        "sun-moon",
        t("Farbschema wechseln"),
        "",
        "right",
      ),
      commandButton("settings", "settings", t("Einstellungen"), "", "right"),
    ),
  );

  const panes = Object.fromEntries(
    PANELS.map((spec) => [spec.id, pane(spec)]),
  ) as Record<PanelId, HTMLElement>;
  const panelTabs = Object.fromEntries(
    PANELS.map((spec) => [spec.id, panelTab(spec)]),
  ) as Record<PanelId, HTMLButtonElement>;
  const docks = Object.fromEntries(
    DOCK_AREAS.map((area) => [area, dockSlot(area)]),
  ) as Record<DockArea, ReturnType<typeof dockSlot>>;
  const vaultName = h("span", {
    class: "workspace-drawer-vault-name",
    id: "vault-name",
  });
  const leftBottomHandle = h("div", {
    class: "workspace-resize-handle mod-left-bottom",
    label: t("Höhe links unten"),
    attrs: { role: "separator", "aria-orientation": "horizontal", tabindex: "0" },
  });
  const leftBottomSplit = h(
    "section",
    { class: "workspace-left-bottom", id: "left-bottom-split", label: AREA_LABELS["left-bottom"] },
    docks["left-bottom"].tabs,
    docks["left-bottom"].content,
  );
  docks["left-bottom"].empty.textContent = t("Ansicht hier ablegen");
  const leftSplit = h(
    "aside",
    {
      class: "workspace-split mod-left-split",
      id: "left-split",
      label: t("Linke Seitenleiste"),
    },
    h(
      "div",
      "workspace-split-inner",
      docks.left.tabs,
      docks.left.content,
      leftBottomHandle,
      leftBottomSplit,
      h(
        "div",
        "workspace-sidedock-vault-profile",
        h(
          "button",
          {
            class: "workspace-drawer-vault-switcher",
            id: "choose-vault",
            label: t("Vault wechseln"),
            attrs: { type: "button" },
            data: { command: "open-vault" },
          },
          vaultName,
          icon("chevrons-up-down", 14),
        ),
        commandButton(
          "settings",
          "settings",
          t("Einstellungen"),
          "mobile-only",
          "top",
        ),
      ),
    ),
  );

  const breadcrumb = h("div", "view-header-breadcrumb");
  const title = h("div", { class: "view-header-title", id: "tab-name" });
  const modeButton = commandButton(
    "toggle-reading",
    "book-open",
    t("Leseansicht"),
  );
  // Shown on touch screens; elsewhere the command and its menu entry do it.
  const focusButton = commandButton(
    "toggle-focus-mode",
    "maximize-2",
    t("Fokusmodus"),
    "focus-mode-button",
  );
  // Leaves focus mode, the only control it keeps besides the note.
  const focusExit = h(
    "button",
    {
      class: "clickable-icon focus-mode-exit",
      label: t("Fokusmodus beenden"),
      attrs: { type: "button" },
      data: { command: "toggle-focus-mode", tooltipPosition: "left" },
    },
    icon("minimize-2"),
  );
  const moreButton = h(
    "button",
    {
      class: "clickable-icon",
      label: t("Weitere Optionen"),
      id: "more-options",
      attrs: { type: "button" },
    },
    icon("ellipsis-vertical"),
  );
  const backButton = commandButton("navigate-back", "arrow-left", t("Zurück"));
  const forwardButton = commandButton(
    "navigate-forward",
    "arrow-right",
    t("Vorwärts"),
  );
  const saveWarningText = h("span", {
    text: t("Speichern fehlgeschlagen. Dein Entwurf bleibt erhalten."),
  });
  const saveWarning = h(
    "div",
    {
      class: "save-warning",
      id: "save-warning",
      attrs: { role: "alert", hidden: true },
    },
    icon("triangle-alert", 16),
    saveWarningText,
    h("button", {
      id: "export-draft",
      text: t("Entwurf exportieren"),
      attrs: { type: "button" },
    }),
    h("button", {
      id: "reload-note",
      class: "mod-cta",
      text: t("Dateistand laden"),
      attrs: { type: "button" },
    }),
  );
  const editorEl = h("div", {
    class: "markdown-source-view",
    id: "editor",
    attrs: { hidden: true },
  });
  const previewEl = h("article", {
    class: "markdown-reading-view markdown-preview-view markdown-rendered",
    id: "preview",
    attrs: { hidden: true, tabindex: "-1" },
  });
  const pluginView = h("div", {
    class: "plugin-view",
    id: "plugin-view",
    attrs: { hidden: true },
  });
  const canvasHost = h("div", {
    class: "canvas-host",
    id: "canvas-host",
    attrs: { hidden: true },
  });
  const baseHost = h("div", {
    class: "base-host",
    id: "base-host",
    attrs: { hidden: true },
  });
  const attachmentHost = h("div", {
    class: "attachment-host",
    id: "attachment-host",
    attrs: { hidden: true },
  });
  const empty = h("div", { class: "empty-state", id: "empty-state" });
  const viewContent = h(
    "div",
    { class: "view-content", id: "editor-area" },
    editorEl,
    previewEl,
    pluginView,
    canvasHost,
    baseHost,
    attachmentHost,
    empty,
  );
  const bottomHandle = h("div", {
    class: "workspace-resize-handle mod-bottom",
    attrs: { role: "separator", "aria-orientation": "horizontal" },
  });
  const bottomSplit = h(
    "section",
    {
      class: "workspace-split mod-bottom-split",
      id: "bottom-split",
      label: AREA_LABELS.bottom,
    },
    h(
      "div",
      "workspace-bottom-header",
      docks.bottom.tabs,
      h("div", "workspace-tab-header-spacer"),
      commandButton(
        "toggle-bottom-panel",
        "x",
        t("Unteren Bereich schließen"),
        "",
        "top",
      ),
    ),
    docks.bottom.content,
  );
  // The one live view. It is moved into whichever editor group has the focus.
  const leaf = h(
    "div",
    "workspace-leaf",
    h(
      "div",
      "view-header",
      h(
        "div",
        "view-header-left",
        commandButton(
          "toggle-left-sidebar",
          "menu",
          t("Seitenleiste öffnen"),
          "mobile-only",
        ),
        h("div", "view-header-nav-buttons", backButton, forwardButton),
      ),
      h("div", "view-header-title-container", breadcrumb, title),
      h("div", "view-actions", focusButton, modeButton, moreButton),
    ),
    saveWarning,
    viewContent,
  );
  // Window buttons; they sit in the tab strips of the corner groups.
  const inlineToggle = commandButton(
    "toggle-left-sidebar",
    "panel-left",
    t("Linke Seitenleiste umschalten"),
    "sidebar-toggle-button mod-inline",
  );
  const stripActions = h(
    "div",
    "workspace-tab-header-actions",
    h(
      "button",
      {
        class: "clickable-icon",
        id: "tab-list-button",
        label: t("Tab-Liste"),
        attrs: { type: "button" },
      },
      icon("chevron-down"),
    ),
    commandButton(
      "toggle-bottom-panel",
      "panel-bottom",
      t("Unteren Bereich umschalten"),
      "sidebar-toggle-button mod-bottom",
    ),
    commandButton(
      "toggle-right-sidebar",
      "panel-right",
      t("Rechte Seitenleiste umschalten"),
      "sidebar-toggle-button mod-right",
    ),
  );
  const groupsEl = h("div", "workspace-groups");
  const rootSplit = h("main", { class: "workspace-split mod-root" }, groupsEl);
  // The bottom area sits under the editor and between the sidebars.
  const mainColumn = h(
    "div",
    "workspace-main-column",
    rootSplit,
    bottomHandle,
    bottomSplit,
  );

  const rightSplit = h(
    "aside",
    {
      class: "workspace-split mod-right-split",
      id: "right-split",
      label: t("Rechte Seitenleiste"),
    },
    h("div", "workspace-split-inner", docks.right.tabs, docks.right.content),
  );

  const leftHandle = h("div", {
    class: "workspace-resize-handle mod-left",
    attrs: { role: "separator", "aria-orientation": "vertical" },
  });
  const rightHandle = h("div", {
    class: "workspace-resize-handle mod-right",
    attrs: { role: "separator", "aria-orientation": "vertical" },
  });
  const workspace = h(
    "div",
    { class: "workspace", id: "workspace" },
    ribbon,
    leftSplit,
    leftHandle,
    mainColumn,
    rightHandle,
    rightSplit,
  );

  const saveStatus = h("div", {
    class: "status-bar-item mod-save",
    id: "save-status",
    attrs: {
      role: "status",
      "data-tooltip": "",
      "data-tooltip-position": "top",
    },
  });
  const pluginStatus = h("div", {
    class: "status-bar-plugins",
    id: "plugin-status-items",
  });
  const environment = h("div", {
    class: "status-bar-item mod-environment",
    id: "environment",
  });
  const backlinkCount = h("button", {
    class: "status-bar-item mod-clickable",
    id: "backlink-count",
    attrs: { type: "button" },
  });
  const syncConflicts = h("button", {
    class: "status-bar-item mod-clickable mod-warning",
    id: "sync-conflicts",
    attrs: { type: "button", hidden: true },
  });
  const wordCountEl = h("div", {
    class: "status-bar-item",
    id: "word-count",
  });
  const charCount = h("div", { class: "status-bar-item", id: "char-count" });
  const statusBar = h(
    "footer",
    { class: "status-bar" },
    environment,
    pluginStatus,
    saveStatus,
    syncConflicts,
    backlinkCount,
    syncConflicts,
    wordCountEl,
    charCount,
  );

  const tabCount = h("span", { class: "mobile-tab-count", text: "1" });
  const mobileNavbar = h(
    "nav",
    { class: "mobile-navbar", label: t("Navigation") },
    commandButton("navigate-back", "chevron-left", t("Zurück"), "", "top"),
    commandButton("navigate-forward", "chevron-right", t("Vorwärts"), "", "top"),
    commandButton(
      "quick-switcher",
      "search",
      t("Schnellauswahl öffnen"),
      "",
      "top",
    ),
    commandButton("new-note", "plus", t("Neue Notiz"), "", "top"),
    h(
      "button",
      {
        class: "clickable-icon mobile-tabs-button",
        id: "mobile-tabs",
        label: t("Tabs"),
        attrs: { type: "button" },
      },
      tabCount,
    ),
    h(
      "button",
      {
        class: "clickable-icon",
        id: "mobile-menu",
        label: t("Menü"),
        attrs: { type: "button" },
      },
      icon("menu"),
    ),
  );

  const scrim = h("div", {
    class: "workspace-drawer-backdrop",
    id: "sidebar-scrim",
  });

  root.replaceChildren(
    h(
      "div",
      "app-container",
      h("div", "horizontal-main-container", workspace),
      statusBar,
      mobileNavbar,
    ),
    scrim,
    focusExit,
  );

  return {
    workspace,
    ribbon,
    railPanels,
    pluginRibbon,
    leftSplit,
    rightSplit,
    leftHandle,
    rightHandle,
    bottomSplit,
    bottomHandle,
    leftBottomSplit,
    leftBottomHandle,
    panes,
    panelTabs,
    docks,
    rootSplit,
    groupsEl,
    leaf,
    inlineToggle,
    stripActions,
    vaultName,
    breadcrumb,
    title,
    modeButton,
    moreButton,
    focusExit,
    backButton,
    forwardButton,
    saveWarning,
    saveWarningText,
    viewContent,
    editorEl,
    previewEl,
    pluginView,
    canvasHost,
    baseHost,
    attachmentHost,
    empty,
    saveStatus,
    pluginStatus,
    environment,
    backlinkCount,
    wordCount: wordCountEl,
    charCount,
    statusBar,
    mobileNavbar,
    tabCount,
    scrim,
  };
}

export type Shell = ReturnType<typeof buildShell>;
