import { TFile, TFolder } from "../compat/files";
import { CONFIG_DIRECTORY } from "../compat/plugin-bundles";
import type { Vault } from "../compat/vault";

/** `.obsidian/snippets` and `.obsidian/themes` map to these folders. */
export const SNIPPET_FOLDER = `${CONFIG_DIRECTORY}/snippets`;
export const THEME_FOLDER = `${CONFIG_DIRECTORY}/themes`;
/** Obsidian's appearance.json; other keys in it are kept as they are. */
export const APPEARANCE_FILE = `${CONFIG_DIRECTORY}/appearance.json`;
/** Large style sheets slow every repaint; themes stay far below this. */
export const MAX_STYLE_BYTES = 4 * 1024 * 1024;

export interface Appearance {
  /** Folder name of the theme in use; "" for Basalt's own look. */
  cssTheme: string;
  enabledCssSnippets: string[];
}

const textDecoder = new TextDecoder();

function cssFiles(vault: Vault, folder: string): TFile[] {
  const root = vault.getAbstractFileByPath(folder);
  if (!(root instanceof TFolder)) return [];
  return root.children.filter(
    (entry): entry is TFile =>
      entry instanceof TFile && entry.extension.toLowerCase() === "css",
  );
}

/** Snippet names (file names without `.css`), sorted. */
export function listSnippets(vault: Vault): string[] {
  return cssFiles(vault, SNIPPET_FOLDER)
    .map((file) => file.basename)
    .sort((a, b) => a.localeCompare(b));
}

/** Theme folder names that contain a `theme.css`, sorted. */
export function listThemes(vault: Vault): string[] {
  const root = vault.getAbstractFileByPath(THEME_FOLDER);
  if (!(root instanceof TFolder)) return [];
  return root.children
    .filter(
      (entry): entry is TFolder =>
        entry instanceof TFolder &&
        vault.getAbstractFileByPath(`${entry.path}/theme.css`) instanceof TFile,
    )
    .map((folder) => folder.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function readAppearance(vault: Vault): Promise<Appearance> {
  const file = vault.getAbstractFileByPath(APPEARANCE_FILE);
  const fallback: Appearance = { cssTheme: "", enabledCssSnippets: [] };
  if (!(file instanceof TFile)) return fallback;
  let value: unknown;
  try {
    value = JSON.parse(await vault.read(file));
  } catch {
    return fallback;
  }
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  return {
    cssTheme: typeof record.cssTheme === "string" ? record.cssTheme : "",
    enabledCssSnippets: Array.isArray(record.enabledCssSnippets)
      ? record.enabledCssSnippets.filter(
          (name): name is string => typeof name === "string",
        )
      : [],
  };
}

/**
 * Writes the two keys Basalt manages and keeps every other key of an
 * existing appearance.json. The write is version-checked; a file changed
 * meanwhile makes it fail rather than be overwritten.
 */
export async function writeAppearance(
  vault: Vault,
  appearance: Appearance,
): Promise<void> {
  const file = vault.getAbstractFileByPath(APPEARANCE_FILE);
  let record: Record<string, unknown> = {};
  if (file instanceof TFile) {
    try {
      const parsed: unknown = JSON.parse(await vault.read(file));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        record = parsed as Record<string, unknown>;
    } catch {
      // A broken file is replaced; the version check still guards the write.
    }
  }
  record.cssTheme = appearance.cssTheme;
  record.enabledCssSnippets = appearance.enabledCssSnippets;
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (file instanceof TFile) await vault.modify(file, text);
  else {
    if (!vault.getAbstractFileByPath(CONFIG_DIRECTORY)) {
      const parent = CONFIG_DIRECTORY.slice(
        0,
        CONFIG_DIRECTORY.lastIndexOf("/"),
      );
      if (parent && !vault.getAbstractFileByPath(parent))
        await vault.createFolder(parent);
      await vault.createFolder(CONFIG_DIRECTORY);
    }
    await vault.create(APPEARANCE_FILE, text);
  }
}

async function readCss(vault: Vault, path: string): Promise<string | null> {
  const file = vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;
  if (file.stat.size > MAX_STYLE_BYTES)
    throw new Error(`${path} is larger than 4 MiB`);
  return textDecoder.decode(await vault.readBinary(file));
}

/**
 * The theme and the enabled snippets as `<style>` elements after the app's
 * own styles, so they win like in Obsidian. Snippets come after the theme.
 */
export class VaultStyles {
  private elements: HTMLStyleElement[] = [];
  private run = 0;

  /** Applies `appearance`; returns the names whose CSS could not be read. */
  async apply(vault: Vault, appearance: Appearance): Promise<string[]> {
    const run = ++this.run;
    const failed: string[] = [];
    const sheets: Array<{ kind: string; name: string; css: string }> = [];
    const load = async (kind: string, name: string, path: string) => {
      try {
        const css = await readCss(vault, path);
        if (css !== null) sheets.push({ kind, name, css });
      } catch (error) {
        console.warn(error);
        failed.push(name);
      }
    };
    if (appearance.cssTheme)
      await load(
        "theme",
        appearance.cssTheme,
        `${THEME_FOLDER}/${appearance.cssTheme}/theme.css`,
      );
    for (const name of appearance.enabledCssSnippets)
      await load("snippet", name, `${SNIPPET_FOLDER}/${name}.css`);
    if (run !== this.run) return failed;
    this.clear();
    this.run = run;
    for (const sheet of sheets) {
      const style = document.createElement("style");
      style.dataset.basaltStyle = sheet.kind;
      style.dataset.name = sheet.name;
      style.textContent = sheet.css;
      document.head.append(style);
      this.elements.push(style);
    }
    document.body.classList.toggle("has-vault-theme", !!appearance.cssTheme);
    return failed;
  }

  clear(): void {
    this.run++;
    for (const element of this.elements) element.remove();
    this.elements = [];
    document.body.classList.remove("has-vault-theme");
  }
}
