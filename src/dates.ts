/**
 * The part of Moment.js date formats that notes use in names and templates:
 * `YYYY-MM-DD`, `dddd, D. MMMM YYYY`, `gggg-[W]ww`, `HH:mm` and the like.
 * Text in `[brackets]` is literal. Names follow the given locale.
 */

const TOKEN =
  /\[([^\]]*)\]|YYYY|YY|Q|MMMM|MMM|MM|M|DDDD|DD|Do|D|dddd|ddd|dd|d|GGGG|gggg|WW|W|ww|w|HH|H|hh|h|mm|m|ss|s|SSS|A|a/g;

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** ISO 8601 week and its year (weeks start on Monday). */
function isoWeek(date: Date): { week: number; year: number } {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - weekday + 3);
  const firstThursday = new Date(day.getFullYear(), 0, 4);
  const week =
    1 +
    Math.round(
      ((day.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getDay() + 6) % 7)) /
        7,
    );
  return { week, year: day.getFullYear() };
}

function dayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 1);
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((day.getTime() - start.getTime()) / 86_400_000) + 1;
}

function ordinal(value: number, locale: string): string {
  if (!locale.startsWith("en")) return `${value}.`;
  const rule = new Intl.PluralRules("en", { type: "ordinal" }).select(value);
  const suffix = { one: "st", two: "nd", few: "rd" }[rule as string] ?? "th";
  return `${value}${suffix}`;
}

export function formatDate(date: Date, pattern: string, locale = "en"): string {
  const name = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, options).format(date);
  return pattern.replace(TOKEN, (token, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    const hours = date.getHours();
    switch (token) {
      case "YYYY":
        return pad(date.getFullYear(), 4);
      case "YY":
        return pad(date.getFullYear() % 100);
      case "Q":
        return String(Math.floor(date.getMonth() / 3) + 1);
      case "MMMM":
        return name({ month: "long" });
      case "MMM":
        return name({ month: "short" });
      case "MM":
        return pad(date.getMonth() + 1);
      case "M":
        return String(date.getMonth() + 1);
      case "DDDD":
        return pad(dayOfYear(date), 3);
      case "DD":
        return pad(date.getDate());
      case "Do":
        return ordinal(date.getDate(), locale);
      case "D":
        return String(date.getDate());
      case "dddd":
        return name({ weekday: "long" });
      case "ddd":
        return name({ weekday: "short" });
      case "dd":
        return name({ weekday: "narrow" });
      case "d":
        return String(date.getDay());
      case "GGGG":
      case "gggg":
        return pad(isoWeek(date).year, 4);
      case "WW":
      case "ww":
        return pad(isoWeek(date).week);
      case "W":
      case "w":
        return String(isoWeek(date).week);
      case "HH":
        return pad(hours);
      case "H":
        return String(hours);
      case "hh":
        return pad(hours % 12 || 12);
      case "h":
        return String(hours % 12 || 12);
      case "mm":
        return pad(date.getMinutes());
      case "m":
        return String(date.getMinutes());
      case "ss":
        return pad(date.getSeconds());
      case "s":
        return String(date.getSeconds());
      case "SSS":
        return pad(date.getMilliseconds(), 3);
      case "A":
        return hours < 12 ? "AM" : "PM";
      case "a":
        return hours < 12 ? "am" : "pm";
    }
    return token;
  });
}

/**
 * Reads back a calendar day written with `pattern`, or `null`. Year, month
 * and day must come from numeric tokens or month names; weekday names and
 * other tokens only have to be present.
 */
export function parseDate(
  text: string,
  pattern: string,
  locale = "en",
): Date | null {
  const months = (style: "long" | "short") =>
    Array.from({ length: 12 }, (_, month) =>
      new Intl.DateTimeFormat(locale, { month: style })
        .format(new Date(2000, month, 15))
        .toLowerCase(),
    );
  const fields: Array<(value: string) => void> = [];
  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;
  let source = "";
  let last = 0;
  const escape = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const match of pattern.matchAll(TOKEN)) {
    source += escape(pattern.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[1] !== undefined) {
      source += escape(match[1]);
      continue;
    }
    const token = match[0];
    const group = (regex: string, set?: (value: string) => void) => {
      source += `(${regex})`;
      fields.push(set ?? (() => {}));
    };
    switch (token) {
      case "YYYY":
        group("\\d{4}", (v) => (year = Number(v)));
        break;
      case "YY":
        group("\\d{2}", (v) => (year = 2000 + Number(v)));
        break;
      case "MM":
        group("\\d{2}", (v) => (month = Number(v)));
        break;
      case "M":
        group("\\d{1,2}", (v) => (month = Number(v)));
        break;
      case "MMMM":
      case "MMM": {
        const names = months(token === "MMMM" ? "long" : "short");
        group(
          names.map(escape).join("|"),
          (v) => (month = names.indexOf(v.toLowerCase()) + 1),
        );
        break;
      }
      case "DD":
        group("\\d{2}", (v) => (day = Number(v)));
        break;
      case "D":
        group("\\d{1,2}", (v) => (day = Number(v)));
        break;
      case "Do":
        group("\\d{1,2}(?:st|nd|rd|th|\\.)", (v) => (day = parseInt(v, 10)));
        break;
      default:
        group("[\\p{L}\\p{N}.]+");
    }
  }
  source += escape(pattern.slice(last));
  const match = new RegExp(`^${source}$`, "iu").exec(text);
  if (!match) return null;
  fields.forEach((set, index) => set(match[index + 1]));
  if (year === null || month === null || day === null) return null;
  const date = new Date(year, month - 1, day);
  return date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}
