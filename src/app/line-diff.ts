/** One line of a line-based diff from `before` to `after`. */
export interface DiffLine {
  type: "same" | "add" | "remove";
  text: string;
}

/** A run of unchanged lines left out of a collapsed diff. */
export interface DiffSkip {
  type: "skip";
  count: number;
}

/**
 * Shortest line diff (Myers). Returns `null` when the texts differ in more
 * than `maxEdits` lines, so huge rewrites cannot stall the UI; memory grows
 * with the square of the edit count, not with the file size.
 */
export function diffLines(
  before: string,
  after: string,
  maxEdits = 2000,
): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middle = middleDiff(
    a.slice(start, endA),
    b.slice(start, endB),
    maxEdits,
  );
  if (!middle) return null;
  const same = (text: string): DiffLine => ({ type: "same", text });
  return [
    ...a.slice(0, start).map(same),
    ...middle,
    ...a.slice(endA).map(same),
  ];
}

function middleDiff(
  a: string[],
  b: string[],
  maxEdits: number,
): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v for diagonals -d..d before step d.
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    if (d > maxEdits) return null;
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  const lines: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const row = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && row[k - 1 + d] < row[k + 1 + d]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = row[prevK + d];
    const prevY = prevX - prevK;
    // The snake of step d starts right after its single insertion or deletion.
    const startX = down ? prevX : prevX + 1;
    while (x > startX) {
      lines.push({ type: "same", text: a[--x] });
      y--;
    }
    if (down) lines.push({ type: "add", text: b[prevY] });
    else lines.push({ type: "remove", text: a[prevX] });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    lines.push({ type: "same", text: a[--x] });
    y--;
  }
  return lines.reverse();
}

/** Keeps `context` unchanged lines around each change and folds the rest. */
export function collapseDiff(
  lines: DiffLine[],
  context = 2,
): Array<DiffLine | DiffSkip> {
  const keep = new Uint8Array(lines.length);
  lines.forEach((line, index) => {
    if (line.type === "same") return;
    for (
      let i = Math.max(0, index - context);
      i <= Math.min(lines.length - 1, index + context);
      i++
    )
      keep[i] = 1;
  });
  const result: Array<DiffLine | DiffSkip> = [];
  for (let i = 0; i < lines.length;) {
    if (keep[i]) {
      result.push(lines[i++]);
      continue;
    }
    let count = 0;
    while (i < lines.length && !keep[i]) {
      count++;
      i++;
    }
    result.push({ type: "skip", count });
  }
  return result;
}
