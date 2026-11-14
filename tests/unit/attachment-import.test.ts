import { afterEach, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  attachmentFolder,
  attachmentLink,
  attachmentName,
  availablePath,
} from "../../src/attachments";
import { importAttachments } from "../../src/app/attachment-import";
import {
  attachmentHandlers,
  attachmentHost,
  type AttachmentHost,
  FILE_MIME,
} from "../../src/editor/attachments";
import { FileManager } from "../../src/compat/file-manager";
import { memoryVault } from "../helpers/vault-store";

// jsdom has no layout. CodeMirror measures in animation frames, which can run
// during any test of this file, and posAtCoords needs these for drops.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

afterEach(() => document.body.replaceChildren());

it("resolves the attachment folder setting like Obsidian", () => {
  expect(attachmentFolder("/", "Ordner/Notiz.md")).toBe("");
  expect(attachmentFolder("", "Ordner/Notiz.md")).toBe("");
  expect(attachmentFolder("./", "Ordner/Notiz.md")).toBe("Ordner");
  expect(attachmentFolder("./", "Notiz.md")).toBe("");
  expect(attachmentFolder("./Anhänge", "Ordner/Notiz.md")).toBe(
    "Ordner/Anhänge",
  );
  expect(attachmentFolder("./Anhänge/", "Notiz.md")).toBe("Anhänge");
  expect(attachmentFolder("Medien/Bilder/", "Ordner/Notiz.md")).toBe(
    "Medien/Bilder",
  );
});

it("names pasted images and cleans names for wiki links", () => {
  const now = new Date(2026, 10, 14, 9, 5, 3);
  expect(attachmentName("image.png", "image/png", true, now)).toBe(
    "Pasted image 20261114090503.png",
  );
  expect(attachmentName("", "image/jpeg", true, now)).toBe(
    "Pasted image 20261114090503.jpg",
  );
  expect(attachmentName("image.png", "image/png", false, now)).toBe(
    "image.png",
  );
  expect(attachmentName("Plan [v2] #1|a.pdf", "", false, now)).toBe(
    "Plan -v2- -1-a.pdf",
  );
  expect(attachmentName(".hidden.png", "", false, now)).toBe("hidden.png");
});

it("never reuses a taken path", () => {
  const taken = new Set(["A/b.png", "A/b 1.png"]);
  expect(availablePath("A", "b.png", (path) => taken.has(path))).toBe(
    "A/b 2.png",
  );
  expect(availablePath("", "c", () => false)).toBe("c");
});

it("embeds viewable files and uses the path only when names clash", () => {
  expect(attachmentLink("A/b.png", ["A/b.png", "x.md"])).toBe("![[b.png]]");
  expect(attachmentLink("A/b.png", ["A/b.png", "C/B.png"])).toBe(
    "![[A/b.png]]",
  );
  expect(attachmentLink("A/b.zip", ["A/b.zip"])).toBe("[[b.zip]]");
  expect(attachmentLink("A/Note.md", ["A/Note.md"])).toBe("[[Note]]");
});

/** jsdom's File has no arrayBuffer(); the WebViews do. */
function file(name: string, text: string, type = ""): File {
  const result = new File([text], name, { type });
  const bytes = new TextEncoder().encode(text);
  Object.defineProperty(result, "arrayBuffer", {
    value: async () => bytes.buffer,
  });
  return result;
}

it("stores files exclusively in the configured folder", async () => {
  const vault = await memoryVault({
    "Ordner/Notiz.md": "x",
    "Ordner/Bild.png": "old",
  });
  const markdown = await importAttachments(
    vault,
    [file("Bild.png", "new", "image/png"), file("Liste.csv", "a,b")],
    { sourcePath: "Ordner/Notiz.md", folderSetting: "./", pasted: false },
  );
  expect(markdown).toBe("![[Bild 1.png]]\n[[Liste.csv]]");
  expect(await vault.read(vault.getFileByPath("Ordner/Bild.png")!)).toBe("old");
  expect(await vault.read(vault.getFileByPath("Ordner/Bild 1.png")!)).toBe(
    "new",
  );
});

it("creates a missing attachment folder", async () => {
  const vault = await memoryVault({ "Notiz.md": "x" });
  const markdown = await importAttachments(
    vault,
    [file("a.png", "1", "image/png")],
    { sourcePath: "Notiz.md", folderSetting: "Medien/Bilder", pasted: false },
  );
  expect(markdown).toBe("![[a.png]]");
  expect(vault.getFolderByPath("Medien/Bilder")).not.toBeNull();
  expect(vault.getFileByPath("Medien/Bilder/a.png")).not.toBeNull();
});

it("explains that the browser demo cannot store attachments", async () => {
  const markdown = await importAttachments(null, [file("a.png", "1")], {
    sourcePath: "Notiz.md",
    folderSetting: "/",
    pasted: true,
  });
  expect(markdown).toBeNull();
  expect(document.body.textContent).toContain("nativen App");
});

it("hands plugins a path in the configured folder", async () => {
  const vault = await memoryVault({ "A/Notiz.md": "x", "Anhänge/z.png": "" });
  const manager = new FileManager(
    vault,
    () => false,
    () => "Anhänge",
  );
  expect(
    await manager.getAvailablePathForAttachment("z.png", "A/Notiz.md"),
  ).toBe("Anhänge/z 1.png");
});

function editor(host: AttachmentHost, text = "Hallo ") {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: text,
      selection: { anchor: text.length },
      extensions: [attachmentHost.of(host), attachmentHandlers],
    }),
  });
  return view;
}

function transfer(data: Record<string, string>, files: File[] = []) {
  return {
    files,
    items: [],
    types: [...Object.keys(data), ...(files.length ? ["Files"] : [])],
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer;
}

it("pastes files as links but leaves pasted text alone", async () => {
  const received: File[][] = [];
  const view = editor({
    attachFiles: async (files) => {
      received.push(files);
      return "![[Pasted image.png]]";
    },
  });
  const paste = (data: DataTransfer) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    view.contentDOM.dispatchEvent(event);
    return event;
  };
  paste(transfer({ "text/plain": "Text" }, [file("x.png", "1")]));
  expect(received).toHaveLength(0);
  expect(view.state.doc.toString()).toBe("Hallo Text");
  const image = paste(transfer({}, [file("image.png", "1", "image/png")]));
  expect(image.defaultPrevented).toBe(true);
  await new Promise((resolve) => setTimeout(resolve));
  expect(received).toHaveLength(1);
  expect(view.state.doc.toString()).toBe("Hallo Text![[Pasted image.png]]");
  view.destroy();
});

it("drops explorer rows as wiki links", () => {
  const view = editor({ linkTo: (path) => `[[${path.replace(/\.md$/, "")}]]` });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: transfer({ [FILE_MIME]: "Ordner/Ziel.md" }),
  });
  view.contentDOM.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(view.state.doc.toString()).toContain("[[Ordner/Ziel]]");
  view.destroy();
});
