const TEMPLATE_PATH = /(^|\/)_templates\/.+\.md$/i;

export function templatePaths(files: readonly string[]): string[] {
  return files.filter(path => TEMPLATE_PATH.test(path)).sort();
}

/** Obsidian's built-in date/time tokens, evaluated once when the template is inserted. */
export function expandTemplate(text: string, title: string, date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const values: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  };
  const format = (pattern: string) => pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, token => values[token]);
  return text
    .replace(/\{\{title\}\}/g, () => title)
    .replace(/\{\{date(?::([^}]*))?\}\}/g, (_match, pattern: string | undefined) =>
      format(pattern || "YYYY-MM-DD"),
    )
    .replace(/\{\{time(?::([^}]*))?\}\}/g, (_match, pattern: string | undefined) =>
      format(pattern || "HH:mm"),
    );
}
