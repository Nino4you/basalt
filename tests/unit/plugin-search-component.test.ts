import { describe, expect, it, vi } from "vitest";
import { BaseComponent, createObsidianApi } from "../../src/compat/obsidian-api";

describe("plugin search inputs", () => {
  it("renders a real search input and clears it with one change notification", () => {
    const api = createObsidianApi({ app: {} });
    expect(api.SearchComponent).toBeTypeOf("function");
    const Search = api.SearchComponent as typeof import("../../src/compat/obsidian-api").SearchComponent;
    const root = document.createElement("div");
    const search = new Search(root);
    const changed = vi.fn();
    expect(search).toBeInstanceOf(BaseComponent);
    expect(root.contains(search.inputEl)).toBe(true);
    expect(root.contains(search.clearButtonEl)).toBe(true);
    expect(search.inputEl.type).toBe("search");
    expect(search.clearButtonEl.getAttribute("aria-label")).toBeTruthy();
    expect(search.getValue()).toBe("");
    search.onChange(changed);
    search.setValue("initial");
    expect(changed).not.toHaveBeenCalled();
    search.inputEl.value = "typed";
    search.onChanged();
    expect(search.getValue()).toBe("typed");
    expect(changed.mock.calls).toEqual([["typed"]]);
    search.clearButtonEl.click();
    expect(search.getValue()).toBe("");
    expect(changed.mock.calls).toEqual([["typed"], [""]]);
    search.setValue("kept");
    search.setDisabled(true);
    expect(search.inputEl.disabled).toBe(true);
    expect(search.clearButtonEl.disabled).toBe(true);
    search.clearButtonEl.click();
    expect(search.getValue()).toBe("kept");
    search.setDisabled(false);
    expect(search.inputEl.disabled).toBe(false);
    expect(search.clearButtonEl.disabled).toBe(false);
  });
});
