import { attachmentKind, MAX_ATTACHMENT_BYTES, mimeFor } from "../attachments";
import type { CompatibilitySession } from "../compat/session";
import { basename, errorMessage, h } from "../ui/dom";
import { PdfView } from "./pdf";

/**
 * Renders a directly opened attachment (image, audio, video, PDF) into
 * `host` using vault-scoped binary reads. The focused group and every
 * mirrored group each own one, so attachments show side by side.
 */
export class AttachmentView {
  private url: string | null = null;
  private pdf: PdfView | null = null;
  private request = 0;
  private source: {
    session: CompatibilitySession;
    path: string;
    mtime: number;
    size: number;
  } | null = null;

  constructor(readonly host: HTMLElement) {}

  /** Shows `path`; cheap when the same unchanged file is already showing. */
  async show(
    path: string | null,
    session: CompatibilitySession | null,
  ): Promise<void> {
    const file = path ? session?.vault.getFileByPath(path) : null;
    const source = this.source;
    if (
      file &&
      source?.session === session &&
      source.path === path &&
      source.mtime === file.stat.mtime &&
      source.size === file.stat.size
    )
      return;
    this.clear();
    const host = this.host;
    if (!path) return;
    const kind = attachmentKind(path) ?? "unsupported";
    const message = (text: string) =>
      host.append(h("div", { class: "attachment-message", text }));
    if (kind === "unsupported")
      return message("Dieses Dateiformat kann nicht angezeigt werden.");
    if (!session)
      return message("Anhänge werden nur in der nativen App angezeigt.");
    if (!file) return message(`Datei nicht im Vault gefunden: ${path}`);
    if (file.stat.size > MAX_ATTACHMENT_BYTES)
      return message(
        "Datei ist größer als 64 MiB und kann nicht direkt angezeigt werden.",
      );
    this.source = {
      session,
      path,
      mtime: file.stat.mtime,
      size: file.stat.size,
    };
    const request = ++this.request;
    const isCurrent = () => request === this.request;
    const failed = (text: string) => {
      if (!isCurrent()) return;
      this.clear();
      const shown = this.request;
      const retry = h("button", { text: "Erneut versuchen" });
      retry.addEventListener("click", () => {
        if (shown === this.request) void this.show(path, session);
      });
      host.append(
        h(
          "div",
          "attachment-error",
          h("div", {
            class: "attachment-message",
            text,
            attrs: { role: "alert" },
          }),
          retry,
        ),
      );
    };
    const loading = h("div", {
      class: "attachment-message",
      text: "Datei wird geladen …",
      attrs: { role: "status" },
    });
    host.append(loading);
    try {
      const data = await session.vault.readBinary(file);
      if (!isCurrent()) return;
      loading.remove();
      if (kind === "pdf") {
        const pdf = new PdfView();
        this.pdf = pdf;
        host.append(pdf.el);
        void pdf.load(data);
        return;
      }
      const url = URL.createObjectURL(
        new Blob([data], { type: mimeFor(path) }),
      );
      this.url = url;
      if (kind === "image") {
        const image = h("img", {
          class: "attachment-image",
          attrs: { alt: basename(path) },
        });
        image.addEventListener(
          "error",
          () =>
            failed(
              "Bild konnte nicht geladen werden. Die Datei ist beschädigt oder das Format wird nicht unterstützt.",
            ),
          { once: true },
        );
        image.src = url;
        host.append(image);
      } else {
        const media = h(kind, {
          class: "attachment-media",
          attrs: { controls: true, preload: "metadata" },
        });
        media.addEventListener(
          "error",
          () =>
            failed(
              "Medien-Datei konnte nicht geladen werden. Die Datei ist beschädigt oder das Format wird nicht unterstützt.",
            ),
          { once: true },
        );
        media.src = url;
        host.append(media);
      }
    } catch (error) {
      failed(`Datei konnte nicht geladen werden: ${errorMessage(error)}`);
    }
  }

  /** Drops the rendered file and cancels a pending read. */
  clear(): void {
    this.request += 1;
    this.source = null;
    this.pdf?.dispose();
    this.pdf = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.host.replaceChildren();
  }
}
