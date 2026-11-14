/**
 * The single search term a replacement applies to, in the case it was typed,
 * or null when the query has none or several. Filters such as `path:` and
 * `tag:` may accompany it; they only narrow the files. Same syntax as
 * `parseQuery`.
 */
export function replaceableTerm(query: string): string | null {
  const terms: string[] = [];
  const pattern = /(-)?(?:(tag|path|file):)?(?:"([^"]*)"|(\S+))/gi;
  for (let m = pattern.exec(query); m; m = pattern.exec(query)) {
    const value = m[3] ?? m[4];
    if (!value || m[1] || m[2]) continue;
    if (value.startsWith("#") && value.length > 1) continue;
    terms.push(value);
  }
  return terms.length === 1 ? terms[0] : null;
}

/**
 * Replaces every occurrence of `term` like the search finds it: without
 * regard to case unless `matchCase`. Returns the new text and the count.
 */
export function replaceTerm(
  text: string,
  term: string,
  replacement: string,
  matchCase = false,
): { text: string; count: number } {
  if (!term) return { text, count: 0 };
  const haystack = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? term : term.toLowerCase();
  // Lower-casing can change the length of a few characters (such as "İ");
  // offsets would then point elsewhere, so such texts are left alone.
  if (haystack.length !== text.length) return { text, count: 0 };
  let result = "";
  let last = 0;
  let count = 0;
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    result += text.slice(last, at) + replacement;
    last = at + needle.length;
    count++;
  }
  return count ? { text: result + text.slice(last), count } : { text, count };
}
