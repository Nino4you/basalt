import { expect, it } from "vitest";
import {
  isLink,
  parseShare,
  safeFileName,
  shareMarkdown,
  shareTitle,
  type SharedContent,
} from "../../src/app/android-share";

const share = (value: Partial<SharedContent>): SharedContent => ({
  subject: "",
  text: "",
  files: [],
  skipped: [],
  ...value,
});

it("parses the activity's JSON and decodes files", () => {
  const parsed = parseShare(
    JSON.stringify({
      subject: " Artikel ",
      text: "https://example.org/a",
      files: [
        { name: "Foto.jpg", type: "image/jpeg", data: btoa("abc") },
        { name: 3, data: "x" },
      ],
      skipped: ["gross.mp4", 1],
    }),
  )!;
  expect(parsed.subject).toBe("Artikel");
  expect(parsed.files).toHaveLength(1);
  expect([...parsed.files[0].bytes]).toEqual([97, 98, 99]);
  expect(parsed.skipped).toEqual(["gross.mp4"]);
  expect(parseShare(JSON.stringify({ text: "  ", files: [] }))).toBeNull();
  expect(() => parseShare(JSON.stringify({ error: "denied" }))).toThrow(
    "denied",
  );
});

it("keeps shared file names inside the attachment folder", () => {
  expect(safeFileName("../../etc/passwd", "")).toBe("passwd");
  expect(safeFileName(".hidden", "text/plain")).toBe("hidden.txt");
  expect(safeFileName("IMG:1?.jpg", "image/jpeg")).toBe("IMG 1 .jpg");
  expect(safeFileName("photo", "image/png")).toBe("photo.png");
  expect(safeFileName("", "image/png")).toMatch(/\.png$/);
  expect(safeFileName(`${"a".repeat(200)}.pdf`, "").length).toBe(120);
});

it("names notes after the subject, first line, host or file", () => {
  const now = new Date(2026, 10, 15, 9, 5);
  expect(shareTitle(share({ subject: "Rezept: Brot" }), now)).toBe(
    "Rezept Brot",
  );
  expect(shareTitle(share({ text: "# Idee\nmehr" }), now)).toBe("Idee");
  expect(shareTitle(share({ text: "https://www.example.org/x" }), now)).toBe(
    "example.org",
  );
  expect(
    shareTitle(
      share({
        files: [{ name: "Scan.pdf", type: "", bytes: new Uint8Array() }],
      }),
      now,
    ),
  ).toBe("Scan");
  expect(shareTitle(share({}), now)).toMatch(/2026-11-15 0905$/);
});

it("turns a shared link with a title into a Markdown link", () => {
  expect(isLink(" https://a.example/b ")).toBe(true);
  expect(isLink("see https://a.example")).toBe(false);
  expect(
    shareMarkdown(share({ subject: "A [b]", text: "https://a.example" }), []),
  ).toBe("[A b](https://a.example)");
  expect(shareMarkdown(share({ text: "Notiz" }), ["![[x.png]]"])).toBe(
    "Notiz\n\n![[x.png]]",
  );
  expect(shareMarkdown(share({}), ["![[a.png]]", "![[b.png]]"])).toBe(
    "![[a.png]]\n![[b.png]]",
  );
});
