import { afterEach, expect, it } from "vitest";
import {
  APPEARANCE_FILE,
  listSnippets,
  listThemes,
  readAppearance,
  VaultStyles,
  writeAppearance,
} from "../../src/app/vault-styles";
import { memoryVault } from "../helpers/vault-store";

afterEach(() => {
  document.head
    .querySelectorAll("style[data-basalt-style]")
    .forEach((style) => style.remove());
});

const files = {
  "Basalt/Config/snippets/b.css": ".b { color: red }",
  "Basalt/Config/snippets/a.css": ".a { color: blue }",
  "Basalt/Config/snippets/notes.txt": "nope",
  "Basalt/Config/themes/Minimal/theme.css": "body { --x: 1 }",
  "Basalt/Config/themes/Minimal/manifest.json": "{}",
  "Basalt/Config/themes/Leer/manifest.json": "{}",
};

it("lists snippets and themes like Obsidian's folders", async () => {
  const vault = await memoryVault(files);
  expect(listSnippets(vault)).toEqual(["a", "b"]);
  expect(listThemes(vault)).toEqual(["Minimal"]);
  expect(await readAppearance(vault)).toEqual({
    cssTheme: "",
    enabledCssSnippets: [],
  });
});

it("keeps unknown appearance.json keys when saving", async () => {
  const vault = await memoryVault({
    ...files,
    [APPEARANCE_FILE]: JSON.stringify({
      accentColor: "#123456",
      cssTheme: "Alt",
    }),
  });
  await writeAppearance(vault, {
    cssTheme: "Minimal",
    enabledCssSnippets: ["a"],
  });
  expect(
    JSON.parse(await vault.read(vault.getFileByPath(APPEARANCE_FILE)!)),
  ).toEqual({
    accentColor: "#123456",
    cssTheme: "Minimal",
    enabledCssSnippets: ["a"],
  });
  expect(await readAppearance(vault)).toEqual({
    cssTheme: "Minimal",
    enabledCssSnippets: ["a"],
  });
});

it("creates appearance.json and its folder when missing", async () => {
  const vault = await memoryVault({ "Notiz.md": "x" });
  await writeAppearance(vault, { cssTheme: "", enabledCssSnippets: ["x"] });
  expect(await readAppearance(vault)).toEqual({
    cssTheme: "",
    enabledCssSnippets: ["x"],
  });
});

it("applies the theme before the snippets and removes them again", async () => {
  const vault = await memoryVault(files);
  const styles = new VaultStyles();
  const failed = await styles.apply(vault, {
    cssTheme: "Minimal",
    enabledCssSnippets: ["b", "fehlt", "a"],
  });
  expect(failed).toEqual([]);
  const applied = [
    ...document.head.querySelectorAll<HTMLStyleElement>(
      "style[data-basalt-style]",
    ),
  ];
  expect(
    applied.map(
      (style) => `${style.dataset.basaltStyle}:${style.dataset.name}`,
    ),
  ).toEqual(["theme:Minimal", "snippet:b", "snippet:a"]);
  expect(applied[1].textContent).toBe(".b { color: red }");
  expect(document.body.classList.contains("has-vault-theme")).toBe(true);
  styles.clear();
  expect(
    document.head.querySelectorAll("style[data-basalt-style]"),
  ).toHaveLength(0);
  expect(document.body.classList.contains("has-vault-theme")).toBe(false);
});
