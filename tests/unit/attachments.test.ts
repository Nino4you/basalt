import { expect, it, vi } from "vitest";
import { attachmentKind, mimeFor } from "../../src/attachments";
import { App } from "../../src/app/app";
import { AttachmentView } from "../../src/app/attachment-view";
import { TFile } from "../../src/compat/files";

it("classifies directly opened vault files like Obsidian", () => {
  expect(attachmentKind("Note.md")).toBeNull();
  expect(attachmentKind("Skizze.canvas")).toBeNull();
  expect(attachmentKind("Anleitung.pdf")).toBe("pdf");
  expect(attachmentKind("Bild.PNG")).toBe("image");
  expect(attachmentKind("Logo.svg")).toBe("image");
  expect(attachmentKind("Audio.mp3")).toBe("audio");
  expect(attachmentKind("Video.webm")).toBe("video");
  expect(attachmentKind("Folien.pptx")).toBe("unsupported");
  expect(attachmentKind("Abfrage.sql")).toBeNull();
});

it("maps extensions to the MIME type used for blob playback", () => {
  expect(mimeFor("Anleitung.pdf")).toBe("application/pdf");
  expect(mimeFor("Bild.png")).toBe("image/png");
  expect(mimeFor("unbekannt.bin")).toBe("application/octet-stream");
});

it.each(["constructor", "__proto__", "toString"])("does not classify inherited dictionary keys as attachments: %s", (extension) => {
  expect(attachmentKind(`Notiz.${extension}`)).toBeNull();
  expect(mimeFor(`Notiz.${extension}`)).toBe("application/octet-stream");
});

it("keeps attachments in the files visible to the explorer and index", () => {
  const stat = { ctime: 0, mtime: 0, size: 1 };
  const files = [
    new TFile({}, "Notiz.md", stat),
    new TFile({}, "Handbuch.pdf", stat),
    new TFile({}, "Bild.png", stat),
    new TFile({}, "Folien.pptx", stat),
  ];
  const setFiles = vi.fn();
  (App.prototype as unknown as { syncVisibleFiles(): void }).syncVisibleFiles.call({
    vault: {},
    compatibility: {
      vault: { getAllLoadedFiles: () => files },
      services: { getViewTypeForExtension: () => undefined },
    },
    setFiles,
  });
  expect(setFiles).toHaveBeenCalledWith([
    "Bild.png",
    "Folien.pptx",
    "Handbuch.pdf",
    "Notiz.md",
  ]);
});

type Session = { vault: object };
const view = (host = document.createElement("div")) => new AttachmentView(host);
const show = (attachments: AttachmentView, path: string | null, session: Session) =>
  attachments.show(path, session as never);

it.each(["tab", "session", "request"])("ignores attachment reads after the %s changes", async (change) => {
  const create = vi.fn(() => "blob:attachment");
  const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  const host = document.createElement("div");
  const attachments = view(host);
  let finish!: (data: ArrayBuffer) => void;
  const read = new Promise<ArrayBuffer>((resolve) => { finish = resolve; });
  const session = {
    vault: {
      getFileByPath: () => ({ stat: { size: 2, mtime: 1 } }),
      readBinary: () => read,
    },
  };
  const pending = show(attachments, "Bild.png", session);
  // The app shows another file, another vault, or nothing at all.
  if (change === "tab") void show(attachments, null, session);
  if (change === "session") void show(attachments, "Bild.png", {
    vault: { ...session.vault, readBinary: () => new Promise(() => {}) },
  });
  if (change === "request") attachments.clear();
  finish(new ArrayBuffer(2));
  await pending;
  expect(create).not.toHaveBeenCalled();

  host.append(document.createElement("span"));
  attachments.clear();
  expect(host.childElementCount).toBe(0);
});

it("releases the blob of a shown attachment", async () => {
  const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:attachment" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  const attachments = view();
  await show(attachments, "Bild.png", {
    vault: {
      getFileByPath: () => ({ stat: { size: 2, mtime: 1 } }),
      readBinary: async () => new ArrayBuffer(2),
    },
  });
  expect(attachments.host.querySelector("img")?.src).toBe("blob:attachment");
  attachments.clear();
  expect(revoke).toHaveBeenCalledWith("blob:attachment");
  expect(attachments.host.childElementCount).toBe(0);
});

it("shows the same attachment in two views at once", async () => {
  let blobs = 0;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => `blob:${++blobs}` });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  const session = {
    vault: {
      getFileByPath: () => ({ stat: { size: 2, mtime: 1 } }),
      readBinary: async () => new ArrayBuffer(2),
    },
  };
  const live = view();
  const mirror = view();
  await show(live, "Bild.png", session);
  await show(mirror, "Bild.png", session);
  expect(live.host.querySelector("img")?.src).toBe("blob:1");
  expect(mirror.host.querySelector("img")?.src).toBe("blob:2");
  // Clearing one view leaves the other one alone.
  mirror.clear();
  expect(live.host.querySelector("img")?.src).toBe("blob:1");
});

it("reuses the active attachment read and blob until its file changes", async () => {
  const create = vi.fn(() => "blob:attachment");
  const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  const file = { stat: { size: 2, mtime: 1 } };
  let finish!: (data: ArrayBuffer) => void;
  const read = new Promise<ArrayBuffer>((resolve) => { finish = resolve; });
  const readBinary = vi.fn(() => read);
  const session = { vault: { getFileByPath: () => file, readBinary } };
  const attachments = view();
  const pending = show(attachments, "Bild.png", session);
  const duplicate = show(attachments, "Bild.png", session);
  finish(new ArrayBuffer(2));
  await Promise.all([pending, duplicate]);
  expect(readBinary).toHaveBeenCalledTimes(1);
  const frame = attachments.host.firstElementChild;
  await show(attachments, "Bild.png", session);
  expect(readBinary).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledTimes(1);
  expect(attachments.host.firstElementChild).toBe(frame);
  file.stat.mtime += 1;
  await show(attachments, "Bild.png", session);
  expect(readBinary).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenCalledTimes(2);
  expect(revoke).toHaveBeenCalledWith("blob:attachment");
});

it.each(["read", "decode"])("allows retry after an attachment %s failure and releases failed resources", async (failure) => {
  const create = vi.fn(() => "blob:attachment");
  const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  const readBinary = vi.fn().mockResolvedValue(new ArrayBuffer(2));
  if (failure === "read") readBinary.mockRejectedValueOnce(new Error("read failed"));
  const host = document.createElement("div");
  const attachments = view(host);
  await show(attachments, "Bild.png", {
    vault: { getFileByPath: () => ({ stat: { size: 2, mtime: 1 } }), readBinary },
  });
  if (failure === "decode") host.querySelector("img")!.dispatchEvent(new Event("error"));
  expect(host.textContent).toContain("nicht geladen");
  expect(host.querySelector("img")).toBeNull();
  if (failure === "decode") expect(revoke).toHaveBeenCalledWith("blob:attachment");
  host.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() => expect(host.querySelector("img")?.src).toBe("blob:attachment"));
  expect(readBinary).toHaveBeenCalledTimes(2);
  expect(host.querySelector("button")).toBeNull();
  attachments.clear();
});

it("does not show an old attachment read error in a different session", async () => {
  let reject!: (error: Error) => void;
  const host = document.createElement("div");
  const attachments = view(host);
  const loading = show(attachments, "Bild.png", {
    vault: {
      getFileByPath: () => ({ stat: { size: 2 } }),
      readBinary: () => new Promise<ArrayBuffer>((_resolve, fail) => { reject = fail; }),
    },
  });
  // Switching the vault clears the view.
  attachments.clear();
  host.textContent = "new vault";
  reject(new Error("old vault error"));
  await loading;
  expect(host.textContent).toBe("new vault");
});
