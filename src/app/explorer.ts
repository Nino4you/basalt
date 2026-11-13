import { basename, clear, extension, h, icon, iconButton } from "../ui/dom";
import { showMenu } from "../ui/menu";
import type { App } from "./app";
import { Component } from "../compat/component";
import type { TAbstractFile } from "../compat/files";
import { setDragLabel } from "./dock-drag";

const FILE_MIME = "application/x-basalt-file";

/** Row children Basalt builds itself; anything else in a row belongs to a plugin. */
const HOST_ROW_PARTS = [
  "tree-item-icon",
  "tree-item-inner",
  "nav-file-tag",
  "nav-file-bookmark",
];

export interface ExplorerFileItem {
  file: TAbstractFile;
  selfEl: HTMLElement;
  innerEl: HTMLElement;
}
/** How long a dragged file rests on a collapsed folder before it opens. */
const EXPAND_DELAY = 600;

interface FolderNode {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  files: string[];
}

const collator = new Intl.Collator("de", {
  numeric: true,
  sensitivity: "base",
});

/** File tree. Children of collapsed folders are never rendered. */
export class Explorer extends Component {
  private readonly listEl: HTMLElement;
  private root: FolderNode = emptyFolder("", "");
  private readonly rows = new Map<string, HTMLElement>();
  /**
   * Latest row element per key (`path` or `/folder`), rendered or not. Plugins such as
   * Iconize decorate rows once through `fileItems`; re-renders carry those additions over.
   */
  private readonly rowCache = new Map<string, HTMLElement>();
  private rowCacheOwner: unknown = null;
  private activePath: string | null = null;
  private readonly newFolderButton: HTMLButtonElement;

  constructor(
    private readonly app: App,
    readonly containerEl: HTMLElement,
  ) {
    super();
    this.newFolderButton = iconButton(
      "folder-plus",
      "Neuer Ordner",
      () => void this.app.createFolder(""),
    );
    this.listEl = h("div", {
      class: "nav-files-container",
      attrs: { role: "tree", "aria-label": "Dateien" },
    });
    containerEl.append(
      h(
        "div",
        "nav-header",
        h(
          "div",
          "nav-buttons-container",
          iconButton("square-pen", "Neue Notiz", () =>
            this.app.promptNewNote(),
          ),
          iconButton(
            "layout-dashboard",
            "Neue Canvas",
            () => void this.app.createCanvas(),
          ),
          this.newFolderButton,
          iconButton(
            "arrow-up-narrow-wide",
            "Sortierreihenfolge ändern",
            (event) => this.sortMenu(event.currentTarget as HTMLElement),
          ),
          iconButton("chevrons-down-up", "Alle einklappen", () => {
            this.app.ws.expanded = [];
            this.app.persist();
            this.render();
          }),
          iconButton("refresh-cw", "Dateiliste neu laden", () =>
            this.app.commands.run("reload-files"),
          ),
        ),
      ),
      this.listEl,
    );
    this.listEl.addEventListener("click", (event) => this.onClick(event));
    this.listEl.addEventListener("auxclick", (event) => {
      if (event.button === 1) this.onClick(event);
    });
    this.listEl.addEventListener("contextmenu", (event) =>
      this.onContext(event),
    );
    this.listEl.addEventListener("keydown", (event) => this.onKey(event));
    this.setupDrag();
    app.on("files", () => this.render());
    app.on("active", () => this.markActive());
    app.on("bookmarks", () => this.render());
  }

  getViewType(): string {
    return "file-explorer";
  }
  getDisplayText(): string {
    return "Dateiexplorer";
  }

  /**
   * Obsidian's `fileItems`: one entry per file and folder, including children of
   * collapsed folders. Rows that are not rendered yet are built detached and reused once
   * their folder opens, so plugin decorations added to them are not lost.
   */
  get fileItems(): Record<string, ExplorerFileItem> {
    const resolve = (path: string): ExplorerFileItem | undefined => {
      const file = this.app.compatibility?.vault.getAbstractFileByPath(path);
      if (!file || !path) return undefined;
      const selfEl = this.cachedRow(path, "children" in file);
      if (!selfEl) return undefined;
      return {
        file,
        selfEl,
        innerEl: selfEl.querySelector<HTMLElement>(
          ":scope > .tree-item-inner",
        )!,
      };
    };
    const keys = () => [...this.allFolders(), ...this.app.index.files];
    return new Proxy(Object.create(null) as Record<string, ExplorerFileItem>, {
      get: (_target, key) =>
        typeof key === "string" ? resolve(key) : undefined,
      has: (_target, key) =>
        typeof key === "string" && resolve(key) !== undefined,
      ownKeys: () => keys().filter((path) => resolve(path) !== undefined),
      getOwnPropertyDescriptor: (_target, key) => {
        const value = typeof key === "string" ? resolve(key) : undefined;
        return value
          ? { value, enumerable: true, configurable: true, writable: false }
          : undefined;
      },
    });
  }

  /** Cached (possibly detached) row for a vault path, built on first request. */
  private cachedRow(path: string, folder: boolean): HTMLElement | null {
    this.checkRowCacheOwner();
    const key = folder ? `/${path}` : path;
    const cached = this.rowCache.get(key);
    if (cached) return cached;
    if (folder) {
      const node = this.find(path);
      if (!node) return null;
      const depth = path.split("/").length - 1;
      return this.folderRow(node, depth, this.app.ws.expanded.includes(path));
    }
    if (!this.app.index.files.includes(path)) return null;
    return this.fileRow(path, path.split("/").length - 1);
  }

  /** Decorations must not leak into a different vault. */
  private checkRowCacheOwner(): void {
    if (this.rowCacheOwner === this.app.compatibility) return;
    this.rowCacheOwner = this.app.compatibility;
    this.rowCache.clear();
  }

  /** Moves plugin-added children of the previous row for `key` into `self`. */
  private adoptRow(key: string, self: HTMLElement): HTMLElement {
    const previous = this.rowCache.get(key);
    if (previous && previous !== self) {
      const inner = self.querySelector(":scope > .tree-item-inner");
      let beforeInner = true;
      for (const child of [...previous.children]) {
        if (child.classList.contains("tree-item-inner")) {
          beforeInner = false;
          continue;
        }
        if (HOST_ROW_PARTS.some((part) => child.classList.contains(part)))
          continue;
        if (beforeInner && inner) self.insertBefore(child, inner);
        else self.append(child);
      }
    }
    this.rowCache.set(key, self);
    return self;
  }

  /** Drops cached rows of paths that no longer exist. */
  private pruneRowCache(): void {
    const files = new Set(this.app.index.files);
    const folders = new Set(this.allFolders());
    for (const key of this.rowCache.keys()) {
      const exists = key.startsWith("/")
        ? folders.has(key.slice(1))
        : files.has(key);
      if (!exists) this.rowCache.delete(key);
    }
  }

  private sortMenu(anchor: HTMLElement): void {
    const set = (sort: "asc" | "desc") => () => {
      this.app.ws.sort = sort;
      this.app.persist();
      this.render();
    };
    showMenu(
      [
        {
          title: "Dateiname (A bis Z)",
          checked: this.app.ws.sort === "asc",
          onClick: set("asc"),
        },
        {
          title: "Dateiname (Z bis A)",
          checked: this.app.ws.sort === "desc",
          onClick: set("desc"),
        },
      ],
      anchor,
    );
  }

  private build(): void {
    const root = emptyFolder("", "");
    const ensure = (path: string): FolderNode => {
      let node = root;
      if (!path) return node;
      let current = "";
      for (const part of path.split("/")) {
        current = current ? `${current}/${part}` : part;
        let next = node.folders.get(part);
        if (!next) node.folders.set(part, (next = emptyFolder(part, current)));
        node = next;
      }
      return node;
    };
    for (const folder of this.app.folders()) ensure(folder);
    for (const path of this.app.index.files) {
      const slash = path.lastIndexOf("/");
      ensure(slash < 0 ? "" : path.slice(0, slash)).files.push(path);
    }
    this.root = root;
  }

  render(): void {
    this.build();
    this.checkRowCacheOwner();
    this.pruneRowCache();
    this.rows.clear();
    this.newFolderButton.hidden = !this.app.compatibility;
    clear(this.listEl);
    if (!this.root.folders.size && !this.root.files.length) {
      this.listEl.append(
        h(
          "div",
          "pane-empty",
          this.app.vault
            ? "Dieser Vault ist noch leer."
            : "Vault wird geöffnet …",
        ),
      );
      return;
    }
    this.listEl.append(this.renderChildren(this.root, 0));
    this.markActive();
  }

  private renderChildren(node: FolderNode, depth: number): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const direction = this.app.ws.sort === "desc" ? -1 : 1;
    const folders = [...node.folders.values()].sort(
      (a, b) => collator.compare(a.name, b.name) * direction,
    );
    const files = [...node.files].sort(
      (a, b) => collator.compare(basename(a), basename(b)) * direction,
    );
    for (const folder of folders)
      fragment.append(this.renderFolder(folder, depth));
    for (const path of files) fragment.append(this.renderFile(path, depth));
    return fragment;
  }

  private renderFolder(node: FolderNode, depth: number): HTMLElement {
    const open = this.app.ws.expanded.includes(node.path);
    const self = this.folderRow(node, depth, open);
    const item = h(
      "div",
      `tree-item nav-folder${open ? "" : " is-collapsed"}`,
      self,
    );
    if (open) item.append(this.childrenEl(node, depth));
    this.rows.set(`/${node.path}`, self);
    return item;
  }

  private folderRow(
    node: FolderNode,
    depth: number,
    open: boolean,
  ): HTMLElement {
    const self = h(
      "div",
      {
        class: "tree-item-self nav-folder-title is-clickable",
        attrs: {
          role: "treeitem",
          "aria-expanded": String(open),
          tabindex: "-1",
          style: `--depth:${depth}`,
        },
        data: { folder: node.path },
      },
      h("div", "tree-item-icon collapse-icon", icon("chevron-right", 14)),
      h("div", {
        class: "tree-item-inner nav-folder-title-content",
        text: node.name,
      }),
    );
    return this.adoptRow(`/${node.path}`, self);
  }

  private childrenEl(node: FolderNode, depth: number): HTMLElement {
    return h(
      "div",
      {
        class: "tree-item-children nav-folder-children",
        attrs: { style: `--guide-depth:${depth}` },
      },
      this.renderChildren(node, depth + 1),
    );
  }

  private renderFile(path: string, depth: number): HTMLElement {
    const self = this.fileRow(path, depth);
    this.rows.set(path, self);
    return h("div", "tree-item nav-file", self);
  }

  private fileRow(path: string, depth: number): HTMLElement {
    const type = extension(path);
    const self = h(
      "div",
      {
        class: "tree-item-self nav-file-title is-clickable",
        attrs: {
          role: "treeitem",
          tabindex: "-1",
          style: `--depth:${depth}`,
          draggable: "true",
        },
        data: { path },
      },
      h("div", {
        class: "tree-item-inner nav-file-title-content",
        text: basename(path),
      }),
      type && type !== "md"
        ? h("div", { class: "nav-file-tag", text: type })
        : null,
      this.app.isBookmarked(path)
        ? h("div", "nav-file-bookmark", icon("bookmark", 12))
        : null,
    );
    return this.adoptRow(path, self);
  }

  /** Every folder of the tree, in display order. */
  private allFolders(node: FolderNode = this.root): string[] {
    return [...node.folders.values()]
      .sort((a, b) => collator.compare(a.name, b.name))
      .flatMap((folder) => [folder.path, ...this.allFolders(folder)]);
  }

  /** Menu of destinations: the way to move a file without dragging. */
  private moveMenu(path: string, at: { x: number; y: number }): void {
    const slash = path.lastIndexOf("/");
    const current = slash < 0 ? "" : path.slice(0, slash);
    showMenu(
      ["", ...this.allFolders()]
        .filter((folder) => folder !== current)
        .map((folder) => ({
          title: folder || "Oberste Ebene",
          icon: folder ? "folder-closed" : "vault",
          onClick: () => void this.app.moveFile(path, folder),
        })),
      at,
    );
  }

  /**
   * Drag & drop of files onto folders. The folder a drop goes to is the one
   * whose row or contents are under the pointer; the free space of the list
   * stands for the vault root.
   */
  private setupDrag(): void {
    const list = this.listEl;
    let dragged: string | null = null;
    let marked: HTMLElement | null = null;
    let pending: { row: HTMLElement; timer: number } | null = null;

    const cancelExpand = () => {
      if (pending) clearTimeout(pending.timer);
      pending = null;
    };
    const mark = (el: HTMLElement | null) => {
      if (marked === el) return;
      marked?.classList.remove("is-drop-target");
      marked = el;
      el?.classList.add("is-drop-target");
    };
    const end = () => {
      dragged = null;
      mark(null);
      cancelExpand();
      for (const row of list.querySelectorAll(".is-dragging"))
        row.classList.remove("is-dragging");
    };
    /** Destination folder under the pointer, or null where a drop does nothing. */
    const targetOf = (event: DragEvent) => {
      if (!dragged) return null;
      const item = (event.target as Element).closest<HTMLElement>(
        ".nav-folder",
      );
      const row = item?.querySelector<HTMLElement>(":scope > .tree-item-self");
      const folder = row?.dataset.folder ?? "";
      const slash = dragged.lastIndexOf("/");
      if (folder === (slash < 0 ? "" : dragged.slice(0, slash))) return null;
      return { folder, el: item ?? list, row: row ?? null };
    };

    list.addEventListener("dragstart", (event) => {
      const row = this.row(event);
      const path = row?.dataset.path;
      if (!row || !path || !event.dataTransfer) return;
      dragged = path;
      // No text/plain: the editor would insert the path as text on a drop.
      event.dataTransfer.setData(FILE_MIME, path);
      event.dataTransfer.effectAllowed = "move";
      setDragLabel(event, row, basename(path));
      requestAnimationFrame(() => {
        if (dragged === path) row.classList.add("is-dragging");
      });
    });
    const over = (event: DragEvent) => {
      const target = targetOf(event);
      if (!target) {
        mark(null);
        cancelExpand();
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      mark(target.el);
      // Resting on a collapsed folder opens it, so nested folders are reachable.
      const hovered = this.row(event);
      const closed =
        hovered &&
        hovered === target.row &&
        hovered.parentElement!.classList.contains("is-collapsed");
      if (!closed) cancelExpand();
      else if (pending?.row !== hovered) {
        cancelExpand();
        pending = {
          row: hovered,
          timer: window.setTimeout(() => {
            pending = null;
            if (dragged && hovered.isConnected) this.toggleFolder(hovered);
          }, EXPAND_DELAY),
        };
      }
    };
    list.addEventListener("dragenter", over);
    list.addEventListener("dragover", over);
    list.addEventListener("dragleave", (event) => {
      const to = event.relatedTarget;
      if (to instanceof Node && list.contains(to)) return;
      // Chromium leaves relatedTarget empty between elements too; only a
      // pointer outside the list has really left it.
      const box = list.getBoundingClientRect();
      const { clientX: x, clientY: y } = event;
      if (x > box.left && x < box.right && y > box.top && y < box.bottom)
        return;
      mark(null);
      cancelExpand();
    });
    list.addEventListener("drop", (event) => {
      const path = dragged;
      const target = targetOf(event);
      end();
      if (!path || !target) return;
      event.preventDefault();
      void this.app.moveFile(path, target.folder);
    });
    list.addEventListener("dragend", end);
    window.addEventListener("blur", end);
  }

  private markActive(): void {
    const next = this.app.activePath;
    if (this.activePath)
      this.rows.get(this.activePath)?.classList.remove("is-active");
    this.activePath = next;
    const row = next ? this.rows.get(next) : undefined;
    row?.classList.add("is-active");
    // Exactly one row is in the tab order (roving tabindex).
    for (const other of this.listEl.querySelectorAll('[tabindex="0"]'))
      other.setAttribute("tabindex", "-1");
    (row ?? this.listEl.querySelector(".tree-item-self"))?.setAttribute(
      "tabindex",
      "0",
    );
  }

  expand(folder: string): void {
    const expanded = new Set(this.app.ws.expanded);
    let current = "";
    for (const part of folder.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      expanded.add(current);
    }
    this.app.ws.expanded = [...expanded];
    this.app.persist();
  }

  /** Expands the parents of `path` and scrolls its row into view. */
  reveal(path: string): void {
    const slash = path.lastIndexOf("/");
    if (slash > 0) this.expand(path.slice(0, slash));
    this.app.showPanel("files");
    this.render();
    const row = this.rows.get(path);
    row?.scrollIntoView({ block: "center" });
    row?.focus({ preventScroll: true });
  }

  private toggleFolder(self: HTMLElement): void {
    const path = self.dataset.folder!;
    const item = self.parentElement!;
    const open = item.classList.contains("is-collapsed");
    const expanded = new Set(this.app.ws.expanded);
    if (open) expanded.add(path);
    else expanded.delete(path);
    this.app.ws.expanded = [...expanded];
    this.app.persist();
    item.classList.toggle("is-collapsed", !open);
    self.setAttribute("aria-expanded", String(open));
    const children = item.querySelector(":scope > .tree-item-children");
    if (open && !children) {
      const node = this.find(path);
      if (!node) return;
      const depth = Number(self.style.getPropertyValue("--depth")) + 1;
      item.append(this.childrenEl(node, depth - 1));
      this.markActive();
    } else if (!open && children) {
      for (const row of children.querySelectorAll<HTMLElement>(
        ".tree-item-self",
      ))
        this.rows.delete(row.dataset.path ?? `/${row.dataset.folder}`);
      children.remove();
    }
  }

  private find(path: string): FolderNode | null {
    let node: FolderNode | undefined = this.root;
    for (const part of path.split("/")) {
      node = node.folders.get(part);
      if (!node) return null;
    }
    return node;
  }

  private row(event: Event): HTMLElement | null {
    return (event.target as Element).closest<HTMLElement>(".tree-item-self");
  }

  private onClick(event: MouseEvent): void {
    const row = this.row(event);
    if (!row) return;
    if (row.dataset.folder !== undefined) {
      if (event.button === 0) this.toggleFolder(row);
      return;
    }
    const path = row.dataset.path;
    if (!path) return;
    event.preventDefault();
    void this.app.openPath(path, {
      newTab: event.ctrlKey || event.metaKey || event.button === 1,
    });
  }

  private onContext(event: MouseEvent): void {
    const row = this.row(event);
    event.preventDefault();
    const at = { x: event.clientX, y: event.clientY };
    if (!row) {
      showMenu(
        [
          {
            title: "Neue Notiz",
            icon: "square-pen",
            onClick: () => this.app.promptNewNote(""),
          },
          {
            title: "Neue Canvas",
            icon: "layout-dashboard",
            onClick: () => void this.app.createCanvas(""),
          },
          this.app.compatibility
            ? {
                title: "Neuer Ordner",
                icon: "folder-plus",
                onClick: () => void this.app.createFolder(""),
              }
            : null,
        ],
        at,
      );
      return;
    }
    if (row.dataset.folder !== undefined) {
      const folder = row.dataset.folder;
      this.app.showFileMenu(folder, at, [
        {
          title: "Neue Notiz",
          icon: "square-pen",
          onClick: () => this.app.promptNewNote(folder),
        },
        {
          title: "Neue Canvas",
          icon: "layout-dashboard",
          onClick: () => void this.app.createCanvas(folder),
        },
        this.app.compatibility
          ? {
              title: "Neuer Ordner",
              icon: "folder-plus",
              onClick: () => void this.app.createFolder(folder),
            }
          : null,
        "separator",
        {
          title: "In Ordner suchen",
          icon: "search",
          onClick: () => this.app.searchFor(`path:"${folder}/" `),
        },
        {
          title: "Pfad kopieren",
          icon: "copy",
          onClick: () => void navigator.clipboard?.writeText(folder),
        },
      ]);
      return;
    }
    const path = row.dataset.path!;
    this.app.showFileMenu(path, at, [
      {
        title: "Öffnen",
        icon: "file-text",
        onClick: () => void this.app.openPath(path),
      },
      {
        title: "Verschieben nach …",
        icon: "folder-input",
        onClick: () => this.moveMenu(path, at),
      },
      ...this.app.fileMenuItems(path),
    ]);
  }

  private onKey(event: KeyboardEvent): void {
    const current = this.row(event);
    if (!current) return;
    const rows = [
      ...this.listEl.querySelectorAll<HTMLElement>(".tree-item-self"),
    ];
    const index = rows.indexOf(current);
    const focus = (row?: HTMLElement) => {
      if (!row) return;
      current.setAttribute("tabindex", "-1");
      row.setAttribute("tabindex", "0");
      row.focus();
    };
    const isFolder = current.dataset.folder !== undefined;
    const open =
      isFolder && !current.parentElement!.classList.contains("is-collapsed");
    switch (event.key) {
      case "ArrowDown":
        focus(rows[index + 1]);
        break;
      case "ArrowUp":
        focus(rows[index - 1]);
        break;
      case "ArrowRight":
        if (isFolder && !open) this.toggleFolder(current);
        else if (isFolder) focus(rows[index + 1]);
        break;
      case "ArrowLeft":
        if (isFolder && open) this.toggleFolder(current);
        else
          focus(
            current
              .closest(".tree-item-children")
              ?.parentElement?.querySelector<HTMLElement>(
                ":scope > .tree-item-self",
              ) ?? undefined,
          );
        break;
      case "Enter":
      case " ":
        if (isFolder) this.toggleFolder(current);
        else if (current.dataset.path)
          void this.app.openPath(current.dataset.path, {
            newTab: event.ctrlKey || event.metaKey,
            keepFocus: event.key === " ",
          });
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}

function emptyFolder(name: string, path: string): FolderNode {
  return { name, path, folders: new Map(), files: [] };
}
