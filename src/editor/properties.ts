import { t } from "../i18n";
import {
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { h, icon } from "../ui/dom";
import { renderedFacet } from "./live-preview";
import {
  frontmatterRange,
  Properties,
  replaceFrontmatter,
  type PropertyEntry,
  type PropertyType,
} from "./properties-model";

/** Whether live preview shows frontmatter as editable properties. */
export const propertiesFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? true,
});

/**
 * Asks the properties view to open a new, focused property row. Ids grow
 * across all tabs' states, so a view opens each request once.
 */
export const addPropertyEffect = StateEffect.define<number>();
let requests = 0;
let shown = 0;

/** Applies `edit` to the note's properties as one narrow source change. */
function commit(
  view: EditorView,
  edit: (properties: Properties) => boolean | void,
) {
  const text = view.state.doc.toString();
  const range = frontmatterRange(text);
  const properties = Properties.parse(
    range ? text.slice(range.yamlFrom, range.yamlTo) : "",
  );
  if (!properties || edit(properties) === false) return false;
  const change = replaceFrontmatter(text, properties.toString());
  if (
    change.insert === view.state.sliceDoc(change.from, change.to) ||
    (change.from === change.to && !change.insert)
  )
    return true;
  view.dispatch({ changes: change, userEvent: "input.properties" });
  return true;
}

const TYPE_ICONS: Record<PropertyType, string> = {
  text: "text",
  list: "list",
  number: "binary",
  checkbox: "square-check",
  date: "calendar",
  datetime: "clock",
  complex: "braces",
};

class PropertiesWidget extends WidgetType {
  constructor(
    readonly yaml: string,
    /** Bumped by `addPropertyEffect`; a new value opens a new row. */
    readonly request: number,
  ) {
    super();
  }

  eq(other: PropertiesWidget): boolean {
    return other.yaml === this.yaml && other.request === this.request;
  }

  toDOM(view: EditorView): HTMLElement {
    const properties = Properties.parse(this.yaml);
    const entries = properties?.entries() ?? [];
    const list = h("div", "metadata-properties");
    const root = h(
      "div",
      {
        class: "metadata-container cm-properties",
        attrs: { "data-property-count": entries.length },
      },
      h("div", {
        class: "metadata-properties-heading",
        text: t("Eigenschaften"),
      }),
      list,
    );
    for (const entry of entries) list.append(this.row(view, entry));
    const add = h(
      "button",
      {
        class: "metadata-add-button",
        attrs: { type: "button" },
        on: { click: () => this.newRow(view, list, add) },
      },
      icon("plus", 14),
      t("Eigenschaft hinzufügen"),
    );
    root.append(add);
    if (this.request > shown) {
      shown = this.request;
      requestAnimationFrame(() => {
        if (root.isConnected) this.newRow(view, list, add);
      });
    }
    return root;
  }

  /** A row whose name is still being typed; it is written once named. */
  private newRow(view: EditorView, list: HTMLElement, add: HTMLElement) {
    const key = h("input", {
      class: "metadata-property-key-input",
      label: t("Name der Eigenschaft"),
      attrs: { type: "text", placeholder: t("Name"), spellcheck: "false" },
    });
    const row = h(
      "div",
      "metadata-property is-new",
      h("div", "metadata-property-key", key),
      h("div", "metadata-property-value"),
    );
    list.append(row);
    add.hidden = true;
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      if (!save || !commit(view, (properties) => properties.add(key.value))) {
        row.remove();
        add.hidden = false;
      }
    };
    key.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
        view.focus();
      }
    });
    key.addEventListener("blur", () => finish(true));
    key.focus();
  }

  private row(view: EditorView, entry: PropertyEntry): HTMLElement {
    const key = h("input", {
      class: "metadata-property-key-input",
      label: t("Name der Eigenschaft"),
      attrs: { type: "text", spellcheck: "false" },
    });
    key.value = entry.key;
    key.addEventListener("change", () => {
      if (
        !commit(view, (properties) => properties.rename(entry.key, key.value))
      )
        key.value = entry.key;
    });
    enterCommits(key);
    const set = (value: PropertyEntry["value"]) =>
      commit(view, (properties) =>
        properties.set(entry.key, value, entry.type),
      );
    return h(
      "div",
      {
        class: "metadata-property",
        data: { propertyKey: entry.key, propertyType: entry.type },
      },
      h(
        "div",
        "metadata-property-key",
        h("span", "metadata-property-icon", icon(TYPE_ICONS[entry.type], 14)),
        key,
      ),
      h("div", "metadata-property-value", valueEditor(view, entry, set)),
      h(
        "button",
        {
          class: "clickable-icon metadata-property-remove",
          label: t("Eigenschaft „{name}“ entfernen", { name: entry.key }),
          attrs: { type: "button" },
          on: {
            click: () => {
              commit(view, (properties) => properties.remove(entry.key));
              view.focus();
            },
          },
        },
        icon("x", 14),
      ),
    );
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function enterCommits(input: HTMLInputElement): void {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
  });
}

function valueEditor(
  view: EditorView,
  entry: PropertyEntry,
  set: (value: PropertyEntry["value"]) => void,
): HTMLElement {
  const label = t("Wert von „{name}“", { name: entry.key });
  switch (entry.type) {
    case "checkbox": {
      const box = h("input", {
        class: "metadata-input-checkbox",
        label,
        attrs: { type: "checkbox" },
      });
      box.checked = entry.value as boolean;
      box.addEventListener("change", () => set(box.checked));
      return box;
    }
    case "list": {
      const values = entry.value as string[];
      const input = h("input", {
        class: "multi-select-input",
        label,
        attrs: {
          type: "text",
          placeholder: t("Hinzufügen …"),
          spellcheck: "false",
        },
      });
      const add = () => {
        const value = input.value.trim().replace(/^#/, "");
        if (value) set([...values, value]);
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === ",") {
          event.preventDefault();
          add();
        } else if (event.key === "Backspace" && !input.value && values.length)
          set(values.slice(0, -1));
      });
      input.addEventListener("blur", add);
      return h(
        "div",
        "multi-select-container",
        ...values.map((value, index) =>
          h(
            "span",
            "multi-select-pill",
            h("span", { class: "multi-select-pill-content", text: value }),
            h(
              "button",
              {
                class: "multi-select-pill-remove-button",
                label: t("„{name}“ entfernen", { name: value }),
                attrs: { type: "button" },
                on: {
                  click: () => set(values.filter((_, i) => i !== index)),
                },
              },
              icon("x", 12),
            ),
          ),
        ),
        input,
      );
    }
    case "complex": {
      return h(
        "button",
        {
          class: "metadata-property-complex",
          attrs: { type: "button" },
          title: t("Im Quelltext bearbeiten"),
          on: {
            click: () => {
              const range = frontmatterRange(view.state.doc.toString());
              if (range)
                view.dispatch({ selection: { anchor: range.yamlFrom } });
              view.focus();
            },
          },
        },
        (entry.value as string).trim() || "…",
      );
    }
    default: {
      const input = h("input", {
        class: "metadata-input",
        label,
        attrs: {
          type:
            entry.type === "date"
              ? "date"
              : entry.type === "datetime"
                ? "datetime-local"
                : entry.type === "number"
                  ? "number"
                  : "text",
          spellcheck: entry.type === "text" ? "true" : "false",
          step: entry.type === "number" ? "any" : null,
          placeholder: entry.type === "text" ? t("Kein Wert") : null,
        },
      });
      input.value = entry.value as string;
      input.addEventListener("change", () => set(input.value));
      enterCommits(input);
      return input;
    }
  }
}

interface PropertiesState {
  request: number;
  decorations: DecorationSet;
}

/**
 * The cursor inside the block (after its first character, so a note that
 * just opened at offset 0 still shows fields) reveals the YAML source.
 */
function decorations(state: EditorState, request: number): DecorationSet {
  if (!state.facet(renderedFacet) || !state.facet(propertiesFacet))
    return Decoration.none;
  const range = frontmatterRange(state.sliceDoc(0, 64 * 1024));
  if (!range) return Decoration.none;
  const yaml = state.sliceDoc(range.yamlFrom, range.yamlTo);
  if (!Properties.parse(yaml)) return Decoration.none;
  if (
    state.selection.ranges.some(
      (selection) => selection.to > range.from && selection.from <= range.to,
    )
  )
    return Decoration.none;
  return Decoration.set([
    Decoration.replace({
      widget: new PropertiesWidget(yaml, request),
      block: true,
    }).range(range.from, range.to),
  ]);
}

const propertiesState = StateField.define<PropertiesState>({
  create: (state) => ({ request: 0, decorations: decorations(state, 0) }),
  update(value, tr) {
    let request = value.request;
    for (const effect of tr.effects)
      if (effect.is(addPropertyEffect)) request = effect.value;
    if (
      request === value.request &&
      !tr.docChanged &&
      !tr.selection &&
      !tr.reconfigured
    )
      return value;
    return { request, decorations: decorations(tr.state, request) };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});

/**
 * "Add file property": creates the frontmatter block if needed and opens a
 * new row for the name. Shows the source instead when fields are off.
 */
export function addProperty(view: EditorView): boolean {
  if (!view.state.facet(EditorView.editable)) return false;
  const text = view.state.doc.toString();
  const range = frontmatterRange(text);
  const fields =
    view.state.facet(renderedFacet) && view.state.facet(propertiesFacet);
  if (range && !Properties.parse(text.slice(range.yamlFrom, range.yamlTo))) {
    view.dispatch({ selection: { anchor: range.yamlFrom } });
    return true;
  }
  const block = fields ? "---\n---\n" : "---\n\n---\n";
  const changes = range ? [] : [{ from: 0, insert: block }];
  const length = view.state.doc.length + (range ? 0 : block.length);
  view.dispatch({
    changes,
    // Fields: keep the cursor out of the block so they stay visible.
    // Source: put it where the next line of YAML goes.
    selection: fields
      ? { anchor: range ? Math.min(range.to + 1, length) : block.length }
      : { anchor: range ? range.yamlTo : 4 },
    effects: fields ? addPropertyEffect.of(++requests) : [],
  });
  if (!fields) view.focus();
  return true;
}

export const propertiesEditor: Extension = [
  propertiesState,
  EditorView.atomicRanges.of(
    (view) => view.state.field(propertiesState).decorations,
  ),
];
