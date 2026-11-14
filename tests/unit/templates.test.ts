import { expect, it } from "vitest";
import { expandTemplate, templatePaths } from "../../src/app/templates";

it("lists only Markdown templates below _templates", () => {
  expect(
    templatePaths([
      "Note.md",
      "_templates/Seitenvorlage.md",
      "Ordner/_templates/Aufgabe.md",
      "_templates/Bild.png",
      "_templates/Unterordner/Tief.md",
    ]),
  ).toEqual([
    "Ordner/_templates/Aufgabe.md",
    "_templates/Seitenvorlage.md",
    "_templates/Unterordner/Tief.md",
  ]);
});

it("replaces title, date and time with the documented default formats", () => {
  const date = new Date(2026, 10, 12, 7, 5, 9);
  expect(
    expandTemplate(
      "# {{title}}\n{{date}} {{time}} {{date:YYYY/MM/DD}} {{time:HH.mm.ss}}",
      "Meine Notiz",
      date,
    ),
  ).toBe("# Meine Notiz\n2026-11-12 07:05 2026/11/12 07.05.09");
});

it("leaves unknown placeholders untouched and does not interpret dollars in the title", () => {
  expect(expandTemplate("{{title}} {{other}}", "$& $1")).toBe(
    "$& $1 {{other}}",
  );
});

it("lists templates from a configured folder, or from _templates folders", () => {
  const files = [
    "_templates/Daily.md",
    "Projects/_templates/Kickoff.md",
    "Vorlagen/Meeting.md",
    "Vorlagen/Sub/Retro.md",
    "Vorlagen/image.png",
    "Vorlagen-alt/Old.md",
  ];
  expect(templatePaths(files)).toEqual([
    "Projects/_templates/Kickoff.md",
    "_templates/Daily.md",
  ]);
  expect(templatePaths(files, "Vorlagen/")).toEqual([
    "Vorlagen/Meeting.md",
    "Vorlagen/Sub/Retro.md",
  ]);
});

it("formats Moment.js names in template dates", () => {
  const date = new Date(2026, 10, 13, 8, 30);
  expect(expandTemplate("{{date:dddd, [KW] W}} {{time}}", "T", date)).toBe(
    "Freitag, KW 46 08:30",
  );
});
