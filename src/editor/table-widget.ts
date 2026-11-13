import { t } from "../i18n";
import { isolateHistory, undo, undoDepth, redo } from "@codemirror/commands";
import { EditorView, WidgetType } from "@codemirror/view";
import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { renderMarkdown } from "../markdown";
import { enhanceMath } from "../app/rich-content";
import { normalizeCellInput, type TableSource } from "./table-model";
import { mathSpans } from "./math-source";

const controllers = new WeakMap<HTMLElement, TableController>();
/** Line starts that can open a block (list, quote, heading, fence, HTML, math). */
const BLOCK_START = /^(?:[-+*>#<`~=_]|\$\$|\d{1,9}[.)])/;
function canEdit(state: EditorState): boolean {
  return !state.readOnly && state.facet(EditorView.editable);
}
interface EditingCell {
  tableFrom: number;
  tableTo: number;
  row: number;
  col: number;
  from: number;
  to: number;
}
const editCell = StateEffect.define<EditingCell | null>();
export const tableCellEditing = StateField.define<EditingCell | null>({
  create: () => null,
  update(value, tr) {
    if (value && tr.docChanged) {
      let replaced = false;
      tr.changes.iterChangedRanges((from, to) => {
        if (from <= value!.tableFrom && to >= value!.tableTo && from < to)
          replaced = true;
      });
      value = replaced
        ? null
        : {
            ...value,
            tableFrom: tr.changes.mapPos(
              value.tableFrom,
              tr.isUserEvent("input.type") && value.from === value.tableFrom
                ? -1
                : 1,
            ),
            tableTo: tr.changes.mapPos(value.tableTo, 1),
            from: tr.changes.mapPos(
              value.from,
              tr.isUserEvent("input.type") ? -1 : 1,
            ),
            to: tr.changes.mapPos(value.to, 1),
          };
    }
    for (const effect of tr.effects)
      if (effect.is(editCell)) value = effect.value;
    return canEdit(tr.state) ? value : null;
  },
});

class TableController {
  private cells: HTMLTableCellElement[][] = [];
  private input: HTMLInputElement | null = null;
  private active: { row: number; col: number } | null = null;
  private composing = false;
  private alive = true;
  /** Undo depth after this cell session's last commit; null before the first. */
  private sessionDepth: number | null = null;
  constructor(
    readonly root: HTMLElement,
    private view: EditorView,
    private model: TableSource,
  ) {
    const table = document.createElement("table");
    table.className = "cm-live-table";
    root.append(table);
    for (let row = 0; row < model.rows.length; row++) {
      const group =
        row === 0
          ? document.createElement("thead")
          : row === 1
            ? document.createElement("tbody")
            : table.tBodies[0];
      if (row < 2) table.append(group);
      const tr = document.createElement("tr");
      group.append(tr);
      this.cells.push(
        model.rows[row].map((_source, col) => {
          const cell = document.createElement(row === 0 ? "th" : "td");
          cell.tabIndex = 0;
          cell.setAttribute(
            "aria-label",
            t("Tabellenzelle {row}, {column}", { row: row + 1, column: col + 1 }),
          );
          if (model.alignment[col])
            cell.style.textAlign = model.alignment[col]!;
          cell.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.edit(row, col);
          });
          cell.addEventListener("keydown", (event) => {
            if (event.target !== cell) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              this.edit(row, col);
            }
          });
          tr.append(cell);
          this.paint(cell, row, col);
          return cell;
        }),
      );
    }
  }
  private paint(cell: HTMLElement, row: number, col: number): void {
    const source = this.model.rows[row][col].text;
    // Carry source-approved math through Markdown without rescanning escaped text.
    const spans = mathSpans(source);
    const formulas: HTMLElement[] = [];
    const prefix = `BASALTMATH${crypto.randomUUID().replaceAll("-", "")}Q`;
    let markdown = source;
    for (let i = spans.length - 1; i >= 0; i--)
      markdown =
        markdown.slice(0, spans[i].from) +
        `${prefix}${i}END` +
        markdown.slice(spans[i].to);
    cell.innerHTML = renderMarkdown(markdown);
    if (spans.length) {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      const pattern = new RegExp(`${prefix}(\\d+)END`, "g");
      for (const node of nodes) {
        const text = node.textContent ?? "";
        const fragment = document.createDocumentFragment();
        let last = 0;
        for (const match of text.matchAll(pattern)) {
          fragment.append(text.slice(last, match.index));
          const formula = document.createElement("span");
          formula.textContent = spans[Number(match[1])].source;
          fragment.append(formula);
          formulas.push(formula);
          last = match.index + match[0].length;
        }
        if (last) {
          fragment.append(text.slice(last));
          node.replaceWith(fragment);
        }
      }
    }
    for (const formula of formulas)
      enhanceMath(
        formula,
        () =>
          this.alive &&
          formula.isConnected &&
          cell.isConnected &&
          this.model.rows[row]?.[col]?.text === source &&
          !cell.contains(this.input),
        () => this.view.requestMeasure(),
      );
  }
  update(model: TableSource): boolean {
    if (
      model.rows.length !== this.cells.length ||
      model.rows.some((r, i) => r.length !== this.cells[i].length)
    )
      return false;
    const old = this.model;
    this.model = model;
    const editing = this.view.state.field(tableCellEditing, false);
    if (!editing || editing.tableFrom !== model.from) {
      this.active = null;
      this.input = null;
    }
    for (let row = 0; row < model.rows.length; row++)
      for (let col = 0; col < model.rows[row].length; col++) {
        this.cells[row][col].style.textAlign = model.alignment[col] ?? "";
        if (this.active?.row === row && this.active.col === col && this.input) {
          const value = this.view.state.sliceDoc(editing!.from, editing!.to);
          if (!this.composing && this.input.value !== value) {
            const caret = this.input.selectionStart ?? value.length;
            this.input.value = value;
            this.input.setSelectionRange(
              Math.min(caret, value.length),
              Math.min(caret, value.length),
            );
          }
        } else if (
          old.rows[row][col].text !== model.rows[row][col].text ||
          this.cells[row][col].querySelector("input")
        )
          this.paint(this.cells[row][col], row, col);
      }
    return true;
  }
  private commit(): void {
    if (!this.alive || !this.input || !this.active || !canEdit(this.view.state))
      return;
    const cell = this.view.state.field(tableCellEditing, false);
    if (!cell || cell.tableFrom !== this.model.from) return;
    if (this.view.state.sliceDoc(cell.from, cell.to) === this.input.value)
      return;
    const text = normalizeCellInput(this.input.value);
    const line = this.view.state.doc.lineAt(cell.from);
    // Empty edge cells need an outer pipe or GFM reinterprets their separator;
    // a first cell starting with block syntax would otherwise end the table.
    const prefix =
      cell.col === 0 &&
      (!text.trim() || BLOCK_START.test(text.trimStart())) &&
      !this.view.state.sliceDoc(line.from, cell.from).trim()
        ? "| "
        : "";
    const suffix =
      cell.col === this.cells[cell.row].length - 1 &&
      !text.trim() &&
      !this.view.state.sliceDoc(cell.to, line.to).trim()
        ? " |"
        : "";
    // Only delimiter adjacency needs protection; never change the user's TeX.
    const padding =
      (text.match(/\\+$/)?.[0].length ?? 0) % 2 &&
      this.view.state.sliceDoc(cell.to, cell.to + 1) === "|"
        ? " "
        : "";
    // Map the editing range through transactions, including newly typed padding.
    this.view.dispatch({
      changes: {
        from: cell.from,
        to: cell.to,
        insert: prefix + text + padding + suffix,
      },
      effects: editCell.of({
        ...cell,
        from: cell.from + prefix.length,
        to: cell.from + prefix.length + text.length,
        tableTo:
          cell.tableTo +
          prefix.length +
          text.length +
          padding.length -
          (cell.to - cell.from) +
          suffix.length,
      }),
      // One cell edit is one undo step, however long the pauses in between:
      // compose input always joins the previous history event. Only join our
      // own unchanged event, never one restored by an undo in between.
      userEvent:
        this.sessionDepth !== null &&
        undoDepth(this.view.state) === this.sessionDepth
          ? "input.type.compose"
          : "input.type",
    });
    this.sessionDepth = undoDepth(this.view.state);
  }
  private edit(row: number, col: number): void {
    if (!this.alive || !canEdit(this.view.state)) return;
    if (this.active?.row === row && this.active.col === col) {
      this.input?.focus();
      return;
    }
    this.finish(false);
    this.sessionDepth = null;
    this.active = { row, col };
    const cell = this.cells[row][col];
    const input = document.createElement("input");
    input.className = "cm-table-cell-input";
    input.setAttribute("aria-label", t("Tabellenzelle {row}, {column}", { row: row + 1, column: col + 1 }));
    input.value = this.model.rows[row][col].text;
    this.input = input;
    cell.replaceChildren(input);
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("input", () => this.commit());
    input.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    input.addEventListener("compositionend", () => {
      this.composing = false;
      this.commit();
    });
    input.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      event.preventDefault();
      input.setRangeText(
        normalizeCellInput(text),
        input.selectionStart ?? 0,
        input.selectionEnd ?? 0,
        "end",
      );
      this.commit();
    });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.isComposing || this.composing) return;
      if (
        (event.ctrlKey || event.metaKey) &&
        ["z", "y"].includes(event.key.toLowerCase())
      ) {
        event.preventDefault();
        (event.shiftKey || event.key.toLowerCase() === "y" ? redo : undo)(
          this.view,
        );
        input.focus();
      } else if (event.key === "Tab") {
        event.preventDefault();
        const width = this.cells[0].length;
        const next = row * width + col + (event.shiftKey ? -1 : 1);
        if (next >= 0 && next < this.cells.length * width)
          this.edit(Math.floor(next / width), next % width);
        else this.finish(true, event.shiftKey);
      } else if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        this.finish(true);
      }
    });
    input.addEventListener("blur", () => {
      if (this.input === input) this.finish(false);
    });
    this.view.dispatch({
      effects: editCell.of({
        tableFrom: this.model.from,
        tableTo: this.model.to,
        row,
        col,
        ...this.model.rows[row][col],
      }),
      annotations: isolateHistory.of("before"),
    });
    input.focus();
    input.select();
    this.view.requestMeasure();
  }
  private finish(focus: boolean, before = false): void {
    if (!this.active || !this.input) return;
    this.composing = false;
    this.commit();
    const { row, col } = this.active;
    this.active = null;
    this.input = null;
    this.view.dispatch({ effects: editCell.of(null) });
    this.paint(this.cells[row][col], row, col);
    if (focus) {
      const anchor = before
        ? Math.max(0, this.model.from - 1)
        : Math.min(this.view.state.doc.length, this.model.to + 1);
      this.view.dispatch({
        selection: { anchor },
        annotations: isolateHistory.of("after"),
      });
      this.view.focus();
    }
    this.view.requestMeasure();
  }
  destroy(): void {
    this.alive = false;
    this.input = null;
    this.active = null;
  }
}

export class TableWidget extends WidgetType {
  constructor(readonly model: TableSource) {
    super();
  }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("div");
    root.className = "cm-table-preview markdown-rendered";
    controllers.set(root, new TableController(root, view, this.model));
    return root;
  }
  updateDOM(dom: HTMLElement): boolean {
    return controllers.get(dom)?.update(this.model) ?? false;
  }
  destroy(dom: HTMLElement): void {
    controllers.get(dom)?.destroy();
    controllers.delete(dom);
  }
  ignoreEvent(): boolean {
    return true;
  }
}
