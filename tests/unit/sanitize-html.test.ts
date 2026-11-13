import { describe, expect, it } from "vitest";
import { createObsidianApi } from "../../src/compat/obsidian-api";

const api = createObsidianApi({ app: {} }) as unknown as {
  sanitizeHTMLToDom(html: string): DocumentFragment;
};

describe("sanitizeHTMLToDom", () => {
  it("returns a fragment with the safe markup", () => {
    const fragment = api.sanitizeHTMLToDom(
      '<p onclick="alert(1)">Hallo <b>Welt</b></p><script>alert(2)</script>',
    );
    expect(fragment).toBeInstanceOf(DocumentFragment);
    expect(fragment.querySelector("p")?.getAttribute("onclick")).toBeNull();
    expect(fragment.querySelector("b")?.textContent).toBe("Welt");
    expect(fragment.querySelector("script")).toBeNull();
  });
});
