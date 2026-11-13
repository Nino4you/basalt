import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogs, translate, type MessageKey } from "../../src/i18n";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("translation catalogs", () => {
  it("uses English translations and German source messages as fallback", () => {
    expect(translate("en", "Einstellungen")).toBe("Settings");
    expect(translate("de", "Einstellungen")).toBe("Einstellungen");
  });

  it("preserves every placeholder in each translation", () => {
    const slots = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const catalog of Object.values(catalogs)) {
      for (const [source, translation] of Object.entries(catalog)) {
        expect(slots(translation), source).toEqual(slots(source));
        expect(translation.trim(), source).not.toBe("");
      }
    }
  });

  it("formats numeric parameters using the selected language", () => {
    expect(translate("en", "{count} Zeichen", { count: 12345 })).toBe(
      "12,345 characters",
    );
    expect(translate("de", "{count} Zeichen", { count: 12345 })).toBe(
      "12.345 Zeichen",
    );
  });

  it("keeps substituted text literal, including replacement tokens and markup", () => {
    const name = '<img src=x onerror="bad()"> $& {count}';
    expect(translate("en", "{name} öffnen", { name })).toBe(`Open ${name}`);
  });

  it("requires known keys and their named parameters at compile time", () => {
    // These calls must fail TypeScript checking if the catalog contract regresses.
    if (false) {
      // @ts-expect-error unknown message
      translate("en", "unknown message");
      // @ts-expect-error required placeholder is missing
      translate("en", "{name} öffnen");
      // @ts-expect-error placeholder name is misspelled
      translate("en", "{name} öffnen", { title: "Note" });
    }
    expect(Object.keys(catalogs.en).length).toBeGreaterThan(300);
  });
});

describe("startup language", () => {
  async function freshLocale(raw?: string) {
    localStorage.clear();
    if (raw !== undefined) localStorage.setItem("basalt-settings", raw);
    vi.resetModules();
    return import("../../src/i18n");
  }

  it.each([
    undefined,
    "bad json",
    "null",
    '{"language":"xx"}',
    '{"theme":"light"}',
  ])(
    "defaults to English for missing or unusable settings (%s)",
    async (raw) => {
      const { getLocale, t } = await freshLocale(raw);
      expect(getLocale()).toBe("en");
      expect(t("Neue Notiz")).toBe("New note");
    },
  );

  it.each(["de", "en"])(
    "restores %s and selects plural forms",
    async (language) => {
      const { getLocale, plural } = await freshLocale(
        JSON.stringify({ language }),
      );
      expect(getLocale()).toBe(language);
      const forms = { one: "{count} Wort", other: "{count} Wörter" } as const;
      expect(plural(0, forms)).toBe(language === "en" ? "0 words" : "0 Wörter");
      expect(plural(1, forms)).toBe(language === "en" ? "1 word" : "1 Wort");
      expect(plural(2, forms)).toBe(language === "en" ? "2 words" : "2 Wörter");
    },
  );

  it("still starts in English when browser storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    vi.resetModules();
    const { getLocale } = await import("../../src/i18n");
    expect(getLocale()).toBe("en");
  });

  it("reports the active language to plugins", async () => {
    await freshLocale('{"language":"en"}');
    const { createObsidianApi } = await import("../../src/compat/obsidian-api");
    const api = createObsidianApi({ app: {} });
    expect((api.getLanguage as () => string)()).toBe("en");
  });

  it("uses German source text when a target translation is missing", async () => {
    const { catalogs, translate } = await freshLocale();
    const key: MessageKey = "Einstellungen";
    delete catalogs.en[key];
    expect(translate("en", key)).toBe(key);
  });
});
