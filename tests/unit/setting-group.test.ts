import { describe, expect, it, vi } from "vitest";
import { createObsidianApi, Setting } from "../../src/compat/obsidian-api";

describe("plugin setting groups", () => {
  it("groups real settings and prepends an interactive search control", () => {
    const api = createObsidianApi({ app: {} });
    expect(api.SettingGroup).toBeTypeOf("function");
    const Group = api.SettingGroup as typeof import("../../src/compat/obsidian-api").SettingGroup;
    const root = document.createElement("div");
    const group = new Group(root);
    const changed = vi.fn();
    const clicked = vi.fn();
    expect(group.setHeading("<Plugin options>").addClass("plugin-options", "custom")).toBe(group);
    expect(group.addSetting(setting => {
      expect(setting).toBeInstanceOf(Setting);
      setting.setName("Folder").addText(text => text.setValue("Notes"));
    })).toBe(group);
    expect(group.addSearch(search => search.setPlaceholder("Filter").onChange(changed))).toBe(group);
    expect(group.addExtraButton(button => button.setTooltip("Refresh").onClick(clicked))).toBe(group);
    expect(root.textContent).toContain("<Plugin options>");
    expect(root.querySelector("plugin")).toBeNull();
    expect(group.listEl.classList.contains("plugin-options")).toBe(true);
    expect(root.contains(group.listEl)).toBe(true);
    const input = group.listEl.querySelector<HTMLInputElement>('input[type="search"]')!;
    const setting = group.listEl.querySelector(".setting-item")!;
    expect(input.compareDocumentPosition(setting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    input.value = "typed";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(changed).toHaveBeenCalledExactlyOnceWith("typed");
    const refresh = root.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!;
    refresh.click();
    expect(clicked).toHaveBeenCalledTimes(1);
    const heading = document.createDocumentFragment();
    const strong = document.createElement("strong");
    strong.textContent = "Updated options";
    heading.append(strong);
    group.setHeading(heading);
    expect(root.contains(strong)).toBe(true);
    expect(root.textContent).not.toContain("<Plugin options>");
    expect(group.listEl.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe("Notes");
  });
});
