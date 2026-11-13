import { afterEach, expect, it, vi } from "vitest";
import { createObsidianApi } from "../../src/compat/obsidian-api";

afterEach(() => { document.body.replaceChildren(); });

for (const documentRoot of [false, true]) {
  it(`delegates events to dynamic descendants and removes matching listeners (${documentRoot ? "document" : "element"})`, () => {
    createObsidianApi({ app: {} });
    const root = documentRoot ? document : document.createElement("div");
    if (root !== document) document.body.append(root as HTMLElement);
    const listener = vi.fn(function (this: unknown, _event: Event, target: HTMLElement) {
      expect(this).toBe(root);
      expect(target.tagName).toBe("BUTTON");
    });
    root.on("click", ".choice", listener, { capture: true });
    const button = document.createElement("button");
    button.className = "choice";
    const child = document.createElement("span");
    button.append(child);
    (root === document ? document.body : root).append(button);
    child.click();
    expect(listener).toHaveBeenCalledOnce();
    root.off("click", ".other", listener, true);
    child.click();
    expect(listener).toHaveBeenCalledTimes(2);
    root.off("click", ".choice", listener, true);
    child.click();
    expect(listener).toHaveBeenCalledTimes(2);
  });
}

it("does not match ancestors outside the delegation root and retains direct event helpers", () => {
  createObsidianApi({ app: {} });
  const outer = document.createElement("div");
  outer.className = "outside";
  const root = outer.createDiv();
  document.body.append(outer);
  const listener = vi.fn();
  root.on("click", ".outside", listener);
  root.click();
  expect(listener).not.toHaveBeenCalled();
  root.off("click", ".outside", listener);
  root.on("click", listener);
  root.click();
  expect(listener).toHaveBeenCalledOnce();
  root.off("click", listener);
  root.click();
  expect(listener).toHaveBeenCalledOnce();
});

it("consumes a delegated once listener only on a matching event and before reentrant dispatch", () => {
  createObsidianApi({ app: {} });
  const root = document.createElement("div");
  const button = root.createEl("button", { cls: "choice" });
  document.body.append(root);
  const listener = vi.fn(() => button.click());
  root.on("click", ".choice", listener, { once: true });
  root.click();
  button.click();
  expect(listener).toHaveBeenCalledOnce();
  button.click();
  expect(listener).toHaveBeenCalledOnce();
});

it("deduplicates delegated registrations with the same selector, callback and capture", () => {
  createObsidianApi({ app: {} });
  const root = document.createElement("div");
  const button = root.createEl("button", { cls: "choice" });
  const listener = vi.fn();
  root.on("click", ".choice", listener);
  root.on("click", ".choice", listener, { capture: false });
  button.click();
  expect(listener).toHaveBeenCalledOnce();
  root.off("click", ".choice", listener);
});

it("releases aborted delegated registrations so the same listener can register again", () => {
  createObsidianApi({ app: {} });
  const root = document.createElement("div");
  const button = root.createEl("button", { cls: "choice" });
  const signal = new AbortController();
  const listener = vi.fn();
  root.on("click", ".choice", listener, { signal: signal.signal });
  signal.abort();
  button.click();
  expect(listener).not.toHaveBeenCalled();
  // An already-aborted signal must not reserve the callback's registration either.
  root.on("click", ".choice", listener, { signal: signal.signal });
  root.on("click", ".choice", listener);
  button.click();
  expect(listener).toHaveBeenCalledOnce();
  root.off("click", ".choice", listener);
});
