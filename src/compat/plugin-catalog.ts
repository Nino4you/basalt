import { TFile, TFolder } from "./files";
import type { PluginManifest } from "./plugin";
import {
  MAX_MANIFEST_BYTES,
  MAX_STYLES_BYTES,
  PLUGIN_DIRECTORY,
} from "./plugin-bundles";
import { MAX_PLUGIN_SOURCE_BYTES, parsePluginManifest } from "./plugin-module";
import type { RequestUrl } from "./request";
import type { Vault } from "./vault";

/**
 * The Obsidian community plugin list and download counts, as published by
 * obsidianmd/obsidian-releases. Basalt reads them; it does not host plugins.
 */
const RELEASES =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases";
export const CATALOG_URL = `${RELEASES}/master/community-plugins.json`;
export const STATS_URL = `${RELEASES}/master/community-plugin-stats.json`;

/**
 * Plugins whose unmodified release was checked with Basalt, and the version
 * that was checked (see docs/plugin-compatibility.md). Everything else in the
 * catalog is untested: it may work, partly work or fail visibly.
 */
export const VERIFIED_PLUGINS: Readonly<Record<string, string>> = {
  "obsidian-excalidraw-plugin": "2.29.2",
  "obsidian-icon-folder": "2.14.7",
};

/** Written next to an installed plugin, so updates know where it came from. */
export const SOURCE_FILE = "basalt-source.json";

const PLUGIN_ID = /^[a-z0-9][a-z0-9_-]*$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export interface CatalogEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  /** `owner/name` on GitHub. */
  repo: string;
  downloads: number;
  /** The version checked with Basalt, or `null` for untested plugins. */
  verified: string | null;
}

export interface PluginFiles {
  manifest: Readonly<PluginManifest>;
  manifestText: string;
  main: string;
  styles: string | null;
}

export interface InstalledSource {
  repo: string;
  version: string;
  installedAt: string;
}

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** Validated catalog entries; malformed ones are dropped, not guessed at. */
export function parseCatalog(value: unknown, stats?: unknown): CatalogEntry[] {
  if (!Array.isArray(value))
    throw new Error("The plugin catalog is not a list");
  const counts =
    stats && typeof stats === "object" && !Array.isArray(stats)
      ? (stats as Record<string, unknown>)
      : {};
  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const id = text(raw.id);
    const repo = text(raw.repo);
    const name = text(raw.name);
    if (!PLUGIN_ID.test(id) || !REPO.test(repo) || !name || seen.has(id))
      continue;
    seen.add(id);
    const stat = counts[id];
    const downloads =
      stat &&
      typeof stat === "object" &&
      typeof (stat as { downloads?: unknown }).downloads === "number"
        ? (stat as { downloads: number }).downloads
        : 0;
    entries.push({
      id,
      name,
      author: text(raw.author),
      description: text(raw.description),
      repo,
      downloads,
      verified: VERIFIED_PLUGINS[id] ?? null,
    });
  }
  return entries;
}

/** The catalog with download counts; missing counts only change the order. */
export async function loadCatalog(
  request: RequestUrl,
): Promise<CatalogEntry[]> {
  const [catalog, stats] = await Promise.all([
    request({ url: CATALOG_URL }),
    request({ url: STATS_URL }).then(
      (response) => response.json,
      () => undefined,
    ),
  ]);
  return parseCatalog(catalog.json, stats);
}

/**
 * Entries matching every word of `query` in name, id, author or description.
 * Checked plugins come first, then names that match, then popular ones.
 */
export function searchCatalog(
  entries: CatalogEntry[],
  query: string,
): CatalogEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: Array<{ entry: CatalogEntry; score: number }> = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const haystack = `${name} ${entry.id} ${entry.author.toLowerCase()} ${entry.description.toLowerCase()}`;
    if (!words.every((word) => haystack.includes(word))) continue;
    let score = entry.verified ? 4 : 0;
    if (words.length && words.every((word) => name.includes(word)))
      score += name.startsWith(words[0]) ? 3 : 2;
    scored.push({ entry, score });
  }
  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.entry.downloads - a.entry.downloads ||
        a.entry.name.localeCompare(b.entry.name),
    )
    .map(({ entry }) => entry);
}

/**
 * The checked version for a plugin installed from `repo`, or `null`. The
 * check applies to the catalog's repository only: a fork, or any other
 * repository whose manifest reuses a checked plugin's id, is untested.
 * GitHub repository names are case-insensitive.
 */
export function verifiedVersion(
  entry: Pick<CatalogEntry, "repo" | "verified"> | undefined,
  repo: string | null,
): string | null {
  if (!entry?.verified || !repo) return null;
  return entry.repo.toLowerCase() === repo.toLowerCase()
    ? entry.verified
    : null;
}

/** `owner/name` from what people paste: the short form or a GitHub URL. */
export function parseRepo(input: string): string | null {
  const value = input
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const [owner, name] = value.split("/");
  const repo = owner && name ? `${owner}/${name}` : "";
  return REPO.test(repo) ? repo : null;
}

const byteLength = (value: string) =>
  new TextEncoder().encode(value).byteLength;

/**
 * Checks a plugin's files before anything is written: a valid manifest (with
 * `expectedId` when the source names one), a non-empty `main.js`, and the same
 * size limits the loader applies.
 */
export function validatePluginFiles(
  manifestText: string,
  main: string,
  styles: string | null,
  expectedId?: string,
): PluginFiles {
  if (byteLength(manifestText) > MAX_MANIFEST_BYTES)
    throw new Error("manifest.json exceeds the 64 KiB limit");
  let value: unknown;
  try {
    value = JSON.parse(manifestText);
  } catch {
    throw new Error("manifest.json is not valid JSON");
  }
  const manifest = parsePluginManifest(value, expectedId);
  if (!main.trim()) throw new Error("main.js is empty");
  if (byteLength(main) > MAX_PLUGIN_SOURCE_BYTES)
    throw new Error("main.js exceeds the 8 MiB limit");
  if (styles !== null && byteLength(styles) > MAX_STYLES_BYTES)
    throw new Error("styles.css exceeds the 1 MiB limit");
  return { manifest, manifestText, main, styles };
}

function releaseUrl(repo: string, file: string): string {
  return `https://github.com/${repo}/releases/latest/download/${file}`;
}

/** The manifest of a repository's latest release. */
export async function latestManifest(
  repo: string,
  request: RequestUrl,
): Promise<Readonly<PluginManifest>> {
  const response = await request({
    url: releaseUrl(repo, "manifest.json"),
    throw: false,
  });
  if (response.status !== 200)
    throw new Error(
      `${repo} has no release with a manifest.json (HTTP ${response.status})`,
    );
  return parsePluginManifest(JSON.parse(response.text));
}

/**
 * Downloads `manifest.json`, `main.js` and the optional `styles.css` of a
 * repository's latest release, the files Obsidian installs too.
 */
export async function downloadRelease(
  repo: string,
  request: RequestUrl,
  expectedId?: string,
): Promise<PluginFiles> {
  const get = (file: string) =>
    request({ url: releaseUrl(repo, file), throw: false });
  const [manifest, main, styles] = await Promise.all([
    get("manifest.json"),
    get("main.js"),
    get("styles.css"),
  ]);
  if (manifest.status !== 200 || main.status !== 200)
    throw new Error(
      `${repo} has no release with manifest.json and main.js (HTTP ${manifest.status}/${main.status})`,
    );
  return validatePluginFiles(
    manifest.text,
    main.text,
    styles.status === 200 ? styles.text : null,
    expectedId,
  );
}

/** Compares dotted version numbers; pre-release suffixes sort before the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core, pre = ""] = value.replace(/^v/i, "").split("-", 2);
    return {
      parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      pre,
    };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

async function ensureFolder(vault: Vault, path: string): Promise<void> {
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const folder = parts.slice(0, i).join("/");
    const existing = vault.getAbstractFileByPath(folder);
    if (existing instanceof TFolder) continue;
    if (existing) throw new Error(`${folder} is a file, not a folder`);
    await vault.createFolder(folder);
  }
}

async function write(vault: Vault, path: string, data: string): Promise<void> {
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) await vault.modify(existing, data);
  else if (existing) throw new Error(`${path} is a folder, not a file`);
  else await vault.create(path, data);
}

/**
 * Writes a plugin into `Basalt/Plugins/<id>/`. An existing installation is
 * updated in place (every replaced file keeps a backup, like any vault write);
 * its `data.json` settings stay. Installing never enables a plugin.
 */
export async function installPlugin(
  vault: Vault,
  files: PluginFiles,
  source: { repo: string } | null,
): Promise<{ id: string; updated: boolean }> {
  const id = files.manifest.id;
  const folder = `${PLUGIN_DIRECTORY}/${id}`;
  const updated =
    vault.getAbstractFileByPath(`${folder}/manifest.json`) instanceof TFile;
  await ensureFolder(vault, folder);
  await write(vault, `${folder}/main.js`, files.main);
  const styles = vault.getAbstractFileByPath(`${folder}/styles.css`);
  if (files.styles !== null)
    await write(vault, `${folder}/styles.css`, files.styles);
  // An update without styles must not keep the old version's styles.
  else if (styles instanceof TFile) await vault.delete(styles);
  if (source) {
    const record: InstalledSource = {
      repo: source.repo,
      version: files.manifest.version,
      installedAt: new Date().toISOString(),
    };
    await write(
      vault,
      `${folder}/${SOURCE_FILE}`,
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }
  // The manifest last: a folder only counts as a plugin once it is complete.
  await write(vault, `${folder}/manifest.json`, files.manifestText);
  return { id, updated };
}

/** Where an installed plugin came from, if Basalt installed it from GitHub. */
export async function installedSource(
  vault: Vault,
  id: string,
): Promise<InstalledSource | null> {
  if (!PLUGIN_ID.test(id)) return null;
  const file = vault.getAbstractFileByPath(
    `${PLUGIN_DIRECTORY}/${id}/${SOURCE_FILE}`,
  );
  if (!(file instanceof TFile)) return null;
  try {
    const value = JSON.parse(
      await vault.read(file),
    ) as Partial<InstalledSource>;
    return typeof value.repo === "string" &&
      REPO.test(value.repo) &&
      typeof value.version === "string"
      ? {
          repo: value.repo,
          version: value.version,
          installedAt: String(value.installedAt ?? ""),
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * Removes every file of a plugin, its settings included. Deleted files go to
 * the vault trash like any deletion; the empty folder stays, because Basalt
 * never deletes folders. The caller disables the plugin first.
 */
export async function uninstallPlugin(vault: Vault, id: string): Promise<void> {
  if (!PLUGIN_ID.test(id)) throw new Error("Invalid plugin id");
  const prefix = `${PLUGIN_DIRECTORY}/${id}/`;
  const files = vault
    .getAllLoadedFiles()
    .filter(
      (entry): entry is TFile =>
        entry instanceof TFile && entry.path.startsWith(prefix),
    )
    // The manifest first: from then on the folder no longer lists as a plugin.
    .sort(
      (a, b) =>
        Number(b.name === "manifest.json") - Number(a.name === "manifest.json"),
    );
  for (const file of files) await vault.delete(file);
}
