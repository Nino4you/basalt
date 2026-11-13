import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { TextLayer } from "pdfjs-dist";
import { h } from "../ui/dom";

/** One page at a time bounds raster memory, including for embedded PDFs. */
export class PdfView {
  readonly el = h("section", { class: "pdf-view", attrs: { "aria-label": "PDF-Dokument" } });
  private readonly previous = h("button", { text: "‹", label: "Vorherige PDF-Seite" });
  private readonly next = h("button", { text: "›", label: "Nächste PDF-Seite" });
  private readonly pageNumber = h("input", {
    class: "pdf-page-number", attrs: { type: "number", min: "1", "aria-label": "PDF-Seite" },
  });
  private readonly count = h("span");
  private readonly zoom = h("select", { class: "dropdown", attrs: { "aria-label": "PDF-Vergrößerung" } },
    ...[["width", "Breite"], ["1", "100 %"], ["1.25", "125 %"], ["1.5", "150 %"], ["2", "200 %"]]
      .map(([value, text]) => h("option", { text, attrs: { value } })));
  private readonly status = h("div", { class: "pdf-status", attrs: { role: "status" } });
  private readonly viewport = h("div", "pdf-viewport");
  private task: PDFDocumentLoadingTask | null = null;
  private pdf: PDFDocumentProxy | null = null;
  private rendering: RenderTask | null = null;
  private textLayer: TextLayer | null = null;
  private generation = 0;
  private disposed = false;
  private page = 1;
  private width = 0;
  private readonly observer: ResizeObserver;

  constructor() {
    const toolbar = h("div", { class: "pdf-toolbar", attrs: { role: "group", "aria-label": "PDF-Seitennavigation" } },
      this.previous, this.pageNumber, this.count, this.next, this.zoom);
    this.el.append(toolbar, this.status, this.viewport);
    this.previous.disabled = this.next.disabled = this.pageNumber.disabled = this.zoom.disabled = true;
    this.previous.addEventListener("click", () => void this.render(this.page - 1));
    this.next.addEventListener("click", () => void this.render(this.page + 1));
    this.pageNumber.addEventListener("change", () => void this.render(Number(this.pageNumber.value)));
    this.zoom.addEventListener("change", () => void this.render(this.page));
    this.observer = new ResizeObserver(() => {
      const width = this.viewport.clientWidth;
      if (width > 0 && width !== this.width && this.pdf && this.zoom.value === "width") void this.render(this.page);
    });
    this.observer.observe(this.viewport);
  }

  async load(data: ArrayBuffer, page = 1): Promise<void> {
    this.status.textContent = "PDF wird geladen …";
    try {
      const runtime = await import("./pdf-runtime");
      if (this.disposed) return;
      this.task = runtime.loadPdf(data);
      this.pdf = await this.task.promise;
      if (this.disposed) return;
      await this.render(page);
    } catch {
      if (!this.disposed) this.status.textContent = "PDF konnte nicht angezeigt werden. Die Datei ist beschädigt oder passwortgeschützt.";
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.observer.disconnect();
    this.rendering?.cancel();
    this.textLayer?.cancel();
    void this.task?.destroy().catch(() => {});
    this.pdf = null;
    this.viewport.replaceChildren();
    this.el.remove();
  }

  private async render(requestedPage: number): Promise<void> {
    const pdf = this.pdf;
    if (!pdf || this.disposed) return;
    const generation = ++this.generation;
    this.rendering?.cancel();
    this.textLayer?.cancel();
    this.page = Number.isFinite(requestedPage) ? Math.max(1, Math.min(pdf.numPages, Math.floor(requestedPage))) : 1;
    this.pageNumber.value = String(this.page);
    this.pageNumber.max = String(pdf.numPages);
    this.pageNumber.disabled = false;
    this.zoom.disabled = false;
    this.count.textContent = `/ ${pdf.numPages}`;
    this.previous.disabled = this.page === 1;
    this.next.disabled = this.page === pdf.numPages;
    this.status.textContent = `Seite ${this.page} wird geladen …`;
    let page: PDFPageProxy | null = null;
    try {
      page = await pdf.getPage(this.page);
      if (generation !== this.generation) return;
      this.width = this.viewport.clientWidth;
      const natural = page.getViewport({ scale: 1 });
      const scale = this.zoom.value === "width"
        ? Math.min(3, Math.max(0.1, (this.width - 24) / natural.width)) : Number(this.zoom.value);
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
      const canvas = h("canvas", { attrs: { "aria-hidden": "true" } });
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const text = h("div", "textLayer");
      const holder = h("div", "pdf-page", canvas, text);
      holder.style.width = `${viewport.width}px`;
      holder.style.height = `${viewport.height}px`;
      holder.style.setProperty("--total-scale-factor", String(scale * page.userUnit));
      this.viewport.replaceChildren(holder);
      const runtime = await import("./pdf-runtime");
      if (generation !== this.generation) return;
      this.rendering = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await this.rendering.promise;
      if (generation !== this.generation) return;
      const textContent = await page.getTextContent();
      if (generation !== this.generation) return;
      this.textLayer = new runtime.TextLayer({ textContentSource: textContent, container: text, viewport });
      await this.textLayer.render();
      if (generation !== this.generation) return;
      this.status.textContent = `Seite ${this.page} von ${pdf.numPages}`;
    } catch {
      if (generation === this.generation && !this.disposed)
        this.status.textContent = "PDF-Seite konnte nicht angezeigt werden.";
    } finally {
      page?.cleanup();
    }
  }
}
