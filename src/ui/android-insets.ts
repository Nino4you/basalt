/**
 * Receives the system bar and keyboard insets that the native Android
 * activity forwards (see tools/patch_android.mjs) and exposes them as CSS
 * variables. Edge-to-edge draws the WebView under those areas, and WebViews
 * before Chrome 136 report none of them through `env(safe-area-inset-*)`.
 *
 * - `--android-inset-{top,right,bottom,left}`: system bars and cutouts.
 * - `--keyboard-inset`: the part of the on-screen keyboard above the
 *   navigation bar that still overlaps the page. A WebView the system already
 *   shrank for the keyboard yields 0, so nothing is subtracted twice.
 */
export interface AndroidInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
  ime: number;
}

interface AndroidBridge {
  insets(): string;
  setDarkBars?(dark: boolean): void;
}

function bridge(): AndroidBridge | undefined {
  return (window as unknown as { BasaltAndroid?: AndroidBridge }).BasaltAndroid;
}

/** Light or dark system bar icons to match the app theme (Android only). */
export function setSystemBarTheme(dark: boolean): void {
  bridge()?.setDarkBars?.(dark);
}

const SIDES = ["top", "right", "bottom", "left"] as const;

function parse(value: unknown): AndroidInsets | null {
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const number = (key: string) =>
    typeof record[key] === "number" && Number.isFinite(record[key])
      ? Math.max(0, record[key] as number)
      : 0;
  return {
    top: number("top"),
    right: number("right"),
    bottom: number("bottom"),
    left: number("left"),
    ime: number("ime"),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Keyboard overlap the layout still has to make room for, in CSS px. */
export function keyboardOverlap(
  insets: AndroidInsets,
  screenHeight: number,
  viewportHeight: number,
): number {
  const alreadyResized = Math.max(0, screenHeight - viewportHeight);
  return Math.max(0, insets.ime - Math.max(insets.bottom, alreadyResized));
}

export function applyAndroidInsets(
  insets: AndroidInsets,
  root: HTMLElement = document.documentElement,
): void {
  for (const side of SIDES)
    root.style.setProperty(`--android-inset-${side}`, `${insets[side]}px`);
  const keyboard = keyboardOverlap(insets, screen.height, innerHeight);
  root.style.setProperty("--keyboard-inset", `${keyboard}px`);
  document.body.classList.toggle("is-keyboard-open", keyboard > 0);
}

/** Wires the native bridge; a no-op outside the Android app. */
export function installAndroidInsets(): void {
  const native = bridge();
  let last: AndroidInsets | null = null;
  const apply = (value: unknown) => {
    const insets = parse(value);
    if (!insets) return;
    last = insets;
    applyAndroidInsets(insets);
  };
  window.addEventListener("basalt-insets", (event) =>
    apply((event as CustomEvent).detail),
  );
  // A system resize changes how much of the keyboard still overlaps.
  window.addEventListener("resize", () => {
    if (last) applyAndroidInsets(last);
  });
  if (native) apply(native.insets());
}
