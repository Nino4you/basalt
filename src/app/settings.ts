import { setSystemBarTheme } from "../ui/android-insets";
import { getLocale, resolveLocale, type Locale } from "../i18n";

export type ThemeChoice = "dark" | "light" | "system";
export type EditingMode = "live" | "source";

export interface Settings {
  language: Locale;
  theme: ThemeChoice;
  accent: string;
  fontSize: number;
  readableLineLength: boolean;
  lineNumbers: boolean;
  spellcheck: boolean;
  /** Editing flavour used whenever a note is not in reading view. */
  editingMode: EditingMode;
  /** New tabs start in reading view. */
  defaultReading: boolean;
  inlineTitle: boolean;
  autoPair: boolean;
  newNoteLocation: "root" | "current";
  showRibbon: boolean;
  /** Rewrite links to a file when it is renamed or moved. */
  updateLinks: boolean;
  /** Folder for daily notes ("" is the vault root). */
  dailyFolder: string;
  /** Moment-style name of a daily note, such as `YYYY-MM-DD`. */
  dailyFormat: string;
  /** Template for new daily notes; "" for none. */
  dailyTemplate: string;
  /** Folder with templates; "" means any folder called `_templates`. */
  templateFolder: string;
}

export const DEFAULT_ACCENT = "#8a5cf5";

export const defaults: Settings = {
  language: "en",
  theme: "dark",
  accent: DEFAULT_ACCENT,
  fontSize: 16,
  readableLineLength: true,
  lineNumbers: false,
  spellcheck: true,
  editingMode: "live",
  defaultReading: false,
  inlineTitle: true,
  autoPair: true,
  newNoteLocation: "root",
  showRibbon: true,
  updateLinks: true,
  dailyFolder: "",
  dailyFormat: "YYYY-MM-DD",
  dailyTemplate: "",
  templateFolder: "",
};

const KEY = "basalt-settings";

function hexToHsl(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const value = parseInt(match[1], 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const hue =
    max === r
      ? (g - b) / d + (g < b ? 6 : 0)
      : max === g
        ? (b - r) / d + 2
        : (r - g) / d + 4;
  return [hue * 60, s * 100, l * 100];
}

export class SettingsStore {
  readonly value: Settings;
  private readonly listeners = new Set<(key: keyof Settings) => void>();
  private readonly media = matchMedia("(prefers-color-scheme: light)");

  constructor() {
    let stored: Partial<Settings> = {};
    try {
      const raw = localStorage.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object") stored = parsed;
    } catch {
      // Corrupt settings fall back to defaults; notes are never affected.
    }
    this.value = { ...defaults };
    for (const key of Object.keys(defaults) as Array<keyof Settings>) {
      const candidate = stored[key];
      if (typeof candidate === typeof defaults[key])
        (this.value as unknown as Record<string, unknown>)[key] = candidate;
    }
    this.value.language = resolveLocale(stored.language);
    // Earlier versions stored only the theme.
    try {
      if (!localStorage.getItem(KEY)) {
        const legacy = localStorage.getItem("basalt-theme");
        if (legacy === "light" || legacy === "dark") this.value.theme = legacy;
      }
    } catch {
      // Settings also work for the session when storage access is denied.
    }
    this.media.addEventListener("change", () => {
      if (this.value.theme === "system") this.apply();
    });
    this.apply();
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.value[key];
  }

  set<K extends keyof Settings>(key: K, next: Settings[K]): boolean {
    if (this.value[key] === next) return true;
    this.value[key] = next;
    let persisted = true;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value));
    } catch {
      // Storage full or blocked: the setting still applies for this session.
      persisted = false;
    }
    this.apply();
    for (const listener of this.listeners) listener(key);
    return persisted;
  }

  onChange(listener: (key: keyof Settings) => void): void {
    this.listeners.add(listener);
  }

  get resolvedTheme(): "dark" | "light" {
    if (this.value.theme === "system")
      return this.media.matches ? "light" : "dark";
    return this.value.theme;
  }

  /** Mirrors settings onto the document; all styling follows from CSS variables. */
  apply(): void {
    const root = document.documentElement;
    root.lang = getLocale();
    const body = document.body;
    const theme = this.resolvedTheme;
    root.dataset.theme = theme;
    body.classList.toggle("theme-dark", theme === "dark");
    body.classList.toggle("theme-light", theme === "light");
    setSystemBarTheme(theme === "dark");
    body.classList.toggle(
      "is-readable-line-width",
      this.value.readableLineLength,
    );
    body.classList.toggle("show-inline-title", this.value.inlineTitle);
    body.classList.toggle("hide-ribbon", !this.value.showRibbon);
    const hsl = hexToHsl(this.value.accent) ?? hexToHsl(DEFAULT_ACCENT)!;
    root.style.setProperty("--accent-h", hsl[0].toFixed(1));
    root.style.setProperty("--accent-s", `${hsl[1].toFixed(1)}%`);
    root.style.setProperty("--accent-l", `${hsl[2].toFixed(1)}%`);
    root.style.setProperty("--font-text-size", `${this.value.fontSize}px`);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#1e1e1e" : "#ffffff");
  }
}
