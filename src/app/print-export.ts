import { t } from "../i18n";
import { backend } from "../backend";
import { basename } from "../ui/dom";
import { notify } from "../ui/notice";
import type { App } from "./app";
import { ReadingView } from "./reading";

const ROOT_ID = "print-root";
/** Math and diagrams render asynchronously; printing waits this long at most. */
const RENDER_TIMEOUT = 5000;

/** Whether `root` still has formulas or diagrams waiting for their renderer. */
export function richContentPending(root: HTMLElement): boolean {
  return (
    !!root.querySelector(".math-inline, .math-block") ||
    [...root.querySelectorAll(".mermaid-diagram")].some(
      (diagram) => !diagram.firstElementChild,
    )
  );
}

async function settle(root: HTMLElement): Promise<void> {
  const started = Date.now();
  // Give the dynamic imports a moment to start before the first check.
  await new Promise((resolve) => setTimeout(resolve, 50));
  while (richContentPending(root) && Date.now() - started < RENDER_TIMEOUT)
    await new Promise((resolve) => setTimeout(resolve, 100));
  await document.fonts?.ready;
}

/** Interactive bits that make no sense on paper or in a static file. */
function strip(root: HTMLElement): void {
  for (const element of root.querySelectorAll(
    ".copy-code-button, .markdown-embed-link, .collapse-indicator",
  ))
    element.remove();
  for (const element of root.querySelectorAll(".callout.is-collapsed"))
    element.classList.remove("is-collapsed");
}

/**
 * Renders a note like the reading view (embeds, math, diagrams), in the light
 * theme, into a hidden container. The caller removes it with `dispose`.
 */
async function renderNote(
  app: App,
  path: string,
  text: string,
): Promise<{ root: HTMLElement; dispose: () => void }> {
  document.getElementById(ROOT_ID)?.remove();
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.className = "markdown-preview-view markdown-rendered";
  document.body.append(root);
  const view = new ReadingView(app, root);
  view.render(path, text);
  await settle(root);
  strip(root);
  return {
    root,
    dispose: () => {
      view.clear();
      root.remove();
    },
  };
}

/** Light colours for paper; restores the user's theme afterwards. */
function lightTheme(): () => void {
  const root = document.documentElement;
  const previous = root.dataset.theme;
  root.dataset.theme = "light";
  document.body.classList.add("theme-light");
  document.body.classList.remove("theme-dark");
  return () => {
    if (previous) root.dataset.theme = previous;
    document.body.classList.toggle("theme-dark", previous === "dark");
    document.body.classList.toggle("theme-light", previous !== "dark");
  };
}

/**
 * Prints the note through the system dialog, which also saves PDFs. Only
 * the note is printed; the app is hidden by the print stylesheet.
 */
export async function printNote(
  app: App,
  path: string,
  text: string,
): Promise<void> {
  const restoreTheme = lightTheme();
  const title = document.title;
  let rendered: Awaited<ReturnType<typeof renderNote>> | null = null;
  const finish = () => {
    window.removeEventListener("afterprint", finish);
    clearTimeout(safety);
    document.title = title;
    document.body.classList.remove("is-printing");
    rendered?.dispose();
    restoreTheme();
  };
  // Some engines print asynchronously; afterprint ends it, this is a fallback.
  const safety = setTimeout(finish, 10 * 60 * 1000);
  try {
    rendered = await renderNote(app, path, text);
    document.body.classList.add("is-printing");
    // PDF printers suggest the document title as the file name.
    document.title = basename(path);
    window.addEventListener("afterprint", finish);
    window.print();
  } catch (error) {
    finish();
    throw error;
  }
}

async function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Blob URLs die with the app; a standalone file needs the bytes inline. */
async function inlineImages(root: HTMLElement): Promise<void> {
  for (const image of root.querySelectorAll<HTMLImageElement>(
    "img[src^='blob:']",
  )) {
    try {
      image.src = await dataUrl(await (await fetch(image.src)).blob());
    } catch {
      image.removeAttribute("src");
    }
  }
}

/** The app's own style rules, so the file looks like the reading view. */
export function documentCss(): string {
  const rules: string[] = [];
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) rules.push(rule.cssText);
    } catch {
      // Cross-origin sheets cannot be read; the app ships none.
    }
  }
  return rules.join("\n");
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function standaloneHtml(
  title: string,
  body: string,
  css: string,
): string {
  return `<!doctype html>
<html lang="${escape(document.documentElement.lang || "en")}" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Basalt">
<title>${escape(title)}</title>
<style>
${css.replace(/<\/style/gi, "<\\/style")}
html, body { height: auto; overflow: visible; }
body { padding: 32px 16px; background: var(--background-primary); }
.markdown-preview-view { max-width: 760px; margin: 0 auto; }
</style>
</head>
<body class="theme-light">
<article class="markdown-preview-view markdown-rendered">
${body}
</article>
</body>
</html>
`;
}

/** Saves the note as one HTML file with its styles and images inside. */
export async function exportHtml(
  app: App,
  path: string,
  text: string,
): Promise<void> {
  const restoreTheme = lightTheme();
  let rendered: Awaited<ReturnType<typeof renderNote>> | null = null;
  try {
    rendered = await renderNote(app, path, text);
    await inlineImages(rendered.root);
    const title = basename(path);
    const html = standaloneHtml(title, rendered.root.innerHTML, documentCss());
    const name = path.replace(/\.md$/i, ".html");
    if (await backend.export(name, html)) notify(t("HTML-Datei exportiert."));
  } finally {
    rendered?.dispose();
    restoreTheme();
  }
}
