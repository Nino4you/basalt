import { describe, expect, it, vi } from "vitest";
import {
  PluginServices,
  type PluginEditorContext,
} from "../../src/compat/plugin-services";
import { Plugin, PluginRegistry } from "../../src/compat/plugin";

const editor = { kind: "editor" };
const view = { kind: "view" };
const context: PluginEditorContext = { editor, view };

function createServices(
  provider?: () => PluginEditorContext | null,
): PluginServices {
  return new PluginServices(undefined, undefined, document, provider);
}

describe("plugin command execution", () => {
  it("namespaces equal plugin command IDs and returns the registered command", async () => {
    const services = createServices();
    const registry = new PluginRegistry(
      {},
      { read: async () => null, write: async () => {} },
      false,
      undefined,
      services,
    );
    class Commands extends Plugin {
      command = { id: "open", name: "Open", callback: () => this.manifest.id };
      registered: unknown;
      override onload() {
        this.registered = this.addCommand(this.command);
      }
    }
    const first = (await registry.enable(
      { id: "first", name: "First", version: "1" },
      Commands,
    )) as Commands;
    await registry.enable(
      { id: "second", name: "Second", version: "1" },
      Commands,
    );
    expect(first.registered).toMatchObject({
      id: "first:open",
      name: "First: Open",
    });
    expect(first.command.id).toBe("open");
    expect(services.runCommand("first:open")).toBe("first");
    expect(services.runCommand("second:open")).toBe("second");
    first.removeCommand("open");
    expect(services.isCommandAvailable("first:open")).toBe(false);
    expect(services.runCommand("second:open")).toBe("second");
    await registry.disable("first");
    expect(services.runCommand("second:open")).toBe("second");
    await registry.disable("second");
    expect(services.getCommands()).toEqual([]);
  });

  it("passes the active editor and view to editorCallback", () => {
    const callback = vi.fn((editorArg: unknown, viewArg: unknown) => ({
      editor: editorArg,
      view: viewArg,
    }));
    const services = createServices(() => context);
    services.addCommand("plugin", {
      id: "editor-command",
      name: "Editor command",
      editorCallback: callback,
    });

    expect(services.runCommand("editor-command")).toEqual({ editor, view });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(editor, view);
  });

  it("checks editorCheckCallback before invoking it", () => {
    const calls: Array<[boolean, unknown, unknown]> = [];
    let executed = 0;
    const callback = vi.fn(
      (checking: boolean, editorArg: unknown, viewArg: unknown) => {
        calls.push([checking, editorArg, viewArg]);
        if (!checking) executed += 1;
        return true;
      },
    );
    const services = createServices(() => context);
    services.addCommand("plugin", {
      id: "editor-check",
      name: "Editor check",
      editorCheckCallback: callback,
    });

    expect(services.runCommand("editor-check")).toBe(true);
    expect(calls).toEqual([
      [true, editor, view],
      [false, editor, view],
    ]);
    expect(executed).toBe(1);
  });

  it("does not invoke a guarded editor callback when it is unavailable", () => {
    const callback = vi.fn(() => false);
    const services = createServices(() => context);
    services.addCommand("plugin", {
      id: "editor-guarded",
      name: "Editor guarded",
      editorCheckCallback: callback,
    });

    expect(() => services.runCommand("editor-guarded")).toThrow(
      /Command is unavailable: editor-guarded/,
    );
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(true, editor, view);
  });

  it("does not invoke a guarded callback when it is unavailable", () => {
    const callback = vi.fn((checking: boolean) => !checking);
    const services = createServices();
    services.addCommand("plugin", {
      id: "guarded",
      name: "Guarded",
      checkCallback: callback,
    });

    expect(services.isCommandAvailable("guarded")).toBe(false);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(true);
    expect(() => services.runCommand("guarded")).toThrow(
      /Command is unavailable: guarded/,
    );
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenLastCalledWith(true);
  });

  it("rejects editor commands when there is no active editor", () => {
    const editorCallback = vi.fn();
    const editorCheckCallback = vi.fn(() => true);
    const services = createServices(() => null);
    services.addCommand("plugin", {
      id: "no-editor",
      name: "No editor",
      editorCallback,
    });
    services.addCommand("plugin", {
      id: "no-editor-check",
      name: "No editor check",
      editorCheckCallback,
    });

    expect(() => services.runCommand("no-editor")).toThrow(/no active editor/);
    expect(() => services.runCommand("no-editor-check")).toThrow(
      /no active editor/,
    );
    expect(services.isCommandAvailable("no-editor")).toBe(false);
    expect(services.isCommandAvailable("no-editor-check")).toBe(false);
    expect(editorCallback).not.toHaveBeenCalled();
    expect(editorCheckCallback).not.toHaveBeenCalled();
  });

  it("treats editor commands as unavailable without an editor provider", () => {
    const services = new PluginServices();
    services.addCommand("plugin", {
      id: "unwired",
      name: "Unwired",
      editorCallback: () => "never",
    });

    expect(services.isCommandAvailable("unwired")).toBe(false);
    expect(() => services.runCommand("unwired")).toThrow(/no active editor/);
  });

  it("reports availability using checking=true without executing commands", () => {
    const check = vi.fn((checking: boolean) => checking);
    const editorCheck = vi.fn((checking: boolean) => checking);
    const plain = vi.fn(() => "ran");
    const services = createServices(() => context);
    services.addCommand("plugin", {
      id: "plain",
      name: "Plain",
      callback: plain,
    });
    services.addCommand("plugin", {
      id: "checked",
      name: "Checked",
      checkCallback: check,
    });
    services.addCommand("plugin", {
      id: "editor-checked",
      name: "Editor checked",
      editorCheckCallback: editorCheck,
    });

    expect(services.isCommandAvailable("plain")).toBe(true);
    expect(services.isCommandAvailable("checked")).toBe(true);
    expect(services.isCommandAvailable("editor-checked")).toBe(true);
    expect(services.isCommandAvailable("missing")).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(true);
    expect(editorCheck).toHaveBeenCalledTimes(1);
    expect(editorCheck).toHaveBeenCalledWith(true, editor, view);
    expect(plain).not.toHaveBeenCalled();
  });

  it("returns command results and does not run the ordinary callback twice", () => {
    let executed = 0;
    const fallback = vi.fn(() => "fallback");
    const checked = vi.fn((checking: boolean) => {
      if (!checking) executed += 1;
      return true;
    });
    const services = createServices();
    services.addCommand("plugin", {
      id: "plain",
      name: "Plain",
      callback: () => 42,
    });
    services.addCommand("plugin", {
      id: "checked",
      name: "Checked",
      callback: fallback,
      checkCallback: checked,
    });

    expect(services.runCommand("plain")).toBe(42);
    expect(services.runCommand("checked")).toBe(true);
    expect(executed).toBe(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(checked).toHaveBeenNthCalledWith(1, true);
    expect(checked).toHaveBeenNthCalledWith(2, false);
  });

  it("returns promises so asynchronous command errors reach the host", async () => {
    const services = createServices(() => context);
    services.addCommand("plugin", {
      id: "async-editor",
      name: "Async editor",
      editorCallback: async () => {
        throw new Error("editor failed");
      },
    });
    services.addCommand("plugin", {
      id: "async-plain",
      name: "Async plain",
      callback: async () => {
        throw new Error("plain failed");
      },
    });

    await expect(
      Promise.resolve(services.runCommand("async-editor")),
    ).rejects.toThrow("editor failed");
    await expect(
      Promise.resolve(services.runCommand("async-plain")),
    ).rejects.toThrow("plain failed");
  });

  it("rejects unknown commands", () => {
    const services = createServices(() => context);

    expect(() => services.runCommand("missing")).toThrow(
      /Unknown command: missing/,
    );
    expect(services.isCommandAvailable("missing")).toBe(false);
  });
});
