import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadIconLibrary } from "../../src/ui/icon-library";
import {
  ButtonComponent,
  createFragment,
  createObsidianApi,
  FuzzySuggestModal,
  getIcon,
  installDomCompat,
  Menu,
  MenuItem as ObsidianMenuItem,
  Modal,
  Notice,
  Scope,
  Setting,
  setIcon,
} from "../../src/compat/obsidian-api";

installDomCompat();


// Plugin hosts load the full Lucide set before activation; do the same here.
beforeAll(() => loadIconLibrary());
describe("Obsidian DOM and UI compatibility", () => {
  it("sets a button tooltip through the shared accessible tooltip helper", () => {
    const button = new ButtonComponent(document.createElement("div"));
    expect(button.setTooltip("Sync settings", { placement: "left" })).toBe(button);
    expect(button.buttonEl.title).toBe("Sync settings");
    expect(button.buttonEl.getAttribute("aria-label")).toBe("Sync settings");
    button.setTooltip("Updated");
    expect(button.buttonEl.title).toBe("Updated");
  });

  it("removes and reapplies button CTA styling without losing other state", () => {
    const button = new ButtonComponent(document.createElement("div"))
      .setButtonText("Apply")
      .setDisabled(true)
      .setCta();
    button.buttonEl.classList.add("plugin-action");
    expect(button.removeCta()).toBe(button);
    expect(button.buttonEl.classList.contains("mod-cta")).toBe(false);
    expect(button.buttonEl.classList.contains("plugin-action")).toBe(true);
    expect(button.buttonEl.textContent).toBe("Apply");
    expect(button.buttonEl.disabled).toBe(true);
    expect(button.setCta()).toBe(button);
    expect(button.buttonEl.classList.contains("mod-cta")).toBe(true);
  });

  it("creates detached global DOM elements and honors parent options", () => {
    const parent = document.createElement("div");
    const child = createDiv({ cls: "cell", text: "A1", parent }, (el) => {
      expect(el.parentElement).toBeNull();
    });
    expect(child.parentElement).toBe(parent);
    expect(child.className).toBe("cell");
    expect(child.textContent).toBe("A1");
    expect(createSpan("label").className).toBe("label");
    expect(createEl("input", { type: "text" })).toBeInstanceOf(
      HTMLInputElement,
    );
  });
  it("provides the DOM helpers plugins use", () => {
    const root = document.createElement("div");
    const child = root.createDiv({ cls: "box", text: "hello" }, (element) => {
      element.setAttr("data-test", "yes");
    });
    expect(child.className).toBe("box");
    expect(child.textContent).toBe("hello");
    expect(child.getAttr("data-test")).toBe("yes");
    child.addClass("second");
    expect(child.hasClass("second")).toBe(true);
    child.setText("changed");
    expect(child.textContent).toBe("changed");
    child.empty();
    expect(child.childNodes).toHaveLength(0);

    const fragment = createFragment((value) => {
      value.createDiv({ text: "fragment child" });
    });
    expect(fragment.querySelector("div")?.textContent).toBe("fragment child");
  });

  it("ignores empty class tokens in element options and class helpers", () => {
    const root = document.createElement("div");
    for (const child of [
      root.createDiv({ cls: [" first ", "", " second\t third "] }),
      createEl("span", { cls: " first second third " }),
      createFragment(fragment => fragment.createDiv({ cls: ["", " first second third "] })).firstElementChild as HTMLElement,
    ]) {
      expect([...child.classList]).toEqual(["first", "second", "third"]);
      child.addClass("", " fourth ", "\t");
      child.removeClass("", " first third ", "\n");
      expect([...child.classList]).toEqual(["second", "fourth"]);
    }
  });

  it("toggles a complete setting row without discarding its controls", () => {
    const setting = new Setting(document.createElement("div")).addText(text => text.setValue("kept"));
    const input = setting.controlEl.querySelector("input");
    expect(setting.setVisibility(false)).toBe(setting);
    expect(setting.settingEl.hidden).toBe(true);
    expect(setting.setVisibility(true)).toBe(setting);
    expect(setting.settingEl.hidden).toBe(false);
    expect(setting.controlEl.querySelector("input")).toBe(input);
    expect(input?.value).toBe("kept");
  });

  it("returns keymap handlers with the documented func and scope", () => {
    const scope = new Scope();
    const callback = vi.fn(() => false);
    const handler = scope.register([], "Escape", callback);
    expect(handler.func).toBe(callback);
    expect(handler.scope).toBe(scope);
    expect(scope.handle(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
    expect(callback).toHaveBeenCalledOnce();
    handler.func = () => true;
    expect(scope.handle(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
    scope.unregister(handler);
    expect(scope.handle(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
  });

  it("opens modals, handles scope shortcuts and closes on Escape", () => {
    const modal = new Modal({});
    const callback = vi.fn();
    modal.scope.register([], "Enter", callback);
    modal.open();
    expect(document.querySelector(".basalt-plugin-modal")).not.toBeNull();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(callback).toHaveBeenCalledOnce();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(document.querySelector(".basalt-plugin-modal")).toBeNull();
  });

  it("renders notices and settings controls", () => {
    const notice = new Notice("Test", 60_000);
    expect(notice.noticeEl.textContent).toBe("Test");
    notice.hide();
    expect(notice.noticeEl.isConnected).toBe(false);

    const host = document.createElement("div");
    let value = "";
    new Setting(host)
      .setName("Name")
      .setDesc("Description")
      .addText((text) =>
        text.setPlaceholder("Placeholder").onChange((next) => (value = next)),
      );
    const input = host.querySelector("input")!;
    input.value = "new";
    input.dispatchEvent(new Event("input"));
    expect(value).toBe("new");
    expect(host.textContent).toContain("Description");
  });

  it("maps FuzzySuggestModal.onChooseItem through the suggestion base", async () => {
    class Choice extends FuzzySuggestModal<string> {
      chosen = "";
      getItems() {
        return ["alpha", "beta"];
      }
      getItemText(item: string) {
        return item;
      }
      onChooseItem(item: string) {
        this.chosen = item;
      }
    }
    const modal = new Choice({});
    expect(modal.getSuggestions("bt")).toEqual([
      {
        item: "beta",
        match: {
          score: 2,
          matches: [
            [0, 1],
            [2, 3],
          ],
        },
      },
    ]);
    modal.open();
    modal.inputEl.value = "bet";
    modal.inputEl.dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const item =
      modal.resultContainerEl.querySelector<HTMLElement>(".suggestion-item");
    expect(item?.textContent).toBe("beta");
    item!.click();
    expect(modal.chosen).toBe("beta");
  });

  it("exposes a coherent API module", () => {
    const api = createObsidianApi({ app: {} }) as {
      Plugin: unknown;
      Platform: { isDesktop: boolean };
      normalizePath(path: string): string;
      parseLinktext(text: string): unknown;
      getIconIds(): string[];
    };
    expect(api.Plugin).toBeTypeOf("function");
    expect(api.Platform).toMatchObject({ isDesktop: true });
    expect(api.normalizePath("a//b/./c")).toBe("a/b/c");
    expect(api.parseLinktext("[[Note#Heading]]")).toEqual({
      path: "Note",
      subpath: "#Heading",
    });
    expect(api.getIconIds()).toContain("file-text");
  });

  it("exposes the input components plugins construct directly", () => {
    const api = createObsidianApi({ app: {} }) as unknown as Record<
      string,
      new (containerEl: HTMLElement) => unknown
    > & {
      TextComponent: new (containerEl: HTMLElement) => {
        inputEl: HTMLInputElement;
        setValue(value: string): unknown;
      };
      ToggleComponent: new (containerEl: HTMLElement) => {
        inputEl: HTMLInputElement;
        setValue(value: boolean): unknown;
      };
    };
    for (const name of [
      "TextComponent",
      "TextAreaComponent",
      "ToggleComponent",
      "ButtonComponent",
      "ExtraButtonComponent",
      "DropdownComponent",
      "SliderComponent",
      "ColorComponent",
    ])
      expect(api[name]).toBeTypeOf("function");
    const text = new api.TextComponent(document.createElement("div"));
    text.setValue("Wert");
    expect(text.inputEl.value).toBe("Wert");
    const toggle = new api.ToggleComponent(document.createElement("div"));
    toggle.setValue(true);
    expect(toggle.inputEl.checked).toBe(true);
  });

  it("keeps a menu item's title when the icon is set afterwards", () => {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Kopieren").setIcon("copy"));
    const entry = menu.menuEl.querySelector(".menu-item") as HTMLElement;
    expect(entry.querySelector(".menu-item-title")?.textContent).toBe(
      "Kopieren",
    );
    expect(entry.querySelector(".menu-item-icon svg")).not.toBeNull();
    menu.hide();
  });

  it("exposes MenuItem as a patchable prototype used by Menu.addItem", () => {
    const original = ObsidianMenuItem.prototype.setTitle;
    ObsidianMenuItem.prototype.setTitle = function (value: string) {
      return original.call(this, value.toUpperCase());
    };
    const menu = new Menu();
    try {
      menu.addItem((item) => {
        expect(item).toBeInstanceOf(ObsidianMenuItem);
        item.setTitle("Kopieren");
      });
    } finally {
      ObsidianMenuItem.prototype.setTitle = original;
      menu.hide();
    }
    const entry = menu.menuEl.querySelector(".menu-item") as HTMLElement;
    expect(entry.querySelector(".menu-item-title")?.textContent).toBe(
      "KOPIEREN",
    );
  });

  it("shows the check mark of a chosen menu item next to its label", () => {
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("Ganze Striche").setIcon("eraser").setChecked(true),
    );
    const entry = menu.menuEl.querySelector(".menu-item") as HTMLElement;
    expect(entry.querySelector(".menu-item-check svg")).not.toBeNull();
    expect(entry.querySelector(".menu-item-title")?.textContent).toBe(
      "Ganze Striche",
    );
    menu.hide();
  });

  it("combines host and plugin entries with keyboard dismissal and one hide callback", () => {
    const menu = new Menu();
    const hidden = vi.fn();
    menu.onHide(hidden);
    menu.addItem((item) => item.setTitle("Plugin action"));
    menu.showWithHostEntries([{ title: "Host action", onClick: vi.fn() }], {
      x: 10,
      y: 10,
    });
    expect(menu.menuEl.getAttribute("role")).toBe("menu");
    const buttons =
      menu.menuEl.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    expect([...buttons].map((button) => button.textContent)).toEqual([
      "Host action",
      "Plugin action",
    ]);
    buttons[0].focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(document.activeElement).toBe(buttons[1]);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    menu.hide();
    expect(hidden).toHaveBeenCalledTimes(1);
    expect(menu.menuEl.isConnected).toBe(false);
  });

  it("replaces only the previous icon and keeps other content", () => {
    const host = document.createElement("button");
    host.textContent = "Neu";
    setIcon(host, "trash-2");
    expect(host.textContent).toContain("Neu");
    expect(host.querySelectorAll("svg")).toHaveLength(1);
    setIcon(host, "grid-2x2");
    expect(host.querySelectorAll("svg")).toHaveLength(1);
    expect(host.textContent).toContain("Neu");
  });

  it("resolves lucide icons whose ids end in digits", () => {
    expect(getIcon("trash-2")).not.toBeNull();
    expect(getIcon("grid-2x2")).not.toBeNull();
  });

  it("resolves the icon ids a pen plugin toolbar asks for", () => {
    for (const id of [
      "pencil-line",
      "file-check",
      "list-checks",
      "sliders-horizontal",
      "eraser",
      "highlighter",
      "replace",
      "rotate-ccw",
      "text-cursor-input",
      "trash-2",
      "clipboard-copy",
      "box-select",
    ])
      expect(getIcon(id), id).not.toBeNull();
  });
});
