import { formatDate } from "../dates";
import { getLocale } from "../i18n";

const TEMPLATE_PATH = /(^|\/)_templates\/.+\.md$/i;

export function templatePaths(files: readonly string[]): string[] {
  return files.filter(path => TEMPLATE_PATH.test(path)).sort();
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
