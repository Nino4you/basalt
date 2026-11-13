import { afterEach, expect, it, vi } from "vitest";
import { PdfView } from "../../src/app/pdf";

const runtime = vi.hoisted(() => ({ load: vi.fn(), cancelText: vi.fn(), renderText: vi.fn() }));
vi.mock("../../src/app/pdf-runtime", () => ({
  loadPdf: runtime.load,
  TextLayer: class {
    constructor(private options: { container: HTMLElement; textContentSource: { text: string } }) {}
    async render() {
      runtime.renderText();
      this.options.container.textContent = this.options.textContentSource.text;
    }
    cancel = runtime.cancelText;
  },
}));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function setup(width = 600, height = 800) {
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect = disconnect; });
  const cancel = vi.fn();
  const destroy = vi.fn(async () => {});
  const cleanup = vi.fn();
  const getTextContent = vi.fn(async () => ({ text: "PDF text" }));
  const pdfPage = {
    userUnit: 1,
    getViewport: ({ scale }: { scale: number }) => ({ width: width * scale, height: height * scale }),
    render: () => ({ promise: Promise.resolve(), cancel }),
    getTextContent, cleanup,
  };
  const getPage = vi.fn(async (_page: number) => pdfPage);
  runtime.load.mockReturnValue({ promise: Promise.resolve({ numPages: 3, getPage }), destroy });
  const view = new PdfView();
  document.body.append(view.el);
  return { view, disconnect, cancel, destroy, getPage, getTextContent, cleanup, pdfPage };
}

it("clamps PDF pages, exposes readable text and disposes rendering resources", async () => {
  const { view, getPage, disconnect, cancel, destroy } = setup();
  await view.load(new ArrayBuffer(1), 200);
  expect(getPage).toHaveBeenLastCalledWith(3);
  expect(view.el.querySelector(".textLayer")?.textContent).toBe("PDF text");
  expect(view.el.querySelector<HTMLButtonElement>("button[aria-label='Nächste PDF-Seite']")?.disabled).toBe(true);
  const input = view.el.querySelector<HTMLInputElement>("input")!;
  input.value = "-20";
  input.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(getPage).toHaveBeenLastCalledWith(1));
  view.dispose();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalled();
  expect(destroy).toHaveBeenCalledOnce();
  expect(view.el.isConnected).toBe(false);
});

it("does not create a text layer after a PDF is closed during text extraction", async () => {
  const { view, getTextContent, destroy, cleanup } = setup();
  let resolve!: (value: { text: string }) => void;
  getTextContent.mockReturnValue(new Promise((done) => { resolve = done; }));
  const loading = view.load(new ArrayBuffer(1));
  await vi.waitFor(() => expect(getTextContent).toHaveBeenCalled());
  view.dispose();
  resolve({ text: "old vault contents" });
  await loading;
  expect(view.el.querySelector(".textLayer")).toBeNull();
  expect(runtime.renderText).not.toHaveBeenCalled();
  expect(destroy).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
});

it("releases a superseded page that finishes loading after the current page", async () => {
  const { view, getPage, pdfPage } = setup();
  let resolve!: (page: typeof pdfPage) => void;
  getPage.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const loading = view.load(new ArrayBuffer(1));
  await vi.waitFor(() => expect(getPage).toHaveBeenCalledWith(1));
  const input = view.el.querySelector<HTMLInputElement>("input")!;
  input.value = "2";
  input.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(view.el.textContent).toContain("Seite 2 von 3"));
  const stale = { ...pdfPage, cleanup: vi.fn(), render: vi.fn(pdfPage.render) };
  resolve(stale);
  await loading;
  expect(stale.cleanup).toHaveBeenCalledOnce();
  expect(stale.render).not.toHaveBeenCalled();
  expect(view.el.textContent).toContain("Seite 2 von 3");
  view.dispose();
});

it("cleans up cancelled raster work without replacing the next page with an error", async () => {
  const { view, pdfPage, cleanup } = setup();
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((_resolve, fail) => { reject = fail; });
  const cancelled = vi.fn(() => reject(new Error("Rendering cancelled")));
  const render = vi.spyOn(pdfPage, "render").mockReturnValueOnce({ promise, cancel: cancelled });
  const loading = view.load(new ArrayBuffer(1));
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  const input = view.el.querySelector<HTMLInputElement>("input")!;
  input.value = "2";
  input.dispatchEvent(new Event("change"));
  await loading;
  await vi.waitFor(() => expect(view.el.textContent).toContain("Seite 2 von 3"));
  expect(cancelled).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(view.el.querySelectorAll("canvas")).toHaveLength(1);
  view.dispose();
});

it("reports corrupt or encrypted PDF loads instead of leaving a blank viewer", async () => {
  const { view } = setup();
  runtime.load.mockReturnValue({ promise: Promise.reject(new Error("bad PDF")), destroy: vi.fn(async () => {}) });
  await view.load(new ArrayBuffer(1));
  expect(view.el.textContent).toContain("PDF konnte nicht angezeigt werden");
  expect(view.el.querySelector("canvas")).toBeNull();
  view.dispose();
});

it("zooms a single PDF page without rereading the document and bounds raster memory", async () => {
  const { view } = setup(6000, 8000);
  await view.load(new ArrayBuffer(1));
  const zoom = view.el.querySelector<HTMLSelectElement>("select[aria-label='PDF-Vergrößerung']");
  expect(zoom).not.toBeNull();
  zoom!.value = "2";
  zoom!.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(view.el.querySelector("canvas")?.style.width).toBe("12000px"));
  expect(view.el.querySelectorAll("canvas")).toHaveLength(1);
  expect(view.el.querySelector(".textLayer")?.textContent).toBe("PDF text");
  const canvas = view.el.querySelector("canvas")!;
  expect(canvas.width * canvas.height).toBeLessThanOrEqual(8_000_000);
  expect(runtime.load).toHaveBeenCalledOnce();
  zoom!.value = "width";
  zoom!.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(view.el.querySelector("canvas")?.style.width).toBe("600px"));
  view.dispose();
});
