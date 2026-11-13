import { afterEach, expect, it, vi } from "vitest";
import {
  installAndroidInsets,
  keyboardOverlap,
  setSystemBarTheme,
} from "../../src/ui/android-insets";

const root = document.documentElement;
const css = (name: string) => root.style.getPropertyValue(name);

afterEach(() => {
  delete (window as unknown as { BasaltAndroid?: unknown }).BasaltAndroid;
  root.removeAttribute("style");
  document.body.className = "";
  vi.unstubAllGlobals();
});

const insets = { top: 52, right: 0, bottom: 48, left: 0, ime: 300 };

it("counts only the keyboard part above the navigation bar", () => {
  expect(keyboardOverlap(insets, 915, 915)).toBe(252);
  expect(keyboardOverlap({ ...insets, ime: 0 }, 915, 915)).toBe(0);
});

it("subtracts nothing twice when the system already shrank the WebView", () => {
  expect(keyboardOverlap(insets, 915, 615)).toBe(0);
  expect(keyboardOverlap(insets, 915, 715)).toBe(100);
});

it("reads the bridge at start-up and follows native inset events", () => {
  vi.stubGlobal("screen", { height: 915 });
  vi.stubGlobal("innerHeight", 915);
  (window as unknown as { BasaltAndroid: unknown }).BasaltAndroid = {
    insets: () => JSON.stringify({ ...insets, ime: 0 }),
  };
  installAndroidInsets();
  expect(css("--android-inset-top")).toBe("52px");
  expect(css("--android-inset-bottom")).toBe("48px");
  expect(css("--keyboard-inset")).toBe("0px");
  expect(document.body.classList.contains("is-keyboard-open")).toBe(false);

  window.dispatchEvent(new CustomEvent("basalt-insets", { detail: insets }));
  expect(css("--keyboard-inset")).toBe("252px");
  expect(document.body.classList.contains("is-keyboard-open")).toBe(true);
});

it("ignores malformed native data", () => {
  (window as unknown as { BasaltAndroid: unknown }).BasaltAndroid = {
    insets: () => "not json",
  };
  installAndroidInsets();
  window.dispatchEvent(new CustomEvent("basalt-insets", { detail: "{" }));
  expect(css("--android-inset-bottom")).toBe("");
  window.dispatchEvent(
    new CustomEvent("basalt-insets", { detail: { bottom: -5, top: "x" } }),
  );
  expect(css("--android-inset-bottom")).toBe("0px");
  expect(css("--android-inset-top")).toBe("0px");
});

it("reports the app theme so system bar icons stay readable", () => {
  const setDarkBars = vi.fn();
  (window as unknown as { BasaltAndroid: unknown }).BasaltAndroid = {
    insets: () => "{}",
    setDarkBars,
  };
  setSystemBarTheme(true);
  setSystemBarTheme(false);
  expect(setDarkBars.mock.calls).toEqual([[true], [false]]);
  delete (window as unknown as { BasaltAndroid?: unknown }).BasaltAndroid;
  expect(() => setSystemBarTheme(true)).not.toThrow();
});
