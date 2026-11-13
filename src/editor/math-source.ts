export interface MathSource {
  from: number;
  to: number;
  source: string;
  expression: string;
  display: boolean;
}
function escaped(text: string, at: number): boolean {
  let count = 0;
  while (at > 0 && text[--at] === "\\") count++;
  return count % 2 === 1;
}

export function mathAt(text: string, from: number): MathSource | null {
  if (text[from] !== "$" || escaped(text, from) || text[from - 1] === "$")
    return null;
  const size = text[from + 1] === "$" ? 2 : 1;
  const start = from + size;
  if (size === 1 && /\s/.test(text[start] ?? " ")) return null;
  let close = text.indexOf("$".repeat(size), start);
  while (close >= 0 && escaped(text, close))
    close = text.indexOf("$".repeat(size), close + size);
  if (close <= start) return null;
  const expression = text.slice(start, close);
  if (
    size === 1 &&
    (/\n|\s$/.test(expression) || /\d/.test(text[close + 1] ?? ""))
  )
    return null;
  const to = close + size;
  return {
    from,
    to,
    source: text.slice(from, to),
    expression,
    display: size === 2,
  };
}

/** Inline source scanning for safe Markdown cell rendering; code spans stay code. */
export function mathSpans(text: string): MathSource[] {
  const spans: MathSource[] = [];
  for (let at = 0; at < text.length; at++) {
    if (text[at] === "`" && !escaped(text, at)) {
      let end = at + 1;
      while (text[end] === "`") end++;
      const close = Array.from(text.slice(end).matchAll(/`+/g)).find(
        (run) => run[0].length === end - at,
      );
      if (close) {
        at = end + close.index + close[0].length - 1;
        continue;
      }
      at = end - 1;
    }
    const math = mathAt(text, at);
    if (math) {
      spans.push(math);
      at = math.to - 1;
    }
  }
  return spans;
}
