import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Component,
  Events,
  FileIndex,
  TFile,
  TFolder,
  debounce,
} from "../../src/compat";

afterEach(() => vi.useRealTimers());

describe("compatibility events", () => {
  it("preserves listener order, context and error isolation", () => {
    const errors: unknown[] = [];
    const events = new Events((error) => errors.push(error));
    const calls: string[] = [];
    const context = { name: "owner" };
    events.on(
      "change",
      function (this: typeof context, name: string) {
        calls.push(`${this.name}:${name}`);
      },
      context,
    );
    events.on("change", () => {
      throw new Error("bad listener");
    });
    events.on("change", () => calls.push("last"));
    events.trigger("change", "note");
    expect(calls).toEqual(["owner:note", "last"]);
    expect(errors).toHaveLength(1);
  });
  it("detaches only the right emitter and does not invoke new listeners mid-dispatch", () => {
    const first = new Events();
    const other = new Events();
    const calls: string[] = [];
    const ref = first.on("tick", () => {
      calls.push("first");
      first.on("tick", () => calls.push("new"));
    });
    other.offref(ref);
    first.trigger("tick");
    expect(calls).toEqual(["first"]);
    first.offref(ref);
    first.offref(ref);
    first.trigger("tick");
    expect(calls).toEqual(["first", "new"]);
  });
});

describe("compatibility resource lifecycle", () => {
  it("loads children once, including late additions, and cleans all resources", () => {
    vi.useFakeTimers();
    const parent = new Component();
    const child = new Component();
    const load = vi.spyOn(child, "onload");
    parent.addChild(child);
    parent.load();
    parent.load();
    expect(load).toHaveBeenCalledTimes(1);
    const late = new Component();
    const lateLoad = vi.spyOn(late, "onload");
    parent.addChild(late);
    expect(lateLoad).toHaveBeenCalledOnce();
    const button = document.createElement("button");
    const click = vi.fn();
    const events = new Events();
    const listener = vi.fn();
    const tick = vi.fn();
    parent.registerDomEvent(button, "click", click, true);
    parent.registerEvent(events.on("test", listener));
    parent.registerInterval(window.setInterval(tick, 10));
    parent.unload();
    parent.unload();
    button.click();
    events.trigger("test");
    vi.advanceTimersByTime(100);
    expect(click).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
  });
  it("continues cleanup after errors and disposes late registrations immediately", () => {
    const component = new Component();
    const cleanup = vi.fn();
    component.register(cleanup);
    component.register(() => {
      throw new Error("cleanup failed");
    });
    expect(() => component.unload()).toThrow(AggregateError);
    expect(cleanup).toHaveBeenCalledOnce();
    const late = vi.fn();
    component.register(late);
    expect(late).toHaveBeenCalledOnce();
  });
  it("rejects ownership cycles and sharing between parents", () => {
    const parent = new Component();
    const child = parent.addChild(new Component());
    expect(() => child.addChild(parent)).toThrow("cycles");
    expect(() => new Component().addChild(child)).toThrow("one parent");
    parent.removeChild(child);
    expect(() => new Component().addChild(child)).not.toThrow();
  });
  it("rolls back resources if loading fails", () => {
    class Broken extends Component {
      override onload() {
        this.register(cleanup);
        throw new Error("cannot load");
      }
    }
    const cleanup = vi.fn();
    expect(() => new Broken().load()).toThrow("cannot load");
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe("compatibility debounce", () => {
  it("resets the timer, preserves latest arguments and flushes once", () => {
    vi.useFakeTimers();
    const callback = vi.fn((value: string) => value.toUpperCase());
    const pending = debounce(callback, 100, true);
    pending("first");
    vi.advanceTimersByTime(90);
    pending("last");
    vi.advanceTimersByTime(20);
    expect(callback).not.toHaveBeenCalled();
    expect(pending.run()).toBe("LAST");
    vi.advanceTimersByTime(200);
    expect(callback).toHaveBeenCalledOnce();
    expect(pending.run()).toBeUndefined();
  });
  it("uses a fixed window unless reset is requested and supports cancellation", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const pending = debounce(callback, 100);
    pending("first");
    vi.advanceTimersByTime(90);
    pending("last");
    vi.advanceTimersByTime(10);
    expect(callback).toHaveBeenCalledWith("last");
    pending("cancelled").cancel();
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledOnce();
  });
});

describe("compatibility metadata graph", () => {
  const stat = { ctime: 1, mtime: 2, size: 4 };
  it("builds root and parents and preserves file identity on refresh", () => {
    const owner = {};
    const index = new FileIndex(owner);
    index.replace([{ path: "Notes/Hello.md", kind: "file", stat }]);
    const file = index.getFileByPath("Notes/Hello.md")!;
    expect(file).toBeInstanceOf(TFile);
    expect(file.basename).toBe("Hello");
    expect(file.extension).toBe("md");
    expect(file.parent).toBeInstanceOf(TFolder);
    expect(file.parent!.parent).toBe(index.getRoot());
    expect(index.getRoot().isRoot()).toBe(true);
    expect(file.vault).toBe(owner);
    index.replace([
      { path: "Notes/Hello.md", kind: "file", stat: { ...stat, mtime: 10 } },
    ]);
    expect(index.getFileByPath("Notes/Hello.md")).toBe(file);
    expect(file.stat.mtime).toBe(10);
    expect(index.getMarkdownFiles()).toEqual([file]);
  });
  it("validates a complete refresh before mutating published metadata", () => {
    const index = new FileIndex();
    index.replace([{ path: "Original.md", kind: "file", stat }]);
    const original = index.getFileByPath("Original.md")!;
    expect(() =>
      index.replace([
        { path: "Original.md", kind: "file", stat: { ...stat, mtime: 50 } },
        { path: "../escape.md", kind: "file", stat },
      ]),
    ).toThrow("Invalid");
    expect(original.stat.mtime).toBe(2);
    expect(index.getFiles()).toEqual([original]);
    expect(() =>
      index.replace([
        { path: "Parent", kind: "file", stat },
        { path: "Parent/Child.md", kind: "file", stat },
      ]),
    ).toThrow("contain children");
    expect(index.getFiles()).toEqual([original]);
  });
});
