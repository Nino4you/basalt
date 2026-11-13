import { expect, it } from "vitest";
import { createObsidianApi } from "../../src/compat/obsidian-api";

type ArrayHelpers<T> = T[] & {
  first(): T | undefined;
  last(): T | undefined;
  contains(target: T): boolean;
  remove(target: T): void;
  shuffle(): T[];
  unique(): T[];
};

it("installs Obsidian's documented array, math, string and number helpers", () => {
  createObsidianApi({ app: {} });
  const values = [1, 2, 3, 2] as ArrayHelpers<number>;
  expect(values.first()).toBe(1);
  expect(([] as unknown as ArrayHelpers<number>).first()).toBeUndefined();
  expect(values.last()).toBe(2);
  expect(values.contains(3)).toBe(true);
  values.remove(2);
  expect(values).toEqual([1, 3]);
  expect([...values.shuffle()].sort()).toEqual([1, 3]);
  expect(([1, 2, 2, 3] as ArrayHelpers<number>).unique()).toEqual([1, 2, 3]);
  expect(
    (Array as ArrayConstructor & { combine<T>(arrays: T[][]): T[] }).combine([
      [1, 2],
      [3],
    ]),
  ).toEqual([1, 2, 3]);
  expect(
    (Math as Math & { clamp(value: number, min: number, max: number): number })
      .clamp(10, 0, 5),
  ).toBe(5);
  expect((Math as Math & { square(value: number): number }).square(-2)).toBe(4);
  expect(
    (String as StringConstructor & { isString(value: unknown): boolean })
      .isString("x"),
  ).toBe(true);
  expect(
    ("foo" as string & { contains(value: string): boolean }).contains("oo"),
  ).toBe(true);
  expect(
    ("foo {0} bar {1}" as string & { format(...args: string[]): string }).format(
      "qux",
      "quux",
    ),
  ).toBe("foo qux bar quux");
  expect(
    (Number as NumberConstructor & { isNumber(value: unknown): boolean })
      .isNumber(NaN),
  ).toBe(true);
});
