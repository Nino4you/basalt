import { afterEach, expect, it, vi } from "vitest";
import { LinkPreview, previewExcerpt } from "../../src/app/link-preview";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

it("extracts readable preview text from Markdown", () => {
  expect(
    previewExcerpt(
      "---\ntags: [test]\n---\n# Überschrift\n\n[[Ziel|Alias]] und [[Andere]]\n\n```ts\ncode()\n```\n> Zitat",
      120,
    ),
  ).toBe("Überschrift\nAlias und Andere\nZitat");
});

it("shows a resolved note only after a short hover delay", () => {
  vi.useFakeTimers();
  const resolve = vi.fn(() => ({ title: "Ziel", text: "# Ziel\n\nInhalt" }));
  const preview = new LinkPreview(resolve);
  const rect = new DOMRect(20, 20, 40, 20);
  preview.show("Ziel", "Quelle.md", rect);
  expect(document.querySelector(".link-preview")).toBeNull();
  vi.advanceTimersByTime(299);
  expect(document.querySelector(".link-preview")).toBeNull();
  vi.advanceTimersByTime(1);
  expect(resolve).toHaveBeenCalledWith("Ziel", "Quelle.md");
  expect(document.querySelector(".link-preview-title")?.textContent).toBe("Ziel");
  expect(document.querySelector(".link-preview-body")?.textContent).toBe("Inhalt");
  preview.dispose();
});

it("cancels a pending preview and ignores unresolved notes", () => {
  vi.useFakeTimers();
  const resolve = vi.fn(() => null);
  const preview = new LinkPreview(resolve);
  preview.show("Fehlt", "Quelle.md", new DOMRect());
  preview.hide();
  vi.advanceTimersByTime(400);
  expect(resolve).not.toHaveBeenCalled();
  preview.show("Fehlt", "Quelle.md", new DOMRect());
  vi.advanceTimersByTime(400);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".link-preview")).toBeNull();
  preview.dispose();
});
