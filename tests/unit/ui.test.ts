import { describe, expect, it } from "vitest";
import { CommandRegistry } from "../../src/app/commands";
import { renderMarkdown, splitFrontmatter } from "../../src/markdown";
import { fuzzyMatch, highlightMatch } from "../../src/ui/fuzzy";

describe("fuzzy matching", () => {
  it("prefers contiguous and word-start matches", () => {
    const direct = fuzzyMatch("plan", "Projektplan")!;
    const start = fuzzyMatch("plan", "Plan B")!;
    const scattered = fuzzyMatch("plan", "People Later Any Night")!;
    expect(start.score).toBeGreaterThan(direct.score);
    expect(direct.score).toBeGreaterThan(scattered.score);
    expect(direct.positions).toEqual([7, 8, 9, 10]);
    expect(fuzzyMatch("xyz", "Projektplan")).toBeNull();
  });

  it("matches initials across words and marks them", () => {
    const match = fuzzyMatch("tn", "Tages Notiz")!;
    expect(match.positions).toEqual([0, 6]);
    const holder = document.createElement("div");
    holder.append(highlightMatch("Tages Notiz", match.positions));
    expect(holder.innerHTML).toBe(
      '<span class="suggestion-highlight">T</span>ages <span class="suggestion-highlight">N</span>otiz',
    );
  });
});

describe("Obsidian Markdown extensions", () => {
  it("turns callout block quotes into callouts", () => {
    const html = renderMarkdown("> [!warning] Achtung **wichtig**\n> Inhalt");
    expect(html).toContain('class="callout" data-callout="warning"');
    expect(html).toContain("Achtung <strong>wichtig</strong>");
    expect(html).toMatch(/callout-content">\s*<p>Inhalt<\/p>/);
    expect(renderMarkdown("> [!tip]\n> Text")).toContain(
      'class="callout-title-inner">Tip<',
    );
    expect(renderMarkdown("> Nur ein Zitat")).toContain("<blockquote>");
  });

  it("renders tags and highlights but leaves code alone", () => {
    const html = renderMarkdown("Ein #tag/unter und ==wichtig==, `#kein` #42");
    expect(html).toContain('<a class="tag" href="#" data-tag="tag/unter">');
    expect(html).toContain("<mark>wichtig</mark>");
    expect(html).toContain("<code>#kein</code>");
    expect(html).not.toContain('data-tag="42"');
  });

  it("shows frontmatter as properties instead of body text", () => {
    const source = "---\ntitle: Plan\ntags: [a, b]\n---\n# Inhalt";
    expect(splitFrontmatter(source)).toEqual({
      body: "# Inhalt",
      properties: [
        { key: "title", values: ["Plan"] },
        { key: "tags", values: ["a", "b"] },
      ],
    });
    const html = renderMarkdown(source);
    expect(html).toContain("metadata-container");
    expect(html).toContain('data-tag="a"');
    expect(html).toContain("<h1>Inhalt</h1>");
    expect(html).not.toContain("title: Plan");
  });

  it("escapes property values", () => {
    const html = renderMarkdown(
      '---\nx: "<img src=x onerror=alert(1)>"\n---\n',
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("command registry", () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

  it("dispatches hotkeys and respects modal blocking", () => {
    const registry = new CommandRegistry();
    const ran: string[] = [];
    registry.add({
      id: "search",
      name: "Suche",
      hotkey: "Mod+Shift+F",
      run: () => ran.push("search"),
    });
    registry.add({
      id: "palette",
      name: "Palette",
      hotkey: "Mod+P",
      global: true,
      run: () => ran.push("palette"),
    });
    const search = { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true };
    expect(registry.handleKey(key(search), false)).toBe(true);
    expect(registry.handleKey(key(search), true)).toBe(false);
    expect(
      registry.handleKey(key({ key: "p", code: "KeyP", ctrlKey: true }), true),
    ).toBe(true);
    expect(registry.handleKey(key({ key: "p", code: "KeyP" }), false)).toBe(
      false,
    );
    expect(ran).toEqual(["search", "palette"]);
  });

  it("dispatches function keys without modifiers", () => {
    const registry = new CommandRegistry();
    const ran: string[] = [];
    registry.add({
      id: "rename",
      name: "Umbenennen",
      hotkey: "F2",
      run: () => ran.push("rename"),
    });
    expect(
      registry.handleKey(key({ key: "F2", code: "F2" }), false),
    ).toBe(true);
    expect(registry.handleKey(key({ key: "f", code: "KeyF" }), false)).toBe(
      false,
    );
    expect(ran).toEqual(["rename"]);
  });

  it("hides commands whose condition is not met", () => {
    const registry = new CommandRegistry();
    let enabled = false;
    let count = 0;
    registry.add({
      id: "save",
      name: "Speichern",
      hotkey: "Mod+S",
      when: () => enabled,
      run: () => count++,
    });
    expect(registry.list()).toEqual([]);
    registry.run("save");
    expect(
      registry.handleKey(key({ key: "s", code: "KeyS", ctrlKey: true }), false),
    ).toBe(false);
    enabled = true;
    registry.run("save");
    expect(count).toBe(1);
    expect(registry.list().map((command) => command.id)).toEqual(["save"]);
  });
});
