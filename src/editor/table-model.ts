export interface TableCellSource {
  from: number;
  to: number;
  text: string;
}
export interface TableSource {
  from: number;
  to: number;
  rows: TableCellSource[][];
  alignment: Array<"left" | "center" | "right" | null>;
}

function cells(line: string, offset: number): TableCellSource[] {
  const edges: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    // GFM splits columns before parsing code spans; only escapes hide a pipe.
    if (line[i] === "|") edges.push(i);
  }
  const first = line.search(/\S/);
  const last = line.trimEnd().length - 1;
  const starts = edges[0] === first ? edges.slice(1) : edges;
  const bounds = [
    edges[0] === first ? first + 1 : 0,
    ...starts.map((i) => i + 1),
  ];
  const ends = [...starts, line.length];
  if (edges.at(-1) === last) {
    bounds.pop();
    ends.pop();
  }
  return bounds.map((start, i) => {
    const raw = line.slice(start, ends[i]);
    const padding = /^\s*/.exec(raw)![0].length;
    const text = raw.trim();
    const from = offset + start + padding;
    return { from, to: from + text.length, text };
  });
}

/** Source slices, not a serializer: edits never rewrite neighboring cells. */
export function parseTableSource(
  source: string,
  offset = 0,
): TableSource | null {
  const lines = source.split(/\r?\n/);
  if (lines.length < 2) return null;
  let at = offset;
  const parsed = lines.map((line) => {
    const row = cells(line, at);
    at +=
      line.length +
      (source.slice(
        at - offset + line.length,
        at - offset + line.length + 2,
      ) === "\r\n"
        ? 2
        : 1);
    return row;
  });
  const width = parsed[0].length;
  if (
    !width ||
    parsed.some((row) => row.length !== width) ||
    parsed[1].some((cell) => !/^:?-+:?$/.test(cell.text))
  )
    return null;
  const alignment = parsed[1].map(({ text }) =>
    text.startsWith(":")
      ? text.endsWith(":")
        ? ("center" as const)
        : ("left" as const)
      : text.endsWith(":")
        ? ("right" as const)
        : null,
  );
  return {
    from: offset,
    to: offset + source.length,
    rows: [parsed[0], ...parsed.slice(2)],
    alignment,
  };
}

export function normalizeCellInput(value: string): string {
  return value
    .replace(/\r?\n|\r/g, " ")
    .replace(
      /(\\*)\|/g,
      (_match, slashes: string) =>
        `${slashes}${slashes.length % 2 ? "" : "\\"}|`,
    );
}
