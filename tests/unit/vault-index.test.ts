import { describe, expect, it } from "vitest";
import {
  parseQuery,
  scanNote,
  searchNote,
  VaultIndex,
} from "../../src/app/vault-index";
import { resolveNote } from "../../src/markdown";

function vault(files: Record<string, string>): VaultIndex {
  const index = new VaultIndex();
  index.setFiles(Object.keys(files).sort());
  for (const [path, text] of Object.entries(files))
    index.setContent(path, text);
  return index;
}

describe("note scanning", () => {
  it("collects wiki links, Markdown links and embeds with their position", () => {
    const meta = scanNote(
      "Siehe [[Ziel|Alias]] und ![[Bild.png]].\n[Text](Ordner/Andere%20Notiz.md) [Web](https://example.org)",
    );
    expect(meta.links.map((link) => link.target)).toEqual([
      "Ziel",
      "Bild.png",
      "Ordner/Andere Notiz.md",
    ]);
    expect(meta.links[0]).toMatchObject({ line: 0, col: 6, embed: false });
    expect(meta.links[1].embed).toBe(true);
  });

  it("ignores links and tags inside code and frontmatter bodies", () => {
    const meta = scanNote(
      '---\ntags: [projekt, basalt]\ntitle: "[[Kein Link]]"\n---\n`[[Inline]]` #echt\n\n```md\n[[Code]] #falsch\n```\nIssue #42 und Wort#keins',
    );
    expect(meta.links).toEqual([]);
    expect(meta.tags.sort()).toEqual(["basalt", "echt", "projekt"]);
  });

  it("reads list-style frontmatter tags", () => {
    expect(scanNote("---\ntags:\n  - eins\n  - '#zwei'\n---\n").tags).toEqual([
      "eins",
      "zwei",
    ]);
  });
});

describe("vault index", () => {
  const files = {
    "A/Note.md": "Zurück zu [[Home]].",
    "B/Note.md": "",
    "Home.md": "[[A/Note]] und [[Note]] und [[Fehlt]] und [[A/Note#Abschnitt]]",
    "A/Source.md": "[[Note]] #thema #thema/unter",
  };

  it("resolves links exactly like the reference resolver", () => {
    const index = vault(files);
    const paths = Object.keys(files);
    for (const [target, source] of [
      ["Note", "A/Source.md"],
      ["Note", "Home.md"],
      ["A/Note#Heading", "Home.md"],
      ["#Heading", "Home.md"],
      ["Home", "A/Note.md"],
      ["Fehlt", "Home.md"],
    ])
      expect(index.resolve(target, source)).toBe(
        resolveNote(target, source, paths),
      );
  });

  it("falls back to a case-insensitive match", () => {
    expect(vault(files).resolve("home", "A/Note.md")).toBe("Home.md");
  });

  it("derives backlinks with context and updates them incrementally", () => {
    const index = vault(files);
    expect(index.backlinks("A/Note.md").map((m) => m.source)).toEqual([
      "Home.md",
      "Home.md",
      "A/Source.md",
    ]);
    expect(index.backlinks("Home.md")[0]).toMatchObject({
      source: "A/Note.md",
      text: "Zurück zu [[Home]].",
      col: 10,
    });
    index.setContent("A/Note.md", "Kein Link mehr.");
    expect(index.backlinks("Home.md")).toEqual([]);
  });

  it("lists outgoing links once, split into resolved and unresolved", () => {
    expect(vault(files).outgoing("Home.md")).toEqual([
      { target: "A/Note", resolved: "A/Note.md" },
      { target: "Note", resolved: null },
      { target: "Fehlt", resolved: null },
    ]);
  });

  it("groups notes by tag and drops removed files", () => {
    const index = vault(files);
    expect([...index.tags().keys()].sort()).toEqual(["thema", "thema/unter"]);
    index.setFiles(["Home.md"]);
    expect(index.tags().size).toBe(0);
    expect(index.content("A/Source.md")).toBeUndefined();
  });
});

describe("vault search", () => {
  const index = vault({
    "Projekte/Plan.md":
      "Erste Zeile\nDer Rust-Kern trägt den Plan. #projekt/basalt",
    "Notizen/Idee.md": "Eine Idee zu Rust und Android.",
    "Rust.md": "",
  });
  const find = (query: string) =>
    index.files
      .map((path) => searchNote(index, path, parseQuery(query)))
      .filter((result) => result !== null);

  it("parses terms, phrases and operators", () => {
    expect(
      parseQuery('rust "der plan" tag:#a path:Projekte file:plan #b'),
    ).toMatchObject({
      terms: ["rust", "der plan"],
      tags: ["a", "b"],
      path: ["projekte"],
      file: ["plan"],
      excludedTerms: [],
      excludedTags: [],
      excludedPath: [],
      excludedFile: [],
    });
  });

  it("parses exclusions only at the start of a term", () => {
    expect(
      parseQuery('android -rust -tag:#projekt -path:Archiv -file:alt -"alter plan"'),
    ).toMatchObject({
      terms: ["android"],
      tags: [],
      path: [],
      file: [],
      excludedTerms: ["rust", "alter plan"],
      excludedTags: ["projekt"],
      excludedPath: ["archiv"],
      excludedFile: ["alt"],
    });
    expect(parseQuery("foo-bar").terms).toEqual(["foo-bar"]);
  });

  it("matches text and file names case-insensitively", () => {
    const results = find("rust");
    expect(results.map((result) => result.path)).toEqual([
      "Notizen/Idee.md",
      "Projekte/Plan.md",
      "Rust.md",
    ]);
    expect(results[2]).toMatchObject({ nameMatch: true, matches: [] });
    const match = results[1].matches[0];
    expect(match.text.slice(match.start, match.start + match.length)).toBe(
      "Rust",
    );
    expect(match.offset).toBe("Erste Zeile\nDer ".length);
  });

  it("requires every term and honours operators", () => {
    expect(find("rust android").map((r) => r.path)).toEqual([
      "Notizen/Idee.md",
    ]);
    expect(find("tag:projekt").map((r) => r.path)).toEqual([
      "Projekte/Plan.md",
    ]);
    expect(find("path:notizen rust").map((r) => r.path)).toEqual([
      "Notizen/Idee.md",
    ]);
    expect(find("gibtsnicht")).toEqual([]);
    expect(find("   ")).toEqual([]);
  });

  it("removes excluded terms, tags, paths and filenames", () => {
    expect(find("rust -android").map((r) => r.path)).toEqual([
      "Projekte/Plan.md",
      "Rust.md",
    ]);
    expect(find("rust -tag:projekt").map((r) => r.path)).toEqual([
      "Notizen/Idee.md",
      "Rust.md",
    ]);
    expect(find("rust -path:notizen").map((r) => r.path)).toEqual([
      "Projekte/Plan.md",
      "Rust.md",
    ]);
    expect(find("rust -file:idee").map((r) => r.path)).toEqual([
      "Projekte/Plan.md",
      "Rust.md",
    ]);
    expect(find("-android").map((r) => r.path)).toEqual([
      "Projekte/Plan.md",
      "Rust.md",
    ]);
    expect(find("-rust")).toEqual([]);
  });
});

describe("link resolution cache", () => {
  it("forgets cached answers when the file list changes", () => {
    const index = vault({ "Notes/A.md": "[[B]]" });
    expect(index.resolve("B", "Notes/A.md")).toBeNull();
    index.setFiles(["Notes/A.md", "Notes/B.md"]);
    expect(index.resolve("B", "Notes/A.md")).toBe("Notes/B.md");
    index.setFiles(["Notes/A.md", "Notes/B.md", "B.md"]);
    // The sibling still wins over the root note.
    expect(index.resolve("B", "Notes/A.md")).toBe("Notes/B.md");
    expect(index.resolve("B", "Other/C.md")).toBe("B.md");
  });

  it("resolves heading-only links to each source itself", () => {
    const index = vault({ "Notes/A.md": "", "Notes/B.md": "" });
    expect(index.resolve("#Intro", "Notes/A.md")).toBe("Notes/A.md");
    expect(index.resolve("#Intro", "Notes/B.md")).toBe("Notes/B.md");
  });
});

describe("attachment resolution", () => {
  it("finds attachments in subfolders by their file name", () => {
    const index = vault({
      "Notes/A.md": "",
      "Bilder/Foto.png": "",
      "Foto.md": "",
    });
    expect(index.resolve("Foto.png", "Notes/A.md")).toBe("Bilder/Foto.png");
    // A note of the same name still wins over a name without extension.
    expect(index.resolve("Foto", "Notes/A.md")).toBe("Foto.md");
    expect(index.resolve("Fehlt.png", "Notes/A.md")).toBeNull();
  });
});

describe("search operators", () => {
  const index = vault({
    "Rezepte/Kuchen.md": [
      "# Kuchen",
      "Mehl und Zucker verrühren.",
      "Eier extra.",
      "## Einkauf",
      "- [ ] Mehl kaufen",
      "- [x] Zucker kaufen",
      "Rechnung 2026-11-03",
    ].join("\n"),
    "Rezepte/Brot.md": "# Brot\nMehl\nund Wasser, kein Zucker.\n- [x] Mehl kaufen",
  });
  const find = (query: string) =>
    index.files
      .map((path) => searchNote(index, path, parseQuery(query)))
      .filter((result) => result !== null);
  const paths = (query: string) => find(query).map((result) => result.path);
  const hits = (query: string) =>
    find(query).flatMap((result) =>
      result.matches.map((m) => m.text.slice(m.start, m.start + m.length)),
    );

  it("parses scoped groups and regular expressions", () => {
    const query = parseQuery('line:(mehl "zucker ver") -section:eier /\\d{4}-\\d\\d/ task-todo:""');
    expect(query.scoped).toEqual([
      { scope: "line", matchers: [{ text: "mehl" }, { text: "zucker ver" }] },
      { scope: "task-todo", matchers: [] },
    ]);
    expect(query.excludedScoped).toEqual([
      { scope: "section", matchers: [{ text: "eier" }] },
    ]);
    expect(query.regexes.map((regex) => regex.source)).toEqual(["\\d{4}-\\d\\d"]);
    expect(query.terms).toEqual([]);
  });

  it("keeps slashes in paths and invalid patterns as text", () => {
    expect(parseQuery("a/b/c /notes").terms).toEqual(["a/b/c", "/notes"]);
    expect(parseQuery("/foo(/").terms).toEqual(["/foo(/"]);
    expect(parseQuery("path:/Archiv/").path).toEqual(["/archiv/"]);
  });

  it("requires line: terms on one line", () => {
    expect(paths("line:(mehl zucker)")).toEqual(["Rezepte/Kuchen.md"]);
    expect(hits("line:(mehl zucker)")).toEqual(["Mehl", "Zucker"]);
    expect(paths("mehl zucker")).toEqual(["Rezepte/Brot.md", "Rezepte/Kuchen.md"]);
    expect(paths("-line:(mehl zucker)")).toEqual(["Rezepte/Brot.md"]);
  });

  it("requires section: terms under one heading", () => {
    expect(paths("section:(eier zucker)")).toEqual(["Rezepte/Kuchen.md"]);
    expect(paths("section:(eier rechnung)")).toEqual([]);
    expect(paths("section:(wasser zucker)")).toEqual(["Rezepte/Brot.md"]);
  });

  it("finds open, done and any tasks", () => {
    expect(paths("task-todo:mehl")).toEqual(["Rezepte/Kuchen.md"]);
    expect(paths("task-done:mehl")).toEqual(["Rezepte/Brot.md"]);
    expect(paths("task:zucker")).toEqual(["Rezepte/Kuchen.md"]);
    // A task's checkbox and bullet are not part of its text.
    expect(paths("task:x")).toEqual([]);
    expect(hits('task-todo:""')).toEqual(["Mehl kaufen"]);
    expect(paths("task-done:()")).toEqual(["Rezepte/Brot.md", "Rezepte/Kuchen.md"]);
  });

  it("matches regular expressions case-insensitively", () => {
    expect(paths("/\\d{4}-\\d{2}-\\d{2}/")).toEqual(["Rezepte/Kuchen.md"]);
    expect(hits("/\\d{4}-\\d{2}-\\d{2}/")).toEqual(["2026-11-03"]);
    expect(paths("/^mehl$/m")).toEqual([]);
    expect(paths("/^MEHL$/")).toEqual(["Rezepte/Brot.md"]);
    expect(paths("line:/^mehl$/")).toEqual(["Rezepte/Brot.md"]);
    expect(paths("-/wasser/")).toEqual(["Rezepte/Kuchen.md"]);
    expect(paths("line:(/z.cker/ mehl)")).toEqual(["Rezepte/Kuchen.md"]);
  });
});
