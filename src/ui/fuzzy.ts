export interface FuzzyMatch {
  score: number;
  /** Indices into the candidate string that matched, ascending. */
  positions: number[];
}

const isBoundary = (text: string, index: number) =>
  index === 0 || /[\s/\-_.]/.test(text[index - 1]);

/**
 * Subsequence matcher in the spirit of Obsidian's quick switcher: every query
 * character must occur in order; consecutive runs and word starts score higher.
 * `lower` must be the lower-cased candidate (callers cache it).
 */
export function fuzzyMatch(
  query: string,
  text: string,
  lower: string = text.toLowerCase(),
): FuzzyMatch | null {
  if (!query) return { score: 0, positions: [] };
  // A contiguous hit is what people usually mean; prefer it outright.
  const direct = lower.indexOf(query);
  if (direct >= 0) {
    const positions: number[] = [];
    for (let i = 0; i < query.length; i++) positions.push(direct + i);
    return {
      score:
        1000 +
        query.length * 10 -
        direct -
        (lower.length - query.length) * 0.1 +
        (isBoundary(lower, direct) ? 50 : 0),
      positions,
    };
  }
  const positions: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === " ") continue;
    let found = -1;
    // Prefer a word start for this character when one exists further on.
    for (
      let j = lower.indexOf(ch, from);
      j >= 0;
      j = lower.indexOf(ch, j + 1)
    ) {
      if (found < 0) found = j;
      if (j === previous + 1 || isBoundary(lower, j)) {
        found = j;
        break;
      }
      if (j - from > 40) break;
    }
    if (found < 0) return null;
    score += found === previous + 1 ? 12 : isBoundary(lower, found) ? 8 : 1;
    score -= Math.min(found - from, 10) * 0.2;
    positions.push(found);
    previous = found;
    from = found + 1;
  }
  return { score: score - lower.length * 0.05, positions };
}

/** Wraps matched characters in `<span class="suggestion-highlight">`. */
export function highlightMatch(
  text: string,
  positions: readonly number[],
  offset = 0,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const marks = new Set<number>();
  for (const position of positions) marks.add(position - offset);
  let run = "";
  let marked = false;
  const flush = () => {
    if (!run) return;
    if (marked) {
      const span = document.createElement("span");
      span.className = "suggestion-highlight";
      span.textContent = run;
      fragment.append(span);
    } else fragment.append(run);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const next = marks.has(i);
    if (next !== marked) {
      flush();
      marked = next;
    }
    run += text[i];
  }
  flush();
  return fragment;
}
