import { expect, it } from "vitest";
import {
  normalizeCellInput,
  parseTableSource,
} from "../../src/editor/table-model";

it("maps only cell contents, preserving padding, escaped pipes, code and alignment", () => {
  const source = "| A | B |\r\n| :--- | ---: |\r\n| a\\|b | `x\\|y` |";
  const table = parseTableSource(source, 7)!;
  expect(table.alignment).toEqual(["left", "right"]);
  expect(table.rows.map((row) => row.map((cell) => cell.text))).toEqual([
    ["A", "B"],
    ["a\\|b", "`x\\|y`"],
  ]);
  for (const row of table.rows)
    for (const cell of row)
      expect(source.slice(cell.from - 7, cell.to - 7)).toBe(cell.text);
  const cell = table.rows[1][0];
  expect(
    source.slice(0, cell.from - 7) + "neu" + source.slice(cell.to - 7),
  ).toBe("| A | B |\r\n| :--- | ---: |\r\n| neu | `x\\|y` |");
});

it("handles optional edge pipes and empty cells conservatively", () => {
  expect(
    parseTableSource("A | B\n--- | ---\nx | |")?.rows[1].map((c) => c.text),
  ).toEqual(["x", ""]);
  expect(
    parseTableSource("| A | B |\n|---|---|\n| | z |")?.rows[1].map(
      (c) => c.text,
    ),
  ).toEqual(["", "z"]);
  expect(parseTableSource("A | B\n--- | ---\none")).toBeNull();
});

it("normalizes pasted cell text without introducing rows or columns", () => {
  expect(normalizeCellInput("a\r\nb|c\\|d")).toBe("a b\\|c\\|d");
  expect(normalizeCellInput("a\\\\|b")).toBe("a\\\\\\|b");
  expect(normalizeCellInput("a\\")).toBe("a\\");
});

it("does not hide column separators behind mismatched backtick runs", () => {
  expect(
    parseTableSource("| A | B |\n|---|---|\n| `x | y`` |")?.rows[1].map(
      (c) => c.text,
    ),
  ).toEqual(["`x", "y``"]);
  expect(
    parseTableSource("| A | B |\n|---|---|\n| `x | `y` |")?.rows[1].map(
      (c) => c.text,
    ),
  ).toEqual(["`x", "`y`"]);
});
