import { t } from "../i18n";
import { indentLess, indentMore, redo, undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import {
  insertWikiLink,
  toggleBulletList,
  toggleTask,
  toggleWrap,
} from "../editor/commands";
import { h, icon } from "../ui/dom";

type Action = (view: EditorView) => boolean;

const ACTIONS: Array<[icon: string, label: string, run: Action]> = [
  ["undo-2", t("Rückgängig"), undo],
  ["redo-2", t("Wiederholen"), redo],
  ["indent-decrease", t("Ausrücken"), indentLess],
  ["indent-increase", t("Einrücken"), indentMore],
  ["list-checks", t("Aufgabe umschalten"), toggleTask],
  ["list", t("Liste umschalten"), toggleBulletList],
  ["bold", t("Fett"), toggleWrap("**")],
  ["italic", t("Kursiv"), toggleWrap("*")],
  ["brackets", t("Interner Link"), insertWikiLink],
];

/**
 * Formatting bar for touch editing, shown in place of the navigation bar while
 * the editor has focus. Without a hardware keyboard there is no other way to
 * undo, indent or toggle list items.
 */
export function buildMobileToolbar(view: () => EditorView | null): HTMLElement {
  const run = (action: Action) => {
    const editor = view();
    if (!editor) return;
    action(editor);
    editor.focus();
  };
  const button = (id: string, label: string, onPress: () => void) => {
    const el = h(
      "button",
      { class: "clickable-icon", label, attrs: { type: "button" } },
      icon(id),
    );
    // Keep the editor focused so the on-screen keyboard stays open.
    el.addEventListener("pointerdown", (event) => event.preventDefault());
    el.addEventListener("mousedown", (event) => event.preventDefault());
    el.addEventListener("click", onPress);
    return el;
  };
  return h(
    "div",
    {
      class: "mobile-toolbar",
      attrs: { role: "toolbar", "aria-label": t("Bearbeiten") },
    },
    h(
      "div",
      "mobile-toolbar-actions",
      ...ACTIONS.map(([id, label, action]) =>
        button(id, label, () => run(action)),
      ),
    ),
    button("keyboard-off", t("Tastatur ausblenden"), () =>
      view()?.contentDOM.blur(),
    ),
  );
}
