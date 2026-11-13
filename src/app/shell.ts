import { h, icon } from "../ui/dom";
import { DOCK_AREAS, type DockArea, type PanelSpec } from "./dock";

/** Every dockable side panel with its default area. */
export const PANELS = [
  { id: "files", label: "Dateiexplorer", icon: "folder-closed", area: "left" },
  { id: "search", label: "Suche", icon: "search", area: "left" },
  { id: "bookmarks", label: "Lesezeichen", icon: "bookmark", area: "left" },
  { id: "backlinks", label: "Rückverweise", icon: "link", area: "right" },
  {
    id: "outgoing",
    label: "Ausgehende Links",
    icon: "arrow-up-right",
    area: "right",
  },
  { id: "tags", label: "Tags", icon: "tags", area: "right" },
  { id: "outline", label: "Gliederung", icon: "list", area: "right" },
  { id: "graph", label: "Lokaler Graph", icon: "waypoints", area: "right" },
] as const satisfies readonly PanelSpec[];

export type PanelId = (typeof PANELS)[number]["id"];

export const AREA_LABELS: Record<DockArea, string> = {
  left: "Linke Seitenleiste",
  "left-bottom": "Links unten",
  right: "Rechte Seitenleiste",
  bottom: "Unterer Bereich",
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
function panelTab(spec: PanelSpec): HTMLButtonElement {
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

function pane(spec: PanelSpec): HTMLElement {
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
    label: `Ansichten: ${AREA_LABELS[area]}`,
    data: { dockArea: area },
  });
  // Lists the closed panels; only shown while there are any.
  const add = h(
    "button",
    {
      class: "clickable-icon dock-add-panel",
      label: "Geschlossene Ansicht öffnen",
      attrs: { type: "button", hidden: true },
      data: { tooltipPosition: "bottom" },
    },
    icon("plus"),
  );
  const empty = h("div", {
    class: "dock-empty",
    text: "Ziehe eine Ansicht hierher oder verschiebe sie über ihr Kontextmenü.",
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
      "Neuer Tab",
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
  const ribbon = h(
    "nav",
    { class: "workspace-ribbon side-dock-ribbon mod-left", label: "Werkzeuge" },
    commandButton(
      "toggle-left-sidebar",
      "panel-left",
      "Linke Seitenleiste umschalten",
      "sidebar-toggle-button mod-left",
      "right",
    ),
    h(
      "div",
      "side-dock-actions",
      commandButton(
        "quick-switcher",
        "file-search",
        "Schnellauswahl öffnen",
        "",
        "right",
      ),
      commandButton(
        "daily-note",
        "calendar",
        "Heutige Tagesnotiz öffnen",
        "",
        "right",
      ),
      commandButton(
        "command-palette",
        "terminal",
        "Befehlspalette öffnen",
        "",
        "right",
      ),
      commandButton(
        "open-graph",
        "git-fork",
        "Graphansicht öffnen",
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
        "Farbschema wechseln",
        "",
        "right",
      ),
      commandButton("settings", "settings", "Einstellungen", "", "right"),
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
    label: "Höhe links unten",
    attrs: { role: "separator", "aria-orientation": "horizontal", tabindex: "0" },
  });
  const leftBottomSplit = h(
    "section",
    { class: "workspace-left-bottom", id: "left-bottom-split", label: AREA_LABELS["left-bottom"] },
    docks["left-bottom"].tabs,
    docks["left-bottom"].content,
  );
  docks["left-bottom"].empty.textContent = "Ansicht hier ablegen";
  const leftSplit = h(
    "aside",
    {
      class: "workspace-split mod-left-split",
      id: "left-split",
      label: "Linke Seitenleiste",
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
            label: "Vault wechseln",
            attrs: { type: "button" },
            data: { command: "open-vault" },
          },
          vaultName,
          icon("chevrons-up-down", 14),
        ),
        commandButton(
          "settings",
          "settings",
          "Einstellungen",
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
    "Leseansicht",
  );
  const moreButton = h(
    "button",
    {
      class: "clickable-icon",
      label: "Weitere Optionen",
      id: "more-options",
      attrs: { type: "button" },
    },
    icon("ellipsis-vertical"),
  );
  const backButton = commandButton("navigate-back", "arrow-left", "Zurück");
  const forwardButton = commandButton(
    "navigate-forward",
    "arrow-right",
    "Vorwärts",
  );
  const saveWarningText = h("span", {
    text: "Speichern fehlgeschlagen. Dein Entwurf bleibt erhalten.",
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
      text: "Entwurf exportieren",
      attrs: { type: "button" },
    }),
    h("button", {
      id: "reload-note",
      class: "mod-cta",
      text: "Dateistand laden",
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
        "Unteren Bereich schließen",
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
          "Seitenleiste öffnen",
          "mobile-only",
        ),
        h("div", "view-header-nav-buttons", backButton, forwardButton),
      ),
      h("div", "view-header-title-container", breadcrumb, title),
      h("div", "view-actions", modeButton, moreButton),
    ),
    saveWarning,
    viewContent,
  );
  // Window buttons; they sit in the tab strips of the corner groups.
  const inlineToggle = commandButton(
    "toggle-left-sidebar",
    "panel-left",
    "Linke Seitenleiste umschalten",
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
        label: "Tab-Liste",
        attrs: { type: "button" },
      },
      icon("chevron-down"),
    ),
    commandButton(
      "toggle-bottom-panel",
      "panel-bottom",
      "Unteren Bereich umschalten",
      "sidebar-toggle-button mod-bottom",
    ),
    commandButton(
      "toggle-right-sidebar",
      "panel-right",
      "Rechte Seitenleiste umschalten",
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
      label: "Rechte Seitenleiste",
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
    backlinkCount,
    wordCountEl,
    charCount,
  );

  const tabCount = h("span", { class: "mobile-tab-count", text: "1" });
  const mobileNavbar = h(
    "nav",
    { class: "mobile-navbar", label: "Navigation" },
    commandButton("navigate-back", "chevron-left", "Zurück", "", "top"),
    commandButton("navigate-forward", "chevron-right", "Vorwärts", "", "top"),
    commandButton(
      "quick-switcher",
      "search",
      "Schnellauswahl öffnen",
      "",
      "top",
    ),
    commandButton("new-note", "plus", "Neue Notiz", "", "top"),
    h(
      "button",
      {
        class: "clickable-icon mobile-tabs-button",
        id: "mobile-tabs",
        label: "Tabs",
        attrs: { type: "button" },
      },
      tabCount,
    ),
    h(
      "button",
      {
        class: "clickable-icon",
        id: "mobile-menu",
        label: "Menü",
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
  );

  return {
    workspace,
    ribbon,
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
    backButton,
    forwardButton,
    saveWarning,
    saveWarningText,
    viewContent,
    editorEl,
    previewEl,
    pluginView,
    canvasHost,
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
