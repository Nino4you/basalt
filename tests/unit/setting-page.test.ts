import { describe, expect, it } from "vitest";
import { createObsidianApi, Setting } from "../../src/compat/obsidian-api";

interface PageContract {
  rootEl: HTMLElement;
  titlebarEl: HTMLElement;
  containerEl: HTMLElement;
  title: string;
  hide(): void;
}

function pageConstructor(): new () => PageContract {
  const api = createObsidianApi({ app: {} });
  expect(api.SettingPage).toBeTypeOf("function");
  return api.SettingPage as new () => PageContract;
}

describe("plugin setting sub-pages", () => {
  it("exports a constructible base with real title and content elements", () => {
    class Page extends pageConstructor() {
      display(): void {
        this.containerEl.replaceChildren();
        new Setting(this.containerEl).setName("Synthetic setting");
      }
    }
    const page = new Page();
    page.title = "Plugin options";
    page.display();
    expect(page.rootEl.contains(page.titlebarEl)).toBe(true);
    expect(page.rootEl.contains(page.containerEl)).toBe(true);
    expect(page.titlebarEl.textContent).toBe("Plugin options");
    expect(page.containerEl.textContent).toContain("Synthetic setting");
    page.title = "<img src=x>";
    expect(page.title).toBe("<img src=x>");
    expect(page.titlebarEl.querySelector("img")).toBeNull();
  });

  it("clears page content on hide and allows it to be rendered again", () => {
    class Page extends pageConstructor() {
      display(): void {
        this.containerEl.replaceChildren(document.createElement("input"));
      }
    }
    const page = new Page();
    page.title = "Kept title";
    page.display();
    const oldInput = page.containerEl.firstElementChild!;
    page.hide();
    page.hide();
    expect(page.containerEl.childNodes).toHaveLength(0);
    expect(oldInput.parentElement).toBeNull();
    expect(page.title).toBe("Kept title");
    page.display();
    expect(page.containerEl.querySelector("input")).not.toBeNull();
    expect(page.containerEl.firstElementChild).not.toBe(oldInput);
  });
});
