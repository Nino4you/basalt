import { expect, it } from "vitest";
import { mathSpans } from "../../src/editor/math-source";

it("keeps escapes and exact backtick runs out of formulas", () => {
  expect(
    mathSpans("\\$x$ `$y$` ``a`$z$`` $a\\$b$").map((m) => m.source),
  ).toEqual(["$a\\$b$"]);
  expect(mathSpans("`a $x$`` ").map((m) => m.source)).toEqual(["$x$"]);
});
