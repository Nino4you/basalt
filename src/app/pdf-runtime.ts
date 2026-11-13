import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";

GlobalWorkerOptions.workerSrc = workerUrl;
const assets = import.meta.env.DEV
  ? "/node_modules/pdfjs-dist/"
  : `${import.meta.env.BASE_URL}assets/pdfjs/`;

export { TextLayer };
export function loadPdf(data: ArrayBuffer) {
  return getDocument({
    data: new Uint8Array(data),
    enableXfa: false,
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    maxImageSize: 16_000_000,
    canvasMaxAreaInBytes: 32_000_000,
  });
}
