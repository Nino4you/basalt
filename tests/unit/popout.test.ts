import { expect, it } from "vitest";
import { popoutPath } from "../../src/app/popout";

it("reads the pop-out note from the query string only", () => {
  expect(popoutPath("?popout=Ordner%2FNotiz.md")).toBe("Ordner/Notiz.md");
  expect(popoutPath("")).toBeNull();
  expect(popoutPath("?other=1")).toBeNull();
});
