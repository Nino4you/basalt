export interface PreviewNote {
  title: string;
  text: string;
}

/** Plain-text excerpt for the hover card; markup is stripped, never rendered. */
export function previewExcerpt(text: string, limit = 700): string {
  const body = text
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(/```[\s\S]*?```/g, "");
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("%%"))
    .map((line) =>
      line
        .replace(/^>+\s?/, "")
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*+]\s+/, "")
        .replace(/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
        .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target, alias) => alias ?? target)
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_`~]/g, ""),
    )
    .join("\n")
    .slice(0, limit)
    .trim();
}

/** Delayed, non-interactive page preview shared by editor and reading view. */
export class LinkPreview {
  private card: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private request = 0;
  private target: string | null = null;
  private readonly dismiss = (): void => this.hide();
  private readonly escape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.hide();
  };

  constructor(
    private readonly resolve: (
      target: string,
      source: string,
    ) => PreviewNote | null,
  ) {
    document.addEventListener("pointerdown", this.dismiss, true);
    document.addEventListener("scroll", this.dismiss, true);
    document.addEventListener("keydown", this.escape, true);
  }

  show(target: string, source: string, anchor: DOMRect): void {
    if (target === this.target) {
      if (this.card) this.position(anchor);
      return;
    }
    this.hide();
    this.target = target;
    const request = this.request;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (request !== this.request) return;
      const note = this.resolve(target, source);
      if (!note || request !== this.request) {
        this.target = null;
        return;
      }
      const card = document.createElement("div");
      card.className = "link-preview";
      card.setAttribute("role", "tooltip");
      const title = document.createElement("div");
      title.className = "link-preview-title";
      title.textContent = note.title;
      const body = document.createElement("div");
      body.className = "link-preview-body";
      const lines = previewExcerpt(note.text).split("\n");
      if (lines[0] === note.title) lines.shift();
      body.textContent = lines.join("\n").trim() || "Leere Notiz";
      card.append(title, body);
      document.body.append(card);
      this.card = card;
      this.position(anchor);
    }, 300);
  }

  hide(): void {
    this.request++;
    this.target = null;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.card?.remove();
    this.card = null;
  }

  dispose(): void {
    this.hide();
    document.removeEventListener("pointerdown", this.dismiss, true);
    document.removeEventListener("scroll", this.dismiss, true);
    document.removeEventListener("keydown", this.escape, true);
  }

  private position(anchor: DOMRect): void {
    if (!this.card) return;
    const gap = 8;
    const margin = 8;
    const left = Math.min(
      Math.max(margin, anchor.left),
      Math.max(margin, window.innerWidth - this.card.offsetWidth - margin),
    );
    let top = anchor.bottom + gap;
    if (top + this.card.offsetHeight > window.innerHeight - margin)
      top = Math.max(margin, anchor.top - this.card.offsetHeight - gap);
    this.card.style.left = `${left}px`;
    this.card.style.top = `${top}px`;
  }
}
