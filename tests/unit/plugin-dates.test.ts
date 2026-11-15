import { expect, it } from "vitest";
import { createObsidianApi } from "../../src/compat/obsidian-api";

it("uses the same real date API for imported and global plugin dates", () => {
  const moment = createObsidianApi({ app: {} }).moment as typeof import("moment");
  expect(Reflect.get(globalThis, "moment")).toBe(moment);
  const original = moment("2024-02-29 13:45", "YYYY-MM-DD HH:mm", true);
  expect(original.format("YYYY-MM-DD HH:mm")).toBe("2024-02-29 13:45");
  expect(original.isValid()).toBe(true);
  const next = original.clone().add(1, "day");
  expect(next.format("YYYY-MM-DD")).toBe("2024-03-01");
  expect(original.format("YYYY-MM-DD")).toBe("2024-02-29");
  expect(next.diff(original, "days")).toBe(1);
  expect(original.isSame(moment("2024-02-29"), "day")).toBe(true);
  expect(moment("2024-02-30", "YYYY-MM-DD", true).isValid()).toBe(false);
});

it("provides real calendar locale data and durations without locale filesystem access", () => {
  const moment = createObsidianApi({ app: {} }).moment as typeof import("moment");
  const german = moment("2024-03-01").locale("de");
  expect(german.format("MMMM")).toBe("März");
  expect(german.localeData().firstDayOfWeek()).toBe(1);
  expect(moment("2024-03-01").locale("en").format("MMMM")).toBe("March");
  expect(moment.duration(90, "minutes").asHours()).toBe(1.5);
});
