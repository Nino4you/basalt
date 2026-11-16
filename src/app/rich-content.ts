import { t } from "../i18n";
/**
 * Progressive enhancements that are only downloaded when a note uses them.
 * Keeping them out of the initial bundle protects vault opening performance.
 */
import { mathSpans } from "../editor/math-source";

type Katex = typeof import("katex").default;
let mathRenderer: Promise<Katex> | null = null;

function loadMathRenderer(): Promise<Katex> {
  mathRenderer ??= Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css"),
  ]).then(([{ default: katex }]) => katex);
  return mathRenderer;
}

/** KaTeX auto-render pairs bare dollars, so prices like `$5 und $10` need a guard. */
function renderMath(root: HTMLElement, katex: Katex): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("pre, code, script, style, textarea, .katex")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.textContent ?? "";
    if (!text.includes("$")) continue;
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of mathSpans(text)) {
      const expression = match.expression;
      const start = match.from;
      if (!expression) continue;
      fragment.append(text.slice(last, start));
      const span = document.createElement("span");
      span.className = "katex-math";
      try {
        katex.render(expression, span, {
          displayMode: match.display,
          throwOnError: false,
          strict: "ignore",
        });
        fragment.append(span);
      } catch {
        fragment.append(match.source);
      }
      last = match.to;
    }
    if (!last) continue;
    fragment.append(text.slice(last));
    node.replaceWith(fragment);
  }
}

/** Renders `$…$` and `$$…$$` once the note actually contains a formula. */
export function enhanceMath(
  root: HTMLElement,
  isCurrent: () => boolean,
  onSettled?: () => void,
): void {
  if (!root.textContent?.includes("$")) return;
  void loadMathRenderer()
    .then((katex) => {
      if (isCurrent()) renderMath(root, katex);
    })
    .catch((error) => console.warn(t("Formeln konnten nicht dargestellt werden"), error))
    .finally(() => {
      if (isCurrent()) onSettled?.();
    });
}

type Mermaid = typeof import("mermaid").default;
let mermaidRenderer: Promise<Mermaid> | null = null;
let diagramId = 0;

export function loadMermaid(): Promise<Mermaid> {
  mermaidRenderer ??= import("mermaid").then(({ default: mermaid }) => mermaid);
  return mermaidRenderer;
}

/**
 * Resolves an app color token to `rgb(...)`. Mermaid derives shades from its
 * theme colors and cannot parse `var()` or `color-mix()` itself.
 */
function tokenColor(name: string, fallback: string): string {
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.color = `var(${name}, ${fallback})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return /^(rgba?|hsla?)\(|^#/.test(color) ? color : fallback;
}

/** Mermaid's `base` theme painted with the app's tokens instead of its own palette. */
export function mermaidConfig() {
  const dark = document.body.classList.contains("theme-dark");
  const text = tokenColor("--text-normal", dark ? "#dadada" : "#222222");
  const muted = tokenColor("--text-muted", dark ? "#b3b3b3" : "#5c5c5c");
  const surface = tokenColor(
    "--background-secondary",
    dark ? "#262626" : "#f6f6f6",
  );
  const page = tokenColor("--background-primary", dark ? "#1e1e1e" : "#ffffff");
  const accent = tokenColor("--interactive-accent", "#8a5cf5");
  const border = tokenColor(
    "--background-modifier-border",
    dark ? "#363636" : "#e0e0e0",
  );
  const font =
    getComputedStyle(document.body).getPropertyValue("--font-text").trim() ||
    "sans-serif";
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    theme: "base" as const,
    darkMode: dark,
    fontFamily: font,
    themeVariables: {
      darkMode: dark,
      fontFamily: font,
      fontSize: "14px",
      background: page,
      primaryColor: surface,
      primaryTextColor: text,
      primaryBorderColor: accent,
      secondaryColor: page,
      tertiaryColor: surface,
      lineColor: muted,
      textColor: text,
      mainBkg: surface,
      nodeBorder: accent,
      clusterBkg: page,
      clusterBorder: border,
      edgeLabelBackground: page,
      noteBkgColor: surface,
      noteBorderColor: border,
      noteTextColor: text,
      // The neo look's fixed grey drop shadow glows on dark backgrounds.
      dropShadow: "none",
    },
  };
}

/** Replaces Mermaid code blocks with diagrams, keeping the source on failure. */
export function enhanceMermaid(
  root: HTMLElement,
  isCurrent: () => boolean,
  onSettled?: () => void,
): void {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
  if (!blocks.length) return;
  const sources = blocks.map((code) => {
    const holder = document.createElement("div");
    holder.className = "mermaid-diagram";
    const source = code.textContent ?? "";
    holder.dataset.source = source;
    code.parentElement?.replaceWith(holder);
    return { holder, source };
  });
  const showSource = (holder: HTMLElement, source: string) => {
    if (!isCurrent()) return;
    const fallback = document.createElement("pre");
    fallback.className = "mermaid-error";
    fallback.textContent = source;
    holder.replaceChildren(fallback);
  };
  void loadMermaid()
    .then(async (mermaid) => {
      // Re-read the theme per batch so a light/dark switch reaches new diagrams.
      mermaid.initialize(mermaidConfig());
      for (const { holder, source } of sources) {
        if (!isCurrent()) return;
        try {
          const { svg } = await mermaid.render(`basalt-diagram-${++diagramId}`, source);
          if (isCurrent()) holder.innerHTML = svg;
        } catch (error) {
          console.warn(t("Mermaid-Diagramm konnte nicht dargestellt werden"), error);
          showSource(holder, source);
        }
      }
    })
    .catch((error) => {
      console.warn(t("Mermaid konnte nicht geladen werden"), error);
      for (const { holder, source } of sources) showSource(holder, source);
    })
    .finally(() => {
      if (isCurrent()) onSettled?.();
    });
}
