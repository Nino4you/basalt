import { EditorSelection, type StateCommand } from "@codemirror/state";

/** Wraps the selection in `marker`, or unwraps it when it is already wrapped. */
export function toggleWrap(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const length = marker.length;
    const changes = state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - length, range.from);
      const after = state.sliceDoc(range.to, range.to + length);
      if (before === marker && after === marker)
        return {
          changes: [
            { from: range.from - length, to: range.from },
            { from: range.to, to: range.to + length },
          ],
          range: EditorSelection.range(range.from - length, range.to - length),
        };
      const inner = state.sliceDoc(range.from, range.to);
      if (
        inner.length >= length * 2 &&
        inner.startsWith(marker) &&
        inner.endsWith(marker)
      )
        return {
          changes: {
            from: range.from,
            to: range.to,
            insert: inner.slice(length, -length),
          },
          range: EditorSelection.range(range.from, range.to - length * 2),
        };
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.from + length, range.to + length),
      };
    });
    dispatch(
      state.update(changes, {
        scrollIntoView: true,
        userEvent: "input.format",
      }),
    );
    return true;
  };
}

export const insertLink: StateCommand = ({ state, dispatch }) => {
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const insert = `[${text}]()`;
    const cursor = range.from + (text ? insert.length - 1 : 1);
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(cursor),
    };
  });
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input" }));
  return true;
};

/** Cycles a line through plain text → `- [ ]` → `- [x]` → `- [ ]`. */
export const toggleTask: StateCommand = ({ state, dispatch }) => {
  const seen = new Set<number>();
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to;) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      if (seen.has(line.number)) continue;
      seen.add(line.number);
      const task = /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)\]/.exec(line.text);
      if (task) {
        const at = line.from + task[1].length;
        changes.push({
          from: at,
          to: at + 1,
          insert: task[2] === " " ? "x" : " ",
        });
        continue;
      }
      const item = /^(\s*(?:[-*+]|\d+[.)])\s+)/.exec(line.text);
      if (item) {
        const at = line.from + item[1].length;
        changes.push({ from: at, to: at, insert: "[ ] " });
        continue;
      }
      const indent = /^\s*/.exec(line.text)![0].length;
      changes.push({
        from: line.from + indent,
        to: line.from + indent,
        insert: "- [ ] ",
      });
    }
  }
  if (!changes.length) return false;
  dispatch(state.update({ changes, userEvent: "input.format" }));
  return true;
};

/** Wraps the selection in `[[…]]`; the typed bracket pair opens link completion. */
export const insertWikiLink: StateCommand = ({ state, dispatch }) => {
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    return {
      changes: { from: range.from, to: range.to, insert: `[[${text}]]` },
      range: text
        ? EditorSelection.range(range.from + 2, range.to + 2)
        : EditorSelection.cursor(range.from + 2),
    };
  });
  dispatch(
    state.update(changes, { scrollIntoView: true, userEvent: "input.type" }),
  );
  return true;
};

const LIST_MARK = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/;

/** Turns lines into `- ` bullets, or removes the list marker when every line has one. */
export const toggleBulletList: StateCommand = ({ state, dispatch }) => {
  const lines = new Map<number, { from: number; text: string }>();
  for (const range of state.selection.ranges)
    for (let pos = range.from; pos <= range.to;) {
      const line = state.doc.lineAt(pos);
      lines.set(line.number, line);
      pos = line.to + 1;
    }
  const all = [...lines.values()];
  const remove = all.every((line) => LIST_MARK.test(line.text));
  const changes = all.map((line) => {
    if (remove) {
      const mark = LIST_MARK.exec(line.text)!;
      return {
        from: line.from + mark[1].length,
        to: line.from + mark[0].length,
        insert: "",
      };
    }
    const indent = /^\s*/.exec(line.text)![0].length;
    return LIST_MARK.test(line.text)
      ? { from: line.from, to: line.from, insert: "" }
      : { from: line.from + indent, to: line.from + indent, insert: "- " };
  });
  dispatch(state.update({ changes, userEvent: "input.format" }));
  return true;
};
