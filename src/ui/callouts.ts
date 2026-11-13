/** Lucide icon per Obsidian callout type; shared by reading view and editor. */
const CALLOUT_ICONS: Record<string, string> = {
  note: "pencil",
  abstract: "clipboard-list",
  summary: "clipboard-list",
  tldr: "clipboard-list",
  info: "info",
  todo: "circle-check",
  tip: "flame",
  hint: "flame",
  important: "flame",
  success: "check",
  check: "check",
  done: "check",
  question: "circle-help",
  help: "circle-help",
  faq: "circle-help",
  warning: "triangle-alert",
  caution: "triangle-alert",
  attention: "triangle-alert",
  failure: "x",
  fail: "x",
  missing: "x",
  danger: "zap",
  error: "zap",
  bug: "bug",
  example: "list",
  quote: "quote",
  cite: "quote",
};

export function calloutIcon(type: string): string {
  return CALLOUT_ICONS[type.toLowerCase()] ?? "pencil";
}
