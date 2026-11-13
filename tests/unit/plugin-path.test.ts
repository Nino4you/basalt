import { expect, it } from "vitest";
import { pluginPath } from "../../src/compat/plugin-path";

it("provides pure vault-path helpers without filesystem access", () => {
  expect(pluginPath.sep).toBe("/");
  expect(pluginPath.basename("Ordner/Notiz.md")).toBe("Notiz.md");
  expect(pluginPath.basename("Ordner/Notiz.md", ".md")).toBe("Notiz");
  expect(pluginPath.dirname("Ordner/Notiz.md")).toBe("Ordner");
  expect(pluginPath.dirname("Notiz.md")).toBe(".");
  expect(pluginPath.dirname("/")).toBe("/");
  expect(pluginPath.extname("Ordner/Notiz.md")).toBe(".md");
  expect(pluginPath.join("Ordner", "..", "Andere", "Notiz.md")).toBe(
    "Andere/Notiz.md",
  );
  expect(pluginPath.normalize("./Ordner//Notiz.md")).toBe("Ordner/Notiz.md");
  expect(pluginPath.isAbsolute("/Ordner/Notiz.md")).toBe(true);
});
