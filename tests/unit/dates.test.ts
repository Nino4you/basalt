import { describe, expect, it } from "vitest";
import { formatDate, parseDate } from "../../src/dates";

const day = new Date(2026, 10, 13, 9, 5, 7, 42); // Friday, 13 November 2026

describe("formatDate", () => {
  it("formats the usual note name and time tokens", () => {
    expect(formatDate(day, "YYYY-MM-DD")).toBe("2026-11-13");
    expect(formatDate(day, "D.M.YY HH:mm:ss.SSS")).toBe(
      "13.11.26 09:05:07.042",
    );
    expect(formatDate(day, "h:mm A, a")).toBe("9:05 AM, am");
    expect(formatDate(day, "[Week] W, Q[Q], DDDD")).toBe("Week 46, 4Q, 317");
    expect(formatDate(day, "Do MMMM")).toBe("13th November");
  });

  it("uses the locale for names", () => {
    expect(formatDate(day, "dddd, D. MMMM YYYY", "de")).toBe(
      "Freitag, 13. November 2026",
    );
    expect(formatDate(day, "ddd D MMM", "en")).toBe("Fri 13 Nov");
    expect(formatDate(day, "Do", "de")).toBe("13.");
  });

  it("computes ISO weeks across the year boundary", () => {
    expect(formatDate(new Date(2027, 0, 1), "gggg-[W]ww")).toBe("2026-W53");
    expect(formatDate(new Date(2025, 11, 29), "GGGG-[W]WW")).toBe("2026-W01");
  });
});

describe("parseDate", () => {
  it("reads back what formatDate wrote", () => {
    for (const pattern of [
      "YYYY-MM-DD",
      "DD.MM.YYYY",
      "dddd, D. MMMM YYYY",
      "YYYY/MM/[Journal] DD",
      "Do MMM YY",
    ]) {
      const text = formatDate(day, pattern, "de");
      expect(parseDate(text, pattern, "de")?.toDateString(), pattern).toBe(
        new Date(2026, 10, 13).toDateString(),
      );
    }
  });

  it("refuses other names and impossible days", () => {
    expect(parseDate("Shopping list", "YYYY-MM-DD")).toBeNull();
    expect(parseDate("2026-02-30", "YYYY-MM-DD")).toBeNull();
    expect(parseDate("2026-11", "YYYY-MM")).toBeNull();
  });
});
