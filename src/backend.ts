import { t } from "./i18n";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { NativeVaultPort } from "./compat/native-port";
import demoCanvas from "../examples/demo-vault/Ideenboard.canvas?raw";
import {
  HISTORY_DIR,
  isDocumentBackup,
  newBackupId,
  parseBackup,
  sortBackups,
  TRASH_DIR,
  type BackupEntry,
} from "./backups";

export interface VaultInfo {
  id: string;
  name: string;
  files: string[];
  platform: string;
}

export interface Backend {
  info(): Promise<VaultInfo>;
  read(path: string, vaultId?: string): Promise<string>;
  create(path: string, text: string, vaultId?: string): Promise<void>;
  /** Moves one file to the vault trash; expected is the loaded Markdown basis. */
  remove(path: string, expected?: string, vaultId?: string): Promise<void>;
  /**
   * Moves one file to the free path `to`. Never overwrites: the destination
   * is created exclusively and the source only goes once its content is
   * unchanged (`expected` is the loaded Markdown basis).
   */
  move(
    from: string,
    to: string,
    expected?: string,
    vaultId?: string,
  ): Promise<void>;
  /**
   * Version-checked replacement. `backup: false` skips the history backup of
   * the replaced content; only for the app's own recent, already backed-up
   * writes. Storages may back up anyway (Android SAF always does).
   */
  save(
    path: string,
    text: string,
    expected: string,
    vaultId?: string,
    backup?: boolean,
  ): Promise<void>;
  choose(): Promise<VaultInfo | null>;
  export(path: string, text: string): Promise<boolean>;
  /**
   * Backups of notes and canvases (previous versions and deleted files),
   * newest first; `all` adds those of attachments, for cleaning up.
   */
  backups(vaultId?: string, all?: boolean): Promise<BackupEntry[]>;
  /** Permanently deletes backups from `backups()`; other paths are refused. */
  removeBackups(locations: string[], vaultId?: string): Promise<number>;
  /** Text of one backup from `backups()`; other paths are refused. */
  readBackup(location: string, vaultId?: string): Promise<string>;
}

export const native = isTauri();

const WELCOME = `# Platz für deine Gedanken.

Manche Ideen brauchen keinen großen Plan. Nur einen guten Ort, um anzufangen.

Willkommen in **Basalt**, deinem lokalen Markdown-Arbeitsraum für Linux und Android.

## Ein kleiner Anfang

- [x] Einen ruhigen Ort zum Schreiben finden
- [ ] Die erste eigene Notiz anlegen
- [ ] Gedanken mit [[Ideensammlung]] verknüpfen

> Deine Notizen sind einfache Markdown-Dateien. Kein Konto, kein Zwang zur Cloud.

## Alles hängt zusammen

Mit \\[[Notizname]] verknüpfst du deine Gedanken. Die Rückverweise rechts zeigen dir, welche Notizen hierherführen.

Öffne die [[Ideensammlung|Ideensammlung]] oder halte einen Gedanken in deinem [[Tagesnotiz|Tagebuch]] fest.

### Dein Werkzeugkasten

**Strg + O** öffnet die Schnellauswahl, **Strg + P** die Befehlspalette. **Strg + N** legt eine neue Notiz an. Änderungen werden automatisch gespeichert.

---

*Ein Gedanke nach dem anderen.*
`;

const INITIAL: Record<string, string> = {
  "Willkommen.md": WELCOME,
  "Ideenboard.canvas": demoCanvas,
  "Ideensammlung.md":
    "# Ideensammlung\n\nNicht jede Idee muss sofort fertig sein.\n\n## Als Nächstes\n\n- Ein gemeinsamer Arbeitsraum für Linux und Android\n- Handschrift dort, wo Gedanken entstehen\n- Tabellen, die sich nicht wie Fremdkörper anfühlen\n\nZurück zu [[Willkommen]]. Mehr zum Ausbau unter [[Plugins]].\n",
  "Tagesnotiz.md":
    "# Tagesnotiz\n\n## Was beschäftigt mich?\n\n\n\n## Ein guter nächster Schritt\n\n- [ ] Etwas Kleines anfangen\n\nSiehe auch [[Ideensammlung]] und [[Willkommen]].\n",
  "Plugins.md":
    "# Deine Plugins, dein Arbeitsraum\n\nBasalt kann ausgewählte Obsidian-Plugins laden. **In dieser Browser-Demo laufen sie nicht**, nur in der nativen App.\n\nPlugins liegen im Vault unter `Basalt/Plugins/<id>/` und werden erst nach ausdrücklicher Freigabe in den Einstellungen aktiviert.\n\n[[Willkommen]]\n",
};

export function validateNotePath(path: string): string {
  const normalized = path.trim();
  if (
    !normalized ||
    /[\\\u0000-\u001f\u007f-\u009f]/.test(normalized) ||
    normalized
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p.startsWith("."))
  ) {
    throw new Error(
      t("Bitte einen relativen Notiznamen ohne versteckte Ordner oder '..' verwenden."),
    );
  }
  return /\.md$/i.test(normalized) ? normalized : `${normalized}.md`;
}

/** Like `validateNotePath`, for JSON Canvas files (`.canvas`). */
export function validateCanvasPath(path: string): string {
  const note = validateNotePath(path.trim().replace(/\.canvas$/i, ""));
  return `${note.replace(/\.md$/i, "")}.canvas`;
}

/** Like `validateNotePath`, for database views (`.base`). */
export function validateBasePath(path: string): string {
  const note = validateNotePath(path.trim().replace(/\.base$/i, ""));
  return `${note.replace(/\.md$/i, "")}.base`;
}

/** Versions the browser demo keeps per note; native vaults keep every one. */
export const DEMO_VERSIONS = 20;

function freeBackupId(
  files: Record<string, string>,
  location: (id: string) => string,
): string {
  let id = newBackupId();
  while (Object.hasOwn(files, location(id))) id = newBackupId();
  return id;
}

/** Explicit browser demo, not the native filesystem implementation. */
export class BrowserBackend implements Backend {
  private readonly key = "basalt-demo-v1";
  /** Last parsed snapshot, keyed by the raw string, so reads are not re-parsed. */
  private cache: { raw: string; files: Record<string, string> } | null = null;

  /** A copy the caller may change and save. */
  private files(): Record<string, string> {
    return { ...this.current() };
  }

  /**
   * The parsed snapshot itself, for reads only. Copying it on every read made
   * indexing a large demo vault quadratic.
   */
  private current(): Readonly<Record<string, string>> {
    const saved = localStorage.getItem(this.key);
    if (!saved) return INITIAL;
    if (this.cache?.raw === saved) return this.cache.files;
    const value: unknown = JSON.parse(saved);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.values(value).some((v) => typeof v !== "string")
    ) {
      throw new Error(
        t("Browser-Speicher beschädigt. Bitte die Demo-Daten sichern, bevor du sie zurücksetzt."),
      );
    }
    this.cache = { raw: saved, files: value as Record<string, string> };
    return this.cache.files;
  }

  async info(): Promise<VaultInfo> {
    return {
      id: this.key,
      name: t("Mein Vault"),
      files: Object.keys(this.current())
        .filter((path) => !path.startsWith(".basalt/"))
        .sort(),
      platform: "browser",
    };
  }

  async read(path: string): Promise<string> {
    const files = this.current();
    if (!Object.hasOwn(files, path)) throw new Error(t("Notiz nicht gefunden."));
    return files[path];
  }

  async create(path: string, text: string): Promise<void> {
    const files = this.files();
    if (Object.hasOwn(files, path))
      throw new Error(t("Eine Notiz mit diesem Namen existiert bereits."));
    files[path] = text;
    localStorage.setItem(this.key, JSON.stringify(files));
  }

  async save(
    path: string,
    text: string,
    expected: string,
    _vaultId?: string,
    backup = true,
  ): Promise<void> {
    const files = this.files();
    if (!Object.hasOwn(files, path) || files[path] !== expected)
      throw new Error(
        t("Die Notiz wurde außerhalb des Editors geändert. Bitte zuerst neu laden."),
      );
    if (files[path] === text) return;
    if (!backup) {
      files[path] = text;
      localStorage.setItem(this.key, JSON.stringify(files));
      return;
    }
    // Like the native vault, keep the previous content. Browser storage is
    // small, so the demo keeps only the newest versions of each note.
    const history = `${HISTORY_DIR}/${path}/`;
    files[`${history}${freeBackupId(files, (id) => `${history}${id}.md`)}.md`] =
      files[path];
    const versions = Object.keys(files)
      .filter((key) => key.startsWith(history))
      .map((key) => parseBackup(key))
      .filter((backup): backup is BackupEntry => !!backup);
    for (const old of sortBackups(versions).slice(DEMO_VERSIONS))
      delete files[old.location];
    files[path] = text;
    localStorage.setItem(this.key, JSON.stringify(files));
  }

  async remove(path: string, expected?: string): Promise<void> {
    validateNotePath(path);
    const files = this.files();
    if (!Object.hasOwn(files, path)) throw new Error(t("Datei nicht gefunden."));
    if (expected !== undefined && files[path] !== expected)
      throw new Error(
        t("Die Datei wurde außerhalb des Editors geändert. Bitte zuerst neu laden."),
      );
    const trash = (id: string) => `${TRASH_DIR}/${id}/${path}`;
    files[trash(freeBackupId(files, trash))] = files[path];
    delete files[path];
    // One storage write commits both backup and removal, or neither.
    localStorage.setItem(this.key, JSON.stringify(files));
  }

  async move(from: string, to: string, expected?: string): Promise<void> {
    validateNotePath(from);
    validateNotePath(to);
    const files = this.files();
    if (!Object.hasOwn(files, from)) throw new Error(t("Datei nicht gefunden."));
    if (Object.hasOwn(files, to))
      throw new Error(t("Am Ziel existiert bereits eine Datei mit diesem Namen."));
    if (expected !== undefined && files[from] !== expected)
      throw new Error(
        t("Die Datei wurde außerhalb des Editors geändert. Bitte zuerst neu laden."),
      );
    files[to] = files[from];
    delete files[from];
    // One storage write commits the move as a whole, or not at all.
    localStorage.setItem(this.key, JSON.stringify(files));
  }

  async backups(_vaultId?: string, all = false): Promise<BackupEntry[]> {
    const encoder = new TextEncoder();
    const files = this.current();
    return sortBackups(
      Object.keys(files)
        .map((key) => parseBackup(key, encoder.encode(files[key]).length))
        .filter(
          (backup): backup is BackupEntry =>
            !!backup && (all || isDocumentBackup(backup)),
        ),
    );
  }

  async removeBackups(locations: string[]): Promise<number> {
    const files = this.files();
    for (const location of locations) {
      if (!parseBackup(location)) throw new Error(t("Sicherung nicht gefunden."));
      if (!Object.hasOwn(files, location))
        throw new Error(t("Sicherung nicht gefunden."));
      delete files[location];
    }
    localStorage.setItem(this.key, JSON.stringify(files));
    return locations.length;
  }

  async readBackup(location: string): Promise<string> {
    const backup = parseBackup(location);
    const files = this.current();
    if (!backup || !isDocumentBackup(backup) || !Object.hasOwn(files, location))
      throw new Error(t("Sicherung nicht gefunden."));
    return files[location];
  }

  async choose(): Promise<null> {
    throw new Error(
      t("Ordner-Vaults sind in der nativen Linux- und Android-App verfügbar. Dies ist die Browser-Demo."),
    );
  }

  async export(path: string, text: string): Promise<boolean> {
    const type = /\.html?$/i.test(path) ? "text/html" : "text/markdown";
    const url = URL.createObjectURL(
      new Blob([text], { type: `${type};charset=utf-8` }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = path.split("/").pop() ?? "Notiz.md";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
}

class NativeBackend implements Backend {
  private vaultId = "";
  async info(): Promise<VaultInfo> {
    const info = await invoke<VaultInfo>("vault_info");
    this.vaultId = info.id;
    return info;
  }
  read(path: string, vaultId = this.vaultId): Promise<string> {
    return invoke("read_note", { path, vaultId });
  }
  create(path: string, text: string, vaultId = this.vaultId): Promise<void> {
    return invoke("create_note", { path, text, vaultId });
  }
  async remove(
    path: string,
    expected?: string,
    vaultId = this.vaultId,
  ): Promise<void> {
    const port = new NativeVaultPort(vaultId);
    const current = await port.read(path);
    if (
      expected !== undefined &&
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        current.bytes,
      ) !== expected
    )
      throw new Error(
        t("Die Datei wurde außerhalb des Editors geändert. Bitte zuerst neu laden."),
      );
    await port.remove(path, current.version);
  }
  async move(
    from: string,
    to: string,
    expected?: string,
    vaultId = this.vaultId,
  ): Promise<void> {
    const port = new NativeVaultPort(vaultId);
    const current = await port.read(from);
    if (
      expected !== undefined &&
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        current.bytes,
      ) !== expected
    )
      throw new Error(
        t("Die Datei wurde außerhalb des Editors geändert. Bitte zuerst neu laden."),
      );
    // Exclusive creation first, so an existing file is never overwritten.
    await port.create(to, current.bytes);
    try {
      // Version-checked; the backend keeps a backup in .basalt/trash/.
      await port.remove(from, current.version);
    } catch (error) {
      // Never delete the destination as a rollback: it may by now be the
      // only remaining copy.
      throw new Error(
        t("Verschieben nicht abgeschlossen: Die Kopie unter „{path}“ bleibt erhalten, das Original konnte nicht entfernt werden. Bitte die Dateiliste neu laden.", { path: to }),
        { cause: error },
      );
    }
  }
  save(
    path: string,
    text: string,
    expected: string,
    vaultId = this.vaultId,
    backup = true,
  ): Promise<void> {
    return invoke("save_note", { path, text, expected, vaultId, backup });
  }
  async choose(): Promise<VaultInfo | null> {
    const info = await invoke<VaultInfo | null>("choose_vault", {
      vaultId: this.vaultId,
    });
    if (info) this.vaultId = info.id;
    return info;
  }
  export(name: string, text: string): Promise<boolean> {
    return invoke("export_note", { name, text });
  }
  backups(vaultId = this.vaultId, all = false): Promise<BackupEntry[]> {
    return invoke("backup_list", { vaultId, all });
  }
  removeBackups(locations: string[], vaultId = this.vaultId): Promise<number> {
    return invoke("backup_remove", { locations, vaultId });
  }
  readBackup(location: string, vaultId = this.vaultId): Promise<string> {
    return invoke("backup_read", { location, vaultId });
  }
}

export const backend: Backend = native
  ? new NativeBackend()
  : new BrowserBackend();
