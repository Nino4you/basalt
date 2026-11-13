import { afterEach, expect, it, vi } from "vitest";
import { AbstractInputSuggest, createObsidianApi, Modal, TextComponent, ValueComponent } from "../../src/compat/obsidian-api";

it("exports the editor suggestion base with a nullable context and close lifecycle", () => {
  const api = createObsidianApi({ app: {} });
  const Base = api.EditorSuggest as new (app: object) => {
    context: unknown; limit: number; open(): void; close(): void;
    setInstructions(items: Array<{ command: string; purpose: string }>): void;
  };
  const suggest = new Base({});
  expect(suggest.context).toBeNull();
  expect(suggest.limit).toBe(100);
  suggest.setInstructions([{ command: "Enter", purpose: "Choose" }]);
  suggest.open();
  expect(document.querySelector(".suggestion-instructions")?.textContent).toContain("Choose");
  suggest.context = { query: "test" };
  suggest.close();
  expect(suggest.context).toBeNull();
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});

afterEach(() => { document.body.replaceChildren(); });

it("installs the documented asynchronous sleep global", async () => {
  createObsidianApi({ app: {} });
  const sleep = (globalThis as typeof globalThis & { sleep: (ms: number) => Promise<void> }).sleep;
  expect(typeof sleep).toBe("function");
  vi.useFakeTimers();
  try {
    const done = vi.fn();
    void sleep(50).then(done);
    await vi.advanceTimersByTimeAsync(49);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("installs the documented DOM helpers on elements including SVG", () => {
  createObsidianApi({ app: {} });
  type Extended = HTMLElement & {
    addClass(...classes: string[]): void; removeClass(...classes: string[]): void;
    hasClass(cls: string): boolean; toggleClass(cls: string, value: boolean): void;
    setText(value: string): void; getText(): string;
    setAttr(name: string, value: string | null): void; getAttr(name: string): string | null;
  };
  const el = document.createElement("div") as unknown as Extended;
  el.addClass("a", "b");
  el.toggleClass("c", true);
  expect([el.hasClass("a"), el.hasClass("c")]).toEqual([true, true]);
  el.removeClass("b");
  expect(el.hasClass("b")).toBe(false);
  el.setText("text");
  expect(el.getText()).toBe("text");
  el.setAttr("data-x", "1");
  expect(el.getAttr("data-x")).toBe("1");
  el.setAttr("data-x", null);
  expect(el.getAttr("data-x")).toBeNull();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as unknown as Extended;
  svg.addClass("s");
  expect(svg.hasClass("s")).toBe(true);
});

it("installs the documented moment global used for timestamped filenames", () => {
  const api = createObsidianApi({ app: {} });
  const moment = (globalThis as typeof globalThis & { moment: () => { format(pattern: string): string; locale(): string } }).moment;
  expect(moment().format("YYYYMMDDHHmmss_SSS")).toMatch(/^\d{14}_\d{3}$/);
  expect(moment().locale()).toBe("de");
  const exported = api.moment as (() => { format(pattern: string): string; locale(): string }) & { locale(): string };
  expect(exported().format("YYYY")).toMatch(/^\d{4}$/);
  expect(exported().locale()).toBe("de");
  expect(exported.locale()).toBe("de");
});

it("exports the configured app language and value-component base class", () => {
  const api = createObsidianApi({ app: {} });
  expect((api.getLanguage as () => string)()).toBe("de");
  expect(api.ValueComponent).toBe(ValueComponent);
  const text = new TextComponent(document.createElement("div")).setValue("before");
  expect(text).toBeInstanceOf(ValueComponent);
  const listeners: Record<string, (value?: string) => string> = {};
  text.registerOptionListener(listeners, "value");
  expect(listeners.value("after")).toBe("after");
  expect(text.getValue()).toBe("after");
  expect(text.then((component) => component.setDisabled(true))).toBe(text);
  expect(text.disabled).toBe(true);
});

it("renders input suggestions, selects by keyboard and cleans up on blur", async () => {
  createObsidianApi({ app: {} });
  const input = document.createElement("input");
  document.body.append(input);
  class Suggest extends AbstractInputSuggest<string> {
    protected getSuggestions(query: string) { return [query + " one", query + " two"]; }
    renderSuggestion(value: string, el: HTMLElement) { el.textContent = value; }
  }
  const suggest = new Suggest({}, input);
  const select = vi.fn();
  suggest.onSelect(select);
  suggest.setValue("query");
  input.focus();
  await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(2));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  expect(select).toHaveBeenCalledWith("query two", expect.any(KeyboardEvent));
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  input.dispatchEvent(new Event("input"));
  await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
  input.blur();
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});

it("dismisses input suggestions before closing their parent modal with Escape", async () => {
  const modal = new Modal({});
  const input = document.createElement("input");
  modal.contentEl.append(input);
  class Suggest extends AbstractInputSuggest<string> {
    protected getSuggestions() { return ["choice"]; }
    renderSuggestion(value: string, el: HTMLElement) { el.textContent = value; }
  }
  const suggest = new Suggest({}, input);
  modal.open();
  try {
    input.focus();
    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(modal.containerEl.isConnected).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(modal.containerEl.isConnected).toBe(false);
  } finally { suggest.close(); modal.close(); }
});

it("ignores stale async suggestions and results arriving after close", async () => {
  const input = document.createElement("input");
  document.body.append(input);
  const pending: Array<(values: string[]) => void> = [];
  class Suggest extends AbstractInputSuggest<string> {
    protected getSuggestions() { return new Promise<string[]>((resolve) => pending.push(resolve)); }
    renderSuggestion(value: string, el: HTMLElement) { el.textContent = value; }
  }
  const suggest = new Suggest({}, input);
  input.focus();
  input.dispatchEvent(new Event("input"));
  pending[1](["new"]);
  await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')?.textContent).toBe("new"));
  pending[0](["old"]);
  await Promise.resolve();
  expect(document.querySelector('[role="listbox"]')?.textContent).toBe("new");
  input.dispatchEvent(new Event("input"));
  suggest.close();
  pending[2](["closed"]);
  await Promise.resolve();
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});
