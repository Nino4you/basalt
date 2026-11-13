/** Metadata objects only. FileIndex performs no filesystem I/O and grants no permissions. */
export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}
export interface FileEntry {
  path: string;
  kind: "file" | "folder";
  stat?: FileStats;
}

export abstract class TAbstractFile {
  parent: TFolder | null = null;
  name: string;
  constructor(
    readonly vault: object,
    public path: string,
  ) {
    this.name = path === "/" ? "" : path.split("/").pop()!;
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean {
    return this.path === "/";
  }
}

export class TFile extends TAbstractFile {
  stat: FileStats;
  constructor(vault: object, path: string, stat: FileStats) {
    super(vault, path);
    this.stat = { ...stat };
  }
  get extension(): string {
    const dot = this.name.lastIndexOf(".");
    return dot > 0 ? this.name.slice(dot + 1) : "";
  }
  get basename(): string {
    const dot = this.name.lastIndexOf(".");
    return dot > 0 ? this.name.slice(0, dot) : this.name;
  }
}

function validatePath(path: string): void {
  if (
    !path ||
    /[\\\u0000-\u001f\u007f-\u009f]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(
      `Invalid vault-relative metadata path: ${JSON.stringify(path)}`,
    );
  }
}

function validStat(stat: FileStats | undefined): FileStats {
  if (
    !stat ||
    ![stat.ctime, stat.mtime, stat.size].every(Number.isFinite) ||
    stat.size < 0
  )
    throw new Error(
      "File metadata needs finite timestamps and a non-negative byte size",
    );
  return { ...stat };
}

/** A transactional metadata graph. Existing paths keep their object identities across refreshes. */
export class FileIndex {
  private readonly owner: object;
  private readonly root: TFolder;
  private entries = new Map<string, TAbstractFile>();
  constructor(vault?: object) {
    this.owner = vault ?? this;
    this.root = new TFolder(this.owner, "/");
    this.entries.set("/", this.root);
  }

  getRoot(): TFolder {
    return this.root;
  }
  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.entries.get(path || "/") ?? null;
  }
  getFileByPath(path: string): TFile | null {
    const file = this.entries.get(path);
    return file instanceof TFile ? file : null;
  }
  getFolderByPath(path: string): TFolder | null {
    const file = this.entries.get(path || "/");
    return file instanceof TFolder ? file : null;
  }
  getAllLoadedFiles(): TAbstractFile[] {
    return [...this.entries.values()];
  }
  getFiles(): TFile[] {
    return [...this.entries.values()].filter(
      (file): file is TFile => file instanceof TFile,
    );
  }
  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter(
      (file) => file.extension.toLowerCase() === "md",
    );
  }

  /** Host-confirmed file move, preserving the TFile held by open views/plugins. */
  relocateFile(file: TFile, path: string, stat: FileStats): void {
    validatePath(path);
    if (this.entries.get(file.path) !== file || file.vault !== this.owner)
      throw new Error("Cannot relocate a stale or foreign file");
    if (path === file.path) return;
    if (this.entries.has(path))
      throw new Error(`Destination already exists: ${path}`);
    const snapshot = this.getAllLoadedFiles()
      .filter((entry) => entry !== this.root && entry !== file)
      .map((entry): FileEntry =>
        entry instanceof TFile
          ? { path: entry.path, kind: "file", stat: { ...entry.stat } }
          : { path: entry.path, kind: "folder" },
      );
    snapshot.push({ path, kind: "file", stat: validStat(stat) });
    // Validate the entire replacement before changing published identities.
    new FileIndex(this.owner).replace(snapshot);
    this.entries.delete(file.path);
    this.entries.set(path, file);
    this.replace(snapshot);
  }

  replace(snapshot: readonly FileEntry[]): void {
    const staged = new Map<string, FileEntry>();
    const explicit = new Set<string>();
    const folder = (path: string) => {
      const entry = staged.get(path);
      if (entry?.kind === "file")
        throw new Error(`A file cannot contain children: ${path}`);
      if (!entry) staged.set(path, { path, kind: "folder" });
    };
    for (const entry of snapshot) {
      validatePath(entry.path);
      if (entry.kind !== "file" && entry.kind !== "folder")
        throw new Error("Unknown metadata entry kind");
      if (explicit.has(entry.path))
        throw new Error(`Duplicate metadata path: ${entry.path}`);
      explicit.add(entry.path);
      const parts = entry.path.split("/");
      for (let depth = 1; depth < parts.length; depth++)
        folder(parts.slice(0, depth).join("/"));
      if (entry.kind === "folder") folder(entry.path);
      else {
        if (staged.get(entry.path)?.kind === "folder")
          throw new Error(
            `A folder cannot become a parent file: ${entry.path}`,
          );
        staged.set(entry.path, {
          path: entry.path,
          kind: "file",
          stat: validStat(entry.stat),
        });
      }
    }
    const next = new Map<string, TAbstractFile>([["/", this.root]]);
    // All input validation precedes changes to previously published objects.
    for (const [path, entry] of staged) {
      const previous = this.entries.get(path);
      const file =
        entry.kind === "folder"
          ? previous instanceof TFolder
            ? previous
            : new TFolder(this.owner, path)
          : previous instanceof TFile
            ? previous
            : new TFile(this.owner, path, entry.stat!);
      if (file instanceof TFile) file.stat = { ...entry.stat! };
      file.path = path;
      file.name = path.split("/").pop()!;
      next.set(path, file);
    }
    for (const file of next.values())
      if (file instanceof TFolder) file.children = [];
    for (const [path, file] of next) {
      if (path === "/") continue;
      const slash = path.lastIndexOf("/");
      const parent = next.get(slash < 0 ? "/" : path.slice(0, slash));
      if (!(parent instanceof TFolder))
        throw new Error("Invalid staged folder graph");
      file.parent = parent;
      parent.children.push(file);
    }
    for (const file of next.values())
      if (file instanceof TFolder)
        file.children.sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        );
    this.entries = next;
  }
}
