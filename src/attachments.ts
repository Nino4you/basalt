/** File types Obsidian renders natively outside the Markdown editor. */
export const IMAGE_TYPES: Record<string, string> = Object.assign(Object.create(null), {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
});

export const MEDIA_TYPES: Record<string, { mime: string; kind: "audio" | "video" | "pdf" }> = Object.assign(Object.create(null), {
  pdf: { mime: "application/pdf", kind: "pdf" },
  aac: { mime: "audio/aac", kind: "audio" },
  mp3: { mime: "audio/mpeg", kind: "audio" },
  wav: { mime: "audio/wav", kind: "audio" },
  m4a: { mime: "audio/mp4", kind: "audio" },
  ogg: { mime: "audio/ogg", kind: "audio" },
  oga: { mime: "audio/ogg", kind: "audio" },
  opus: { mime: "audio/ogg", kind: "audio" },
  flac: { mime: "audio/flac", kind: "audio" },
  avi: { mime: "video/x-msvideo", kind: "video" },
  m4v: { mime: "video/mp4", kind: "video" },
  mkv: { mime: "video/x-matroska", kind: "video" },
  mp4: { mime: "video/mp4", kind: "video" },
  webm: { mime: "video/webm", kind: "video" },
  ogv: { mime: "video/ogg", kind: "video" },
  mov: { mime: "video/quicktime", kind: "video" },
});

// Obsidian has no native viewer for these either; show a notice instead of decoded bytes.
const BINARY_TYPES = new Set([
  "7z", "bin", "bz2", "dll", "doc", "docx", "epub", "exe", "gz", "iso", "odp",
  "ods", "odt", "pptx", "rar", "tar", "xls", "xlsx", "xz", "zip",
]);

export type AttachmentKind = "image" | "pdf" | "audio" | "video" | "unsupported";

/** Mirrors the host bridge's binary read limit; larger files need streaming. */
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

export function attachmentKind(path: string): AttachmentKind | null {
  const type = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (IMAGE_TYPES[type]) return "image";
  if (MEDIA_TYPES[type]) return MEDIA_TYPES[type].kind;
  if (BINARY_TYPES.has(type)) return "unsupported";
  return null;
}

export function mimeFor(path: string): string {
  const type = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return IMAGE_TYPES[type] ?? MEDIA_TYPES[type]?.mime ?? "application/octet-stream";
}
