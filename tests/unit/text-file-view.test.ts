import { describe, expect, it, vi } from "vitest";
import { TFile } from "../../src/compat/files";
import { TextFileView } from "../../src/compat/obsidian-api";

const stats = { ctime: 0, mtime: 0, size: 0 };

/** Stands in for a plugin view that owns its own buffer, like a canvas or grid. */
class BufferView extends TextFileView {
  rendered = "";
  loaded = 0;
  loadedWith = "";
  unloaded = 0;
  constructor(app: object) {
    super({ app });
  }
  override getViewType(): string {
    return "buffer";
  }
  override getViewData(): string {
    return this.rendered;
  }
  override setViewData(data: string, _clear: boolean): void {
    this.rendered = data;
    this.data = data;
  }
  override async onLoadFile(_file: TFile): Promise<void> {
    this.loaded += 1;
    this.loadedWith = this.rendered;
  }
  override async onUnloadFile(_file: TFile): Promise<void> {
    this.unloaded += 1;
  }
}

function setup(initial = "") {
  const contents = new Map<string, string>([["Note.md", initial]]);
  const read = vi.fn(async (file: TFile) => contents.get(file.path) ?? "");
  const modify = vi.fn(async (file: TFile, data: string) => {
    contents.set(file.path, data);
    return file;
  });
  const vault = { read, modify };
  const view = new BufferView({ vault });
  const file = new TFile(vault, "Note.md", stats);
  return { view, file, read, modify, contents };
}

describe("TextFileView", () => {
  it("reads the note before the plugin's onLoadFile runs", async () => {
    const { view, file, read } = setup("Erster Text");

    await view.loadFile(file);

    expect(read).toHaveBeenCalledTimes(1);
    expect(view.data).toBe("Erster Text");
    expect(view.loaded).toBe(1);
    expect(view.loadedWith).toBe("Erster Text");
  });

  it("writes only changed content and remembers the written value", async () => {
    const { view, file, modify } = setup("Alt");
    await view.loadFile(file);

    await view.save();
    expect(modify).not.toHaveBeenCalled();

    view.rendered = "Neu";
    await view.save();
    expect(modify).toHaveBeenCalledTimes(1);
    expect(modify.mock.calls[0][1]).toBe("Neu");

    await view.save();
    expect(modify).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid requestSave calls into one write", async () => {
    const { view, file, modify } = setup("Alt");
    await view.loadFile(file);
    vi.useFakeTimers();
    try {
      view.rendered = "A";
      view.requestSave();
      view.rendered = "AB";
      view.requestSave();

      expect(modify).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);

      expect(modify).toHaveBeenCalledTimes(1);
      expect(modify.mock.calls[0][1]).toBe("AB");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes a queued save when the view unloads", async () => {
    const { view, file, modify } = setup("Alt");
    await view.loadFile(file);
    view.load();
    vi.useFakeTimers();
    try {
      view.rendered = "Neu";
      view.requestSave();

      await view.unloadAsync();

      expect(modify).toHaveBeenCalledTimes(1);
      expect(modify.mock.calls[0][1]).toBe("Neu");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not swallow a rejected write", async () => {
    const { view, file, modify } = setup("Alt");
    await view.loadFile(file);
    modify.mockRejectedValueOnce(new Error("Konflikt"));

    view.rendered = "Neu";

    await expect(view.save()).rejects.toThrow("Konflikt");
  });

  it("clears the buffer and unloads the file", async () => {
    const { view, file } = setup("Alt");
    await view.loadFile(file);

    view.clear();

    expect(view.data).toBe("");
    expect(view.file).toBeNull();
    expect(view.unloaded).toBe(1);
  });
});
