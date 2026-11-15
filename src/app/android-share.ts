import { t } from "../i18n";
import { formatDate } from "../dates";

/**
 * Content another Android app shared to Basalt ("Share" → Basalt). The patched
 * activity (tools/patch_android.mjs) reads it and hands it over as JSON through
 * `BasaltAndroid.takeShare()`, announced by a `basalt-share` window event.
 */
export interface SharedFile {
  name: string;
  type: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface SharedContent {
  subject: string;
  text: string;
  files: SharedFile[];
  /** Names of shared files that were too large, unreadable or not allowed. */
  skipped: string[];
}

interface ShareBridge {
  takeShare(): string | null;
}

function bridge(): ShareBridge | null {
  const value = (globalThis as { BasaltAndroid?: Partial<ShareBridge> })
    .BasaltAndroid;
  return typeof value?.takeShare === "function" ? (value as ShareBridge) : null;
}

/** Runs `handle` for a share that started the app and for every later one. */
export function listenForShares(
  handle: (share: SharedContent) => void,
  onError: (error: unknown) => void,
): void {
  const take = () => {
    const raw = bridge()?.takeShare();
    if (!raw) return;
    try {
      const share = parseShare(raw);
      if (share) handle(share);
    } catch (error) {
      onError(error);
    }
  };
  window.addEventListener("basalt-share", take);
  take();
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Validates the activity's JSON; null when there is nothing to save. */
export function parseShare(raw: string): SharedContent | null {
  const value = JSON.parse(raw) as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  if (typeof value.error === "string")
    throw new Error(
      t("Geteilte Inhalte konnten nicht gelesen werden: {error}", {
        error: value.error,
      }),
    );
  const files: SharedFile[] = [];
  if (Array.isArray(value.files))
    for (const entry of value.files) {
      const file = entry as Record<string, unknown> | null;
      if (
        !file ||
        typeof file.name !== "string" ||
        typeof file.data !== "string"
      )
        continue;
      files.push({
        name: safeFileName(
          file.name,
          typeof file.type === "string" ? file.type : "",
        ),
        type: typeof file.type === "string" ? file.type : "",
        bytes: decode(file.data),
      });
    }
  const share: SharedContent = {
    subject: typeof value.subject === "string" ? value.subject.trim() : "",
    text: typeof value.text === "string" ? value.text : "",
    files,
    skipped: strings(value.skipped),
  };
  if (!share.text.trim() && !share.files.length && !share.skipped.length)
    return null;
  return share;
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

/** A file name without folders or hidden-file dots, with an extension. */
export function safeFileName(name: string, type: string): string {
  let base = (name.split(/[\\/]/).pop() ?? "")
    .replace(/[\u0000-\u001f\u007f<>:"|?*#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!base) base = t("Geteilt");
  if (base.length > 120) {
    const dot = base.lastIndexOf(".");
    const extension = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : "";
    base = base.slice(0, 120 - extension.length).trim() + extension;
  }
  if (!/\.[A-Za-z0-9]{1,8}$/.test(base) && EXTENSIONS[type])
    base = `${base}.${EXTENSIONS[type]}`;
  return base;
}

/** Whether the shared text is just one web link. */
export function isLink(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

/**
 * A note name for the share: the subject, else the first line of the text
 * (a bare link names the note after its host), else a date.
 */
export function shareTitle(share: SharedContent, now = new Date()): string {
  const text = share.text.trim();
  let title = share.subject;
  if (!title && text) {
    if (isLink(text)) {
      try {
        title = new URL(text).hostname.replace(/^www\./, "");
      } catch {
        title = "";
      }
    } else title = text.split("\n")[0].replace(/^#+\s*/, "");
  }
  if (!title && share.files.length === 1)
    title = share.files[0].name.replace(/\.[^.]+$/, "");
  title = title
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return title || `${t("Geteilt")} ${formatDate(now, "YYYY-MM-DD HHmm")}`;
}

/**
 * The Markdown for the shared content: a bare link becomes a Markdown link
 * with the subject as its label, other text stays as it is, attachments
 * follow as embeds.
 */
export function shareMarkdown(share: SharedContent, embeds: string[]): string {
  const text = share.text.trim();
  const parts: string[] = [];
  if (text) {
    if (isLink(text) && share.subject)
      parts.push(`[${share.subject.replace(/[[\]]/g, "")}](${text})`);
    else parts.push(text);
  }
  if (embeds.length) parts.push(embeds.join("\n"));
  return parts.join("\n\n");
}
