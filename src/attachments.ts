/** File types Obsidian renders natively outside the Markdown editor. */
export const IMAGE_TYPES: Record<string, string> = Object.assign(
  Object.create(null),
  {
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
  },
);

export const MEDIA_TYPES: Record<
  string,
  { mime: string; kind: "audio" | "video" | "pdf" }
> = Object.assign(Object.create(null), {
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
  "7z",
  "bin",
  "bz2",
  "dll",
  "doc",
  "docx",
  "epub",
  "exe",
  "gz",
  "iso",
  "odp",
  "ods",
  "odt",
  "pptx",
  "rar",
  "tar",
  "xls",
  "xlsx",
  "xz",
  "zip",
]);

export type AttachmentKind =
  "image" | "pdf" | "audio" | "video" | "unsupported";

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
  return (
    IMAGE_TYPES[type] ?? MEDIA_TYPES[type]?.mime ?? "application/octet-stream"
  );
}

/**
 * The folder for new attachments, from a setting that works like Obsidian's
 * "Default location for new attachments": "/" (or empty) is the vault root,
 * "./" the folder of the note, "./name" a subfolder next to the note and
 * anything else a folder in the vault. Returns "" for the vault root.
 */
export function attachmentFolder(setting: string, sourcePath: string): string {
  const value = setting.trim();
  const slash = sourcePath.lastIndexOf("/");
  const noteFolder = slash < 0 ? "" : sourcePath.slice(0, slash);
  const trim = (path: string) => path.replace(/^\/+|\/+$/g, "");
  if (!value || value === "/") return "";
  if (value === "." || value === "./") return noteFolder;
  if (value.startsWith("./")) {
    const sub = trim(value.slice(2));
    if (!sub) return noteFolder;
    return noteFolder ? `${noteFolder}/${sub}` : sub;
  }
  return trim(value);
}

const EXTENSION_FOR_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/tiff": "tiff",
};

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * A file name that is safe in a vault and inside a `[[wiki link]]`.
 * Clipboard images come without a useful name (browsers call them
 * "image.png"); they get a dated name like Obsidian's "Pasted image".
 */
export function attachmentName(
  name: string,
  type: string,
  pasted: boolean,
  now = new Date(),
): string {
  const generic = !name || (pasted && /^image\.\w+$/i.test(name));
  let result = name;
  if (generic) {
    const extension =
      EXTENSION_FOR_MIME[type] ??
      (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "bin");
    result = `${pasted ? "Pasted image" : "Attachment"} ${stamp(now)}.${extension}`;
  }
  result = result
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|#^[\]]/g, "-")
    .replace(/^[.\s]+/, "")
    .trim();
  return result || `Attachment ${stamp(now)}.bin`;
}

/** `folder/name`, or `folder/name 1.ext`, … when that path is taken. */
export function availablePath(
  folder: string,
  name: string,
  exists: (path: string) => boolean,
): string {
  const prefix = folder ? `${folder}/` : "";
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let candidate = `${prefix}${name}`;
  for (let index = 1; exists(candidate); index++)
    candidate = `${prefix}${stem} ${index}${extension}`;
  return candidate;
}

/**
 * The wiki link for a new attachment: the bare name when no other vault file
 * shares it, otherwise the full path. Viewable files are embedded.
 */
export function attachmentLink(path: string, files: readonly string[]): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const lower = name.toLowerCase();
  const clash = files.some(
    (file) =>
      file !== path &&
      file.slice(file.lastIndexOf("/") + 1).toLowerCase() === lower,
  );
  const target = (clash ? path : name).replace(/\.md$/i, "");
  const kind = attachmentKind(path);
  return kind && kind !== "unsupported" ? `![[${target}]]` : `[[${target}]]`;
}
