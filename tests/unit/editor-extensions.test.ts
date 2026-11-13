import {
  Compartment,
  EditorState,
  Facet,
  type Extension,
} from "@codemirror/state";
import { expect, it } from "vitest";
import { EditorExtensionRegistry } from "../../src/compat/editor-extensions";

it("installs and removes independently owned extensions in the shared CodeMirror state", () => {
  const values = Facet.define<string, readonly string[]>({
    combine: (input) => input,
  });
  const compartment = new Compartment();
  let state = EditorState.create({ extensions: [compartment.of([])] });
  const registry = new EditorExtensionRegistry((extensions) => {
    state = state.update({
      effects: compartment.reconfigure(extensions),
    }).state;
  });
  const first = registry.register(values.of("first"));
  const mutable: Extension[] = [values.of("second")];
  const second = registry.register(mutable);
  expect(state.facet(values)).toEqual(["first", "second"]);
  mutable.splice(0, 1, values.of("rebound"));
  registry.refresh();
  expect(state.facet(values)).toEqual(["first", "rebound"]);
  first();
  first();
  expect(state.facet(values)).toEqual(["rebound"]);
  second();
  expect(state.facet(values)).toEqual([]);
});

it("does not retain extensions rejected by CodeMirror", () => {
  let registered: Extension[] = [];
  const registry = new EditorExtensionRegistry((extensions) => {
    if (extensions.some((extension) => extension === invalid))
      throw new Error("Invalid extension");
    registered = extensions;
  });
  const invalid = {} as Extension;
  expect(() => registry.register(invalid)).toThrow("Invalid extension");
  registry.refresh();
  expect(registered).toEqual([]);
});
