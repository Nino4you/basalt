import { expect, it, vi } from "vitest";
import { MetadataCache } from "../../src/compat/metadata-cache";
import { Vault } from "../../src/compat/vault";
import { MemoryPort, memoryVault } from "../helpers/vault-store";

async function cache(contents: Record<string, string>) {
  const vault = await memoryVault(contents);
  const metadata = new MetadataCache(vault);
  return { vault, cache: metadata };
}

it("resolves link paths by exact path, relative folder and unique basename", async () => {
  const { vault, cache: metadata } = await cache({
    "Notes/Alpha.md": "",
    "Notes/Deep/Beta.md": "",
    "Other/Alpha.md": "",
    "Attachments/pic.png": "",
  });
  expect(metadata.getFirstLinkpathDest("Notes/Alpha.md", "Other/X.md")).toBe(
    vault.getFileByPath("Notes/Alpha.md"),
  );
  expect(metadata.getFirstLinkpathDest("Beta", "Notes/Alpha.md")).toBe(
    vault.getFileByPath("Notes/Deep/Beta.md"),
  );
  expect(metadata.getFirstLinkpathDest("pic.png", "Notes/Alpha.md")).toBe(
    vault.getFileByPath("Attachments/pic.png"),
  );
  expect(metadata.getFirstLinkpathDest("Missing", "Notes/Alpha.md")).toBeNull();
});

it("generates unique link text and falls back to a relative path", async () => {
  const { vault, cache: metadata } = await cache({
    "Notes/Alpha.md": "",
    "Notes/Deep/Beta.md": "",
    "Other/Alpha.md": "",
  });
  expect(
    metadata.fileToLinktext(
      vault.getFileByPath("Notes/Deep/Beta.md")!,
      "Notes/A.md",
    ),
  ).toBe("Beta");
  expect(
    metadata.fileToLinktext(
      vault.getFileByPath("Notes/Alpha.md")!,
      "Other/A.md",
    ),
  ).toBe("Notes/Alpha");
});

it("keeps attachment extensions and generates link text that resolves to the original", async () => {
  const { vault, cache: metadata } = await cache({
    "Note.md": "",
    "Other/Note.md": "",
    "Attachments/Note.pdf": "",
    "Attachments/Note.png": "",
  });
  for (const file of vault.getFiles()) {
    const text = metadata.fileToLinktext(file, "Other/Index.md");
    expect(metadata.getFirstLinkpathDest(text, "Other/Index.md")).toBe(file);
  }
  expect(
    metadata.fileToLinktext(vault.getFileByPath("Attachments/Note.pdf")!),
  ).toBe("Note.pdf");
});

it("exposes resolved and unresolved link counts to plugins", async () => {
  const { cache: metadata } = await cache({
    "Notes/Quelle.md":
      "[[Ziel]] [[Ziel|Alias]] [[Ziel#Abschnitt]] ![[Bild.png]] [[Fehlt]] [[Fehlt#Teil]]",
    "Notes/Ziel.md": "",
    "Anhänge/Bild.png": "",
  });
  await metadata.reindex();
  expect(metadata.resolvedLinks["Notes/Quelle.md"]).toEqual({
    "Notes/Ziel.md": 3,
    "Anhänge/Bild.png": 1,
  });
  expect(metadata.unresolvedLinks["Notes/Quelle.md"]).toEqual({ Fehlt: 2 });
});

it("parses links, embeds, tags, headings and frontmatter with positions", async () => {
  const source = [
    "---",
    "tags: [projekt, '#basalt']",
    "title: Example",
    "---",
    "  # Heading",
    "See [[Ziel|Alias]] and ![[Bild.png]] with #echt and a [web](https://x).",
  ].join("\n");
  const { vault, cache: metadata } = await cache({ "Notes/Note.md": source });
  await metadata.reindex();

  const parsed = metadata.getFileCache(vault.getFileByPath("Notes/Note.md")!);
  expect(parsed?.links.map((link) => link.link)).toEqual(["Ziel"]);
  expect(parsed?.links[0].position).toMatchObject({
    start: { line: 5, col: 4, offset: source.indexOf("[[Ziel") },
  });
  expect(parsed?.embeds.map((embed) => embed.link)).toEqual(["Bild.png"]);
  expect(parsed?.tags.map((tag) => tag.tag)).toEqual([
    "#projekt",
    "#basalt",
    "#echt",
  ]);
  expect(parsed?.tags[2].position.start).toMatchObject({
    line: 5,
    col: source.split("\n")[5].indexOf("#echt"),
  });
  expect(parsed?.headings).toHaveLength(1);
  expect(parsed?.headings[0]).toMatchObject({
    heading: "Heading",
    level: 1,
    position: { start: { line: 4, col: 2 } },
  });
  expect(parsed?.frontmatter).toEqual({
    tags: ["projekt", "#basalt"],
    title: "Example",
  });
});

it("returns null until a note is indexed and never for attachments", async () => {
  const { vault, cache: metadata } = await cache({
    "Note.md": "#topic",
    "bild.png": "",
  });
  expect(metadata.getFileCache(vault.getFileByPath("Note.md")!)).toBeNull();
  await metadata.reindex();
  expect(metadata.getFileCache(vault.getFileByPath("Note.md")!)).not.toBeNull();
  expect(metadata.getFileCache(vault.getFileByPath("bild.png")!)).toBeNull();
  expect(metadata.getFileCache(null)).toBeNull();
});

it("counts tags across indexed notes", async () => {
  const { cache: metadata } = await cache({
    "A.md": "#projekt #daily",
    "B.md": "#projekt #lang/rust",
    "C.md": "no tags",
  });
  expect(metadata.getTags()).toEqual({});
  await metadata.reindex();
  expect(metadata.getTags()).toEqual({
    "#projekt": 2,
    "#daily": 1,
    "#lang/rust": 1,
  });
});

it("warms note metadata with bounded concurrency", async () => {
  class SlowPort extends MemoryPort {
    active = 0;
    peak = 0;
    override async read(path: string) {
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      try {
        return await super.read(path);
      } finally {
        this.active--;
      }
    }
  }
  const contents = Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [`Note ${index}.md`, `# Note ${index}`]),
  );
  const port = new SlowPort(contents);
  const vault = new Vault(port, "Vault");
  await vault.initialize();
  await new MetadataCache(vault).reindex();
  expect(port.peak).toBeGreaterThan(1);
  expect(port.peak).toBeLessThanOrEqual(8);
});

it("follows modify, delete and rename through vault events", async () => {
  const { vault, cache: metadata } = await cache({ "Note.md": "#first" });
  await metadata.reindex();
  const file = vault.getFileByPath("Note.md")!;

  await vault.modify(file, "#second");
  await vi.waitFor(() =>
    expect(metadata.getFileCache(file)?.tags.map((tag) => tag.tag)).toEqual([
      "#second",
    ]),
  );

  await vault.rename(file, "Renamed.md");
  const renamed = vault.getFileByPath("Renamed.md")!;
  await vi.waitFor(() =>
    expect(metadata.getFileCache(renamed)?.tags.map((tag) => tag.tag)).toEqual([
      "#second",
    ]),
  );

  await vault.delete(renamed);
  expect(metadata.getFileCache(renamed)).toBeNull();
});
