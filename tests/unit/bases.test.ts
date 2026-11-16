import { describe, expect, it } from "vitest";
import {
  Duration,
  evaluate,
  FileValue,
  LinkValue,
  parseExpression,
  toText,
  type EvalHost,
  type FileRecord,
  type Value,
} from "../../src/bases/expr";
import { parseBase, setViewSort } from "../../src/bases/model";
import { runView } from "../../src/bases/query";
import { LinkResolver } from "../../src/app/vault-index";

function record(path: string, properties: Record<string, unknown> = {}, extra: Partial<FileRecord> = {}): FileRecord {
  return {
    path,
    properties,
    tags: [],
    links: [],
    embeds: [],
    size: 10,
    ctime: null,
    mtime: null,
    ...extra,
  };
}

const files = [
  record("Books/Dune.md", { author: "Herbert", rating: 5, read: "2024-03-01", tags: ["book", "scifi"], status: "done" }, { tags: ["book", "scifi"], links: ["Herbert"] }),
  record("Books/Emma.md", { author: "Austen", rating: 4, read: "2023-11-20", status: "reading" }, { tags: ["book/classic"] }),
  record("Books/Hyperion.md", { author: "Simmons", rating: 5, status: "todo", price: 12, pages: 480 }, { tags: ["book", "scifi"] }),
  record("Herbert.md", { type: "author" }, { links: ["Books/Dune"] }),
  record("Notes/Idea.md", {}),
];

function host(now = new Date(2026, 10, 14, 12, 0)): EvalHost {
  const resolver = new LinkResolver(files.map((file) => file.path));
  return {
    resolve: (target, source) => resolver.resolve(target, source),
    file: (path) => files.find((file) => file.path === path) ?? null,
    backlinks: (path) =>
      files
        .filter((file) => file.links.some((link) => resolver.resolve(link, file.path) === path))
        .map((file) => file.path),
    now: () => now,
    locale: "en",
  };
}

function run(source: string, file = files[0], self: FileRecord | null = null): Value {
  return evaluate(parseExpression(source), {
    host: host(),
    file,
    self,
    formula: () => null,
  });
}

describe("bases expressions", () => {
  it("evaluates operators with JavaScript precedence", () => {
    expect(run("1 + 2 * 3")).toBe(7);
    expect(run("(1 + 2) * 3")).toBe(9);
    expect(run("10 % 4 == 2 && !false")).toBe(true);
    expect(run("1 < 2 || missing")).toBe(true);
    expect(run('"a" + 1')).toBe("a1");
    expect(run("-rating + 1")).toBe(-4);
  });

  it("reads note and file properties", () => {
    expect(run("author")).toBe("Herbert");
    expect(run("note.rating >= 5")).toBe(true);
    expect(run('note["status"]')).toBe("done");
    expect(run("missing")).toBeNull();
    expect(run("file.name")).toBe("Dune.md");
    expect(run("file.basename")).toBe("Dune");
    expect(run("file.folder")).toBe("Books");
    expect(run("file.ext")).toBe("md");
    expect(run("file.path")).toBe("Books/Dune.md");
  });

  it("supports the file functions", () => {
    expect(run('file.hasTag("book")', files[1])).toBe(true); // nested tag
    expect(run('file.hasTag("scifi", "x")')).toBe(true);
    expect(run('file.hasTag("sci")')).toBe(false);
    expect(run('file.inFolder("Books")')).toBe(true);
    expect(run('file.inFolder("Book")')).toBe(false);
    expect(run('file.hasProperty("rating")')).toBe(true);
    expect(run('file.hasLink("Herbert")')).toBe(true);
    expect(run("file.hasLink(this)", files[0], files[3])).toBe(true);
    expect(run("file.backlinks.length")).toBe(1);
  });

  it("supports string, number and list methods", () => {
    expect(run('author.lower().contains("herb")')).toBe(true);
    expect(run('author.startsWith("H") && author.endsWith("t")')).toBe(true);
    expect(run('"a,b,c".split(",").length')).toBe(3);
    expect(run('"hello world".title()')).toBe("Hello World");
    expect(run('"abc".replace(/b/, "x")')).toBe("axc");
    expect(run("(2.567).toFixed(1)")).toBe("2.6");
    expect(run("(2.567).round(2)")).toBe(2.57);
    expect(run('tags.contains("scifi")')).toBe(true);
    expect(run("tags.length")).toBe(2);
    expect(run('[3, 1, 2].sort().join("-")')).toBe("1-2-3");
    expect(run("[1, 2, 3].map(value * 2)")).toEqual([2, 4, 6]);
    expect(run("[1, 2, 3, 4].filter(value % 2 == 0)")).toEqual([2, 4]);
    expect(run("[1, 2, 3].reduce(acc + value, 0)")).toBe(6);
    expect(run("[1, 1, 2].unique()")).toEqual([1, 2]);
    expect(run("/^Du/.matches(file.basename)")).toBe(true);
  });

  it("does date arithmetic and formatting", () => {
    expect(run("read")).toEqual(new Date(2024, 2, 1));
    expect(run('date("2024-12-01") + "1M"')).toEqual(new Date(2025, 0, 1));
    expect(run('date("2024-12-01") + "1M" + "4h" + "3m"')).toEqual(new Date(2025, 0, 1, 4, 3));
    expect(run('date("2024-01-10") - "1 week"')).toEqual(new Date(2024, 0, 3));
    expect(run('today() - "1d"')).toEqual(new Date(2026, 10, 13));
    expect(run("read < today()")).toBe(true);
    expect(run('read.format("DD.MM.YYYY")')).toBe("01.03.2024");
    expect(run("read.year")).toBe(2024);
    const diff = run('today() - date("2026-11-04")');
    expect(diff).toBeInstanceOf(Duration);
    expect((diff as Duration).ms).toBe(10 * 864e5);
    expect(run('(today() - date("2026-11-04")).days')).toBe(10);
    expect(run('duration("5h") * 2')).toEqual(new Duration(10 * 36e5));
  });

  it("treats links as the files they point to", () => {
    const value = run('link("Herbert")');
    expect(value).toBeInstanceOf(LinkValue);
    expect(run('link("Herbert") == file("Herbert.md")')).toBe(true);
    expect(run('link("Herbert").asFile().name')).toBe("Herbert.md");
    expect(run('file("Herbert.md")')).toBeInstanceOf(FileValue);
    const withLink = record("x.md", { author: "[[Herbert|Frank]]" });
    expect(toText(run("author", withLink))).toBe("Frank");
    expect(run('author == link("Herbert")', withLink)).toBe(true);
    expect(run("author.asFile().hasLink(\"Books/Dune\")", withLink)).toBe(true);
  });

  it("handles if, min, max and number", () => {
    expect(run('if(rating > 4, "great", "ok")')).toBe("great");
    expect(run('if(false, "x")')).toBeNull();
    expect(run("max(1, rating, 3)")).toBe(5);
    expect(run("min(rating, 3)")).toBe(3);
    expect(run('number("4.5") + 1')).toBe(5.5);
  });

  it("rejects syntax errors and unknown functions", () => {
    expect(() => parseExpression("1 +")).toThrow();
    expect(() => parseExpression('"open')).toThrow();
    expect(() => run("nope()")).toThrow(/Unknown function/);
  });
});

describe("bases views", () => {
  const base = `
filters:
  and:
    - file.inFolder("Books")
formulas:
  stars: '"★".repeat(rating)'
  per_page: 'if(pages, (price / pages * 100).toFixed(1), "")'
properties:
  formula.stars:
    displayName: Sterne
views:
  - type: table
    name: All books
    order: [file.name, author, formula.stars]
    sort:
      - property: rating
        direction: DESC
      - property: file.name
        direction: ASC
  - type: cards
    name: Science fiction
    filters:
      or:
        - file.hasTag("scifi")
        - 'status == "reading"'
    groupBy:
      property: status
      direction: ASC
    limit: 10
    image: cover
`;

  it("parses filters, formulas, display names and views", () => {
    const config = parseBase(base);
    expect(config.errors).toEqual([]);
    expect(config.views.map((view) => view.name)).toEqual(["All books", "Science fiction"]);
    expect(config.views[0].order).toEqual(["file.name", "note.author", "formula.stars"]);
    expect(config.views[0].sort).toEqual([
      { property: "note.rating", direction: "DESC" },
      { property: "file.name", direction: "ASC" },
    ]);
    expect(config.views[1].groupBy).toEqual({ property: "note.status", direction: "ASC" });
    expect(config.views[1].image).toBe("note.cover");
    expect(config.displayNames.get("formula.stars")).toBe("Sterne");
  });

  it("filters, sorts and evaluates formulas", () => {
    const config = parseBase(base);
    const result = runView(config, config.views[0], files, host(), null);
    expect(result.errors).toEqual([]);
    expect(result.total).toBe(3);
    const rows = result.groups[0].rows;
    expect(rows.map((row) => row.file.path)).toEqual([
      "Books/Dune.md",
      "Books/Hyperion.md",
      "Books/Emma.md",
    ]);
    expect(rows[2].value("formula.stars")).toBe("★★★★");
    expect(rows[1].value("formula.per_page")).toBe("2.5");
  });

  it("groups by a property with empty values last", () => {
    const config = parseBase(base);
    const result = runView(config, config.views[1], files, host(), null);
    expect(result.groups.map((group) => group.key)).toEqual(["done", "reading", "todo"]);
  });

  it("applies limits, not filters and reports bad formulas once", () => {
    const config = parseBase(`
formulas:
  broken: 'nope(1)'
  loop: 'formula.loop + 1'
filters:
  not:
    - file.inFolder("Books")
views:
  - type: table
    name: Rest
    limit: 1
    order: [file.name, formula.broken, formula.loop]
`);
    const result = runView(config, config.views[0], files, host(), null);
    expect(result.total).toBe(2);
    expect(result.groups[0].rows.map((row) => row.file.path)).toEqual(["Herbert.md"]);
    for (const row of result.groups[0].rows) {
      row.value("formula.broken");
      row.value("formula.loop");
    }
    expect(result.errors).toEqual([
      "formula.broken: Unknown function nope()",
      "formula.loop: Zirkelbezug",
    ]);
  });

  it("shows the file name and used properties when no order is given", () => {
    const config = parseBase("views:\n  - type: table\n    name: T\n    filters: 'file.hasTag(\"book\")'\n");
    const result = runView(config, config.views[0], files, host(), null);
    expect(result.columns.slice(0, 3)).toEqual(["file.name", "note.author", "note.rating"]);
  });

  it("reports YAML and expression errors instead of throwing", () => {
    expect(parseBase("views: [").errors.length).toBeGreaterThan(0);
    expect(parseBase("filters: 'a =='\nviews: []").errors[0]).toMatch(/a ==/);
    expect(parseBase("").views).toEqual([]);
  });

  it("rewrites only the sort of one view, keeping everything else byte for byte", () => {
    const text =
      "# my base\nviews:\n  - type: table\n    name: A # first\n    order: [file.name, autor]\n  - type: cards\n    name: B # cards\n";
    const sorted = setViewSort(text, 1, [{ property: "note.rating", direction: "DESC" }])!;
    expect(sorted).toBe(
      "# my base\nviews:\n  - type: table\n    name: A # first\n    order: [file.name, autor]\n  - type: cards\n    name: B # cards\n    sort:\n      - property: rating\n        direction: DESC\n",
    );
    const resorted = setViewSort(sorted, 1, [{ property: "note.Jahre alt", direction: "ASC" }])!;
    expect(resorted).toBe(sorted.replace("property: rating\n        direction: DESC", 'property: "Jahre alt"\n        direction: ASC'));
    expect(setViewSort(resorted, 1, [])).toBe(text);
    const first = setViewSort(text, 0, [{ property: "file.name", direction: "ASC" }])!;
    expect(first).toBe(text.replace("autor]\n", "autor]\n    sort:\n      - property: file.name\n        direction: ASC\n"));
    expect(parseBase(first).views[0].sort).toEqual([{ property: "file.name", direction: "ASC" }]);
    expect(setViewSort("views: [", 0, [])).toBeNull();
    expect(setViewSort("views: [{type: table}]", 0, [])).toBeNull();
  });
});
