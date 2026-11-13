import {
  ChangeSet,
  EditorSelection,
  Transaction,
  type EditorState,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, type Command } from "@codemirror/view";
import {
  cursorCharLeft,
  cursorCharRight,
  cursorGroupLeft,
  cursorGroupRight,
  cursorLineDown,
  cursorLineEnd,
  cursorLineStart,
  cursorLineUp,
  deleteLine,
  indentLess,
  indentMore,
  insertNewlineAndIndent,
  moveLineDown,
  moveLineUp,
  undo,
  redo,
} from "@codemirror/commands";
import { foldAll, toggleFold, unfoldAll } from "@codemirror/language";

export interface EditorPosition {
  line: number;
  ch: number;
}
export interface EditorSelectionRange {
  anchor: EditorPosition;
  head: EditorPosition;
}
export interface EditorRange {
  from: EditorPosition;
  to: EditorPosition;
}
export interface EditorChange {
  from: EditorPosition;
  to?: EditorPosition;
  text: string;
}
export interface EditorTransaction {
  changes?: EditorChange[];
  selection?: EditorSelectionRange;
  selections?: EditorSelectionRange[];
  origin?: string;
}
export type EditorCommandName =
  | "goUp"
  | "goDown"
  | "goLeft"
  | "goRight"
  | "goStart"
  | "goEnd"
  | "goWordLeft"
  | "goWordRight"
  | "indentMore"
  | "indentLess"
  | "newlineAndIndent"
  | "swapLineUp"
  | "swapLineDown"
  | "deleteLine"
  | "toggleFold"
  | "foldAll"
  | "unfoldAll";

/** Minimal structural view contract; the host passes its original, shared CodeMirror EditorView. */
export interface EditorViewPort {
  readonly state: EditorState;
  readonly hasFocus: boolean;
  readonly scrollDOM: HTMLElement;
  readonly contentDOM?: HTMLElement;
  dispatch(spec: TransactionSpec): void;
  focus(): void;
  requestMeasure(): void;
}

function integer(value: number): number {
  if (!Number.isFinite(value))
    throw new RangeError("Editor positions must be finite");
  return Math.trunc(value);
}
function offset(doc: Text, position: EditorPosition): number {
  const line = doc.line(
    Math.max(0, Math.min(doc.lines - 1, integer(position.line))) + 1,
  );
  return line.from + Math.max(0, Math.min(line.length, integer(position.ch)));
}
function position(doc: Text, value: number): EditorPosition {
  const at = Math.max(0, Math.min(doc.length, integer(value)));
  const line = doc.lineAt(at);
  return { line: line.number - 1, ch: at - line.from };
}

/** Text/selection bridge. No filesystem access and no replacement CodeMirror instance. */
export class Editor {
  constructor(readonly cm: EditorViewPort) {}

  getValue(): string {
    return this.cm.state.sliceDoc();
  }
  setValue(text: string): void {
    this.cm.dispatch({
      changes: { from: 0, to: this.cm.state.doc.length, insert: text },
    });
  }
  lineCount(): number {
    return this.cm.state.doc.lines;
  }
  firstLine(): number {
    return 0;
  }
  lastLine(): number {
    return this.lineCount() - 1;
  }
  getLine(line: number): string {
    if (!Number.isInteger(line) || line < 0 || line >= this.lineCount())
      throw new RangeError("Editor line is out of range");
    return this.cm.state.doc.line(line + 1).text;
  }
  posToOffset(at: EditorPosition): number {
    return offset(this.cm.state.doc, at);
  }
  offsetToPos(at: number): EditorPosition {
    return position(this.cm.state.doc, at);
  }
  getDoc(): string {
    return this.cm.state.doc.toString();
  }
  setLine(line: number, text: string): void {
    if (!Number.isInteger(line) || line < 0 || line >= this.lineCount())
      throw new RangeError("Editor line is out of range");
    const target = this.cm.state.doc.line(line + 1);
    this.cm.dispatch({
      changes: { from: target.from, to: target.to, insert: text },
    });
  }
  wordAt(at: EditorPosition): EditorRange | null {
    const text = this.getLine(at.line);
    const ch = Math.max(0, Math.min(text.length, integer(at.ch)));
    const word = (index: number) =>
      index >= 0 && index < text.length && /[\p{L}\p{N}_]/u.test(text[index]);
    if (!word(ch) && !word(ch - 1)) return null;
    let from = word(ch) ? ch : ch - 1;
    let to = from + 1;
    while (word(from - 1)) from--;
    while (word(to)) to++;
    return { from: { line: at.line, ch: from }, to: { line: at.line, ch: to } };
  }
  blur(): void {
    this.cm.contentDOM?.blur();
  }

  getCursor(which: "from" | "to" | "head" | "anchor" = "head"): EditorPosition {
    return this.offsetToPos(this.cm.state.selection.main[which]);
  }
  setCursor(at: EditorPosition | number, ch = 0): void {
    const point = typeof at === "number" ? { line: at, ch } : at;
    this.cm.dispatch({
      selection: { anchor: this.posToOffset(point) },
      scrollIntoView: true,
    });
  }
  getSelection(): string {
    const range = this.cm.state.selection.main;
    return this.cm.state.sliceDoc(range.from, range.to);
  }
  somethingSelected(): boolean {
    return this.cm.state.selection.ranges.some((range) => !range.empty);
  }
  listSelections(): EditorSelectionRange[] {
    return this.cm.state.selection.ranges.map((range) => ({
      anchor: this.offsetToPos(range.anchor),
      head: this.offsetToPos(range.head),
    }));
  }
  setSelection(anchor: EditorPosition, head = anchor): void {
    this.setSelections([{ anchor, head }]);
  }
  setSelections(ranges: EditorSelectionRange[], mainIndex = 0): void {
    if (
      !ranges.length ||
      !Number.isInteger(mainIndex) ||
      mainIndex < 0 ||
      mainIndex >= ranges.length
    )
      throw new RangeError("Invalid editor selection set");
    this.cm.dispatch({
      selection: EditorSelection.create(
        ranges.map((range) =>
          EditorSelection.range(
            this.posToOffset(range.anchor),
            this.posToOffset(range.head),
          ),
        ),
        mainIndex,
      ),
      scrollIntoView: true,
    });
  }
  getRange(from: EditorPosition, to: EditorPosition): string {
    const start = this.posToOffset(from),
      end = this.posToOffset(to);
    return this.cm.state.sliceDoc(Math.min(start, end), Math.max(start, end));
  }
  replaceRange(
    text: string,
    from: EditorPosition,
    to = from,
    origin?: string,
  ): void {
    this.transaction({ changes: [{ from, to, text }], origin });
  }
  replaceSelection(text: string, origin?: string): void {
    this.cm.dispatch({
      ...this.cm.state.replaceSelection(text),
      annotations: origin ? Transaction.userEvent.of(origin) : undefined,
    });
  }

  transaction(spec: EditorTransaction): void {
    const changes = (spec.changes ?? []).map((change) => {
      const from = this.posToOffset(change.from),
        to = this.posToOffset(change.to ?? change.from);
      return {
        from: Math.min(from, to),
        to: Math.max(from, to),
        insert: change.text,
      };
    });
    const changeSet = ChangeSet.of(
      changes,
      this.cm.state.doc.length,
      this.cm.state.lineBreak,
    );
    const changedDoc = changeSet.apply(this.cm.state.doc);
    const requested =
      spec.selections ?? (spec.selection ? [spec.selection] : undefined);
    if (requested && !requested.length)
      throw new RangeError(
        "An editor transaction needs at least one selection",
      );
    const selection = requested
      ? EditorSelection.create(
          requested.map((range) =>
            EditorSelection.range(
              offset(changedDoc, range.anchor),
              offset(changedDoc, range.head),
            ),
          ),
        )
      : undefined;
    this.cm.dispatch({
      changes: changeSet,
      selection,
      annotations: spec.origin
        ? Transaction.userEvent.of(spec.origin)
        : undefined,
    });
  }

  focus(): void {
    this.cm.focus();
  }
  hasFocus(): boolean {
    return this.cm.hasFocus;
  }
  refresh(): void {
    this.cm.requestMeasure();
  }
  undo(): void {
    undo(this.cm);
  }
  redo(): void {
    redo(this.cm);
  }
  exec(command: EditorCommandName): void {
    const commands: Record<EditorCommandName, Command> = {
      goUp: cursorLineUp,
      goDown: cursorLineDown,
      goLeft: cursorCharLeft,
      goRight: cursorCharRight,
      goStart: cursorLineStart,
      goEnd: cursorLineEnd,
      goWordLeft: cursorGroupLeft,
      goWordRight: cursorGroupRight,
      indentMore,
      indentLess,
      newlineAndIndent: insertNewlineAndIndent,
      swapLineUp: moveLineUp,
      swapLineDown: moveLineDown,
      deleteLine,
      toggleFold,
      foldAll,
      unfoldAll,
    };
    const run = commands[command];
    if (!run) throw new RangeError(`Unsupported editor command: ${command}`);
    run(this.cm as unknown as EditorView);
  }
  getScrollInfo() {
    const element = this.cm.scrollDOM;
    return {
      top: element.scrollTop,
      left: element.scrollLeft,
      height: element.scrollHeight,
      width: element.scrollWidth,
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
    };
  }
  scrollTo(x: number | null, y: number | null): void {
    if (x !== null) this.cm.scrollDOM.scrollLeft = x;
    if (y !== null) this.cm.scrollDOM.scrollTop = y;
  }
  scrollIntoView(
    range: { from: EditorPosition; to: EditorPosition },
    center = false,
  ): void {
    this.cm.dispatch({
      effects: EditorView.scrollIntoView(
        EditorSelection.range(
          this.posToOffset(range.from),
          this.posToOffset(range.to),
        ),
        { y: center ? "center" : "nearest" },
      ),
    });
  }
}
