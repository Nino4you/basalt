import { en } from "./en";

export const languages = [
  { id: "de", name: "Deutsch" },
  { id: "en", name: "English" },
] as const;

export type Locale = (typeof languages)[number]["id"];
export type MessageKey = keyof typeof en;
export type Catalog = Partial<Record<MessageKey, string>>;

/** Missing translations fall back to the German source message. */
export const catalogs: Record<Locale, Catalog> = { de: {}, en };

export function isLocale(value: unknown): value is Locale {
  return languages.some(({ id }) => id === value);
}

export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : "en";
}

/** Read before UI modules evaluate their static command/panel labels. */
function storedLocale(): Locale {
  try {
    return resolveLocale(
      JSON.parse(localStorage.getItem("basalt-settings") ?? "null")?.language,
    );
  } catch {
    return "en";
  }
}

const locale = storedLocale();
export const getLocale = (): Locale => locale;

type Slots<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Slots<Rest>
  : never;
type Values<K extends MessageKey> = Record<Slots<K>, string | number>;
type Args<K extends MessageKey> = [Slots<K>] extends [never]
  ? [values?: never]
  : [values: Values<K>];

/** Returns plain text. Callers must escape it when generating HTML. */
export function translate<K extends MessageKey>(
  language: Locale,
  key: K,
  ...args: Args<K>
): string {
  const message = catalogs[language][key] ?? key;
  const values = args[0] as Record<string, string | number> | undefined;
  return message.replace(/\{(\w+)\}/g, (slot, name: string) => {
    if (!values || !Object.hasOwn(values, name)) return slot;
    const value = values[name];
    return typeof value === "number"
      ? new Intl.NumberFormat(language).format(value)
      : value;
  });
}

export function t<K extends MessageKey>(key: K, ...args: Args<K>): string {
  return translate(locale, key, ...args);
}

type CountMessage = MessageKey & `${string}{count}${string}`;
type PluralForms = Partial<Record<Intl.LDMLPluralRule, CountMessage>> & {
  other: CountMessage;
};

/** Extra forms (zero/two/few/many) can be supplied for additional languages. */
export function plural(count: number, forms: PluralForms): string {
  const key = forms[new Intl.PluralRules(locale).select(count)] ?? forms.other;
  return t(key, { count });
}
