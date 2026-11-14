import { formatDate } from "../dates";
import { getLocale } from "../i18n";

const TEMPLATE_PATH = /(^|\/)_templates\/.+\.md$/i;

/**
 * Notes that can be used as templates: the ones in `folder` (and below), or,
 * without a folder, in any folder called `_templates`.
 */
export function templatePaths(files: readonly string[], folder = ""): string[] {
  const root = folder.replace(/^\/+|\/+$/g, "");
  return files
    .filter((path) =>
      root
        ? path.startsWith(`${root}/`) && /\.md$/i.test(path)
        : TEMPLATE_PATH.test(path),
    )
    .sort();
}

/** Obsidian's built-in date/time tokens, evaluated once when the template is inserted. */
export function expandTemplate(text: string, title: string, date = new Date()): string {
  const format = (pattern: string) => formatDate(date, pattern, getLocale());
  return text
    .replace(/\{\{title\}\}/g, () => title)
    .replace(/\{\{date(?::([^}]*))?\}\}/g, (_match, pattern: string | undefined) =>
      format(pattern || "YYYY-MM-DD"),
    )
    .replace(/\{\{time(?::([^}]*))?\}\}/g, (_match, pattern: string | undefined) =>
      format(pattern || "HH:mm"),
    );
}
