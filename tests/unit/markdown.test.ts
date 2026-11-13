import { describe, expect, it } from "vitest";
import {
  renderMarkdown,
  resolveNote,
  wikiLinks,
  wordCount,
  documentOutline,
  headingText,
  repeatsTitle,
} from "../../src/markdown";
import { validateNotePath } from "../../src/backend";

describe("Markdown rendering and links", () => {
  it("hands TeX to the math renderer without Markdown escapes or emphasis", () => {
    const el = document.createElement("div");
    el.innerHTML = renderMarkdown(
      [
        "Inline $a_1 * b_2 \\{x\\}$ und #tag.",
        "",
        "$$\\int_0^1 x^2\\,dx$$",
        "",
        "$$",
        "a \\\\",
        "",
        "b \\# c",
        "$$",
        "",
        "Preis $5 und \\$10.",
        "",
        "`$x$` bleibt Code.",
      ].join("\n"),
    );
    const blocks = [...el.querySelectorAll(".math-block")];
    expect(el.querySelector(".math-inline")?.textContent).toBe(
      "$a_1 * b_2 \\{x\\}$",
    );
    expect(el.querySelector("em")).toBeNull();
    expect(blocks.map((block) => block.textContent)).toEqual([
      "$$\\int_0^1 x^2\\,dx$$",
      "$$\na \\\\\n\nb \\# c\n$$",
    ]);
    expect(el.querySelectorAll("a.tag")).toHaveLength(1);
    expect(el.textContent).toContain("Preis $5 und $10");
    expect(el.querySelector("code")?.textContent).toBe("$x$");
  });

  it("detects an opening heading that repeats the note title", () => {
    expect(repeatsTitle("# Darstellung\n\nText", "Darstellung")).toBe(true);
    expect(repeatsTitle("\n# darstellung #\n", "Darstellung")).toBe(true);
    expect(
      repeatsTitle("---\ntags: [a]\n---\n# Darstellung", "Darstellung"),
    ).toBe(true);
    expect(repeatsTitle("## Darstellung", "Darstellung")).toBe(false);
    expect(repeatsTitle("# Platz für Gedanken", "Willkommen")).toBe(false);
    expect(repeatsTitle("Text\n# Darstellung", "Darstellung")).toBe(false);
  });

  it("keeps an unclosed display formula as text", () => {
    const html = renderMarkdown("$$\nx\n\nnoch offen");
    expect(html).not.toContain("math-block");
    expect(html).toContain("noch offen");
  });

  it("renders Markdown and wiki aliases", () => {
    const html = renderMarkdown("# Hallo\n\n[[Ziel|Ein Gedanke]]");
    expect(html).toContain("<h1>Hallo</h1>");
    expect(html).toContain('data-note="Ziel"');
    expect(html).toContain("Ein Gedanke</a>");
  });
  it("renders task checkboxes as non-executable accessible markers", () => {
    const html = renderMarkdown("- [x] Done\n- [ ] Pending");
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain("<input");
  });
  it("removes executable HTML and unsafe URLs", () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)"><a href="javascript:alert(1)">x</a><iframe src="x"></iframe>',
    );
    expect(html).not.toMatch(/<script|onerror|javascript:|<iframe/);
  });
  it("recognizes embed syntax without turning it into an ordinary link", () => {
    const html = renderMarkdown("![[Tabelle.xlsx#Blatt]]");
    expect(html).toContain("is-embed");
    expect(html).not.toContain("!<a");
    expect(wikiLinks("![[Tabelle.xlsx#Blatt]]")).toEqual([
      "Tabelle.xlsx#Blatt",
    ]);
  });
  it("folds callouts marked with a minus and leaves plus callouts open", () => {
    const holder = document.createElement("div");
    holder.innerHTML = renderMarkdown("> [!success]- Lösung\n> Versteckter Rechenweg\n\n> [!note]+ Offen\n> Sichtbar");
    const [folded, open] = holder.querySelectorAll<HTMLElement>(".callout");
    expect(folded.classList.contains("is-collapsed")).toBe(true);
    expect(folded.querySelector(".callout-title")?.getAttribute("aria-expanded")).toBe("false");
    expect(folded.querySelector(".callout-title")?.getAttribute("role")).toBe("button");
    expect(folded.querySelector(".callout-content")?.textContent).toContain("Versteckter Rechenweg");
    expect(open.classList.contains("is-collapsed")).toBe(false);
    expect(open.querySelector(".callout-title")?.getAttribute("aria-expanded")).toBe("true");
  });
  it("does not send remote image requests from preview HTML", () => {
    const html = renderMarkdown(
      "![tracker](https://example.org/pixel.png)\n\n![local](local.png)",
    );
    expect(html).not.toContain('src="https://example.org');
    expect(html).toContain('src="local.png"');
    expect(html).toContain("Datenschutzgründen blockiert");
  });
  it("does not treat code blocks or inline code as wiki links", () => {
    expect(
      wikiLinks("[[Ziel]]\n\n`[[Inline]]`\n\n```md\n[[Code]]\n```\n"),
    ).toEqual(["Ziel"]);
  });
  it("resolves relative links and refuses ambiguous basenames", () => {
    const files = ["A/Note.md", "B/Note.md", "Home.md"];
    expect(resolveNote("Note", "A/Source.md", files)).toBe("A/Note.md");
    expect(resolveNote("Note", "Home.md", files)).toBeNull();
    expect(resolveNote("A/Note#Heading", "Home.md", files)).toBe("A/Note.md");
    expect(resolveNote("#Heading", "Home.md", files)).toBe("Home.md");
  });
  it("counts Unicode words", () => {
    expect(wordCount("Grüße aus Köln — 2026!")).toBe(4);
    expect(wordCount("")).toBe(0);
  });
  it("excludes fenced examples and frontmatter from the outline", () => {
    const source =
      "---\ntitle: Test\n# Not a heading\n---\n# **Title**\n\n```md\n## Example\n```\n\n## Real heading ##\n";
    const outline = documentOutline(source);
    expect(outline.map((entry) => entry.text)).toEqual([
      "Title",
      "Real heading",
    ]);
    expect(outline[0].offset).toBe(source.indexOf("# **Title**"));
    expect(outline[1].depth).toBe(2);
  });
  it("keeps plain heading text and still parses inline syntax", () => {
    for (const plain of [
      "Kapitel 3: Ergebnisse (2026)",
      "Fragen? Antworten! nicht",
      "Grüße aus Köln — „Zitat“ 'a' \"b\"",
      "www.example.com und mail@example.com",
      "#tag und 50 % / 1.5",
    ])
      expect(headingText(plain)).toBe(plain);
    expect(headingText("**Fett** und `Code`")).toBe("Fett und Code");
    expect(headingText("[[Ziel|Alias]] ==markiert==")).toBe("Alias markiert");
    expect(headingText("A &amp; B <b>C</b>")).toBe("A & B C");
    expect(headingText("Wichtig\\!")).toBe("Wichtig!");
  });
  it("validates note paths", () => {
    expect(validateNotePath("Neue Idee")).toBe("Neue Idee.md");
    for (const path of [
      "",
      "../escape",
      "/absolute",
      "a//b",
      ".obsidian/config",
      "a\\b",
    ]) {
      expect(() => validateNotePath(path)).toThrow();
    }
  });
});
