import { LanguageDescription } from "@codemirror/language";
import { expect, it } from "vitest";
import { codeLanguages } from "../../src/editor/syntax";

it.each([
  ["java", "Java"],
  ["bash", "Shell"],
  ["powershell", "PowerShell"],
  ["sql", "SQL"],
  ["python", "Python"],
])("loads the %s fenced-code language", async (alias, name) => {
  const description = LanguageDescription.matchLanguageName(codeLanguages, alias);
  expect(description?.name).toBe(name);
  const support = await description!.load();
  expect(support.language).toBeTruthy();
});
