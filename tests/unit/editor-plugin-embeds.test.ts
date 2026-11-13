import { afterEach, describe, expect, it, vi } from "vitest";
import { Component } from "../../src/compat/component";
import { type PluginEmbed } from "../../src/compat/embeds";
import { MarkdownEditor } from "../../src/editor";
import { memoryVault } from "../helpers/vault-store";

let editor: MarkdownEditor;
afterEach(() => {
  editor?.view.destroy();
  document.body.replaceChildren();
});

async function mount(doc = "Text\n\n![[Table.xlsx#Two]]\n") {
  const vault = await memoryVault({ "Table.xlsx": "" });
  const cleanup = vi.fn();
  const loaded = vi.fn();
  const embed: PluginEmbed = {
    file: vault.getFileByPath("Table.xlsx")!,
    subpath: "#Two",
    factory: ({ containerEl }) =>
      new (class extends Component {
        onload() {
          expect(containerEl.isConnected).toBe(true);
          this.register(cleanup);
        }
        loadFile() {
          loaded();
          containerEl.textContent = "inline A1";
        }
      })(),
  };
  let active = true;
  const parent = document.createElement("div");
  document.body.append(parent);
  editor = new MarkdownEditor(parent, {
    resolves: () => true,
    openLink: () => {},
    openExternal: () => {},
    openTag: () => {},
    notes: () => [],
    tags: () => [],
    save: () => {},
    onChange: () => {},
    pluginEmbed: () => (active ? embed : null),
  });
  editor.setState(editor.createState(doc));
  editor.setEditable(true);
  return {
    parent,
    cleanup,
    loaded,
    disable: () => {
      active = false;
      editor.refreshPluginBlocks();
    },
  };
}

describe("file embeds in live preview", () => {
  it("mounts standalone embeds and preserves them through focus and selection changes", async () => {
    const { parent, loaded } = await mount();
    await vi.waitFor(() =>
      expect(parent.querySelector(".plugin-embed")?.textContent).toBe(
        "inline A1",
      ),
    );
    editor.view.focus();
    editor.view.dispatch({ selection: { anchor: 12 } });
    expect(loaded).toHaveBeenCalledOnce();
    expect(editor.text).toContain("![[Table.xlsx#Two]]");
    expect(parent.textContent).not.toContain("Table.xlsx");
  });
  it("unloads on source mode, restores on live preview, and falls back when disabled", async () => {
    const { parent, cleanup, disable } = await mount();
    await vi.waitFor(() => expect(parent.textContent).toContain("inline A1"));
    editor.configure({ livePreview: false });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(parent.textContent).toContain("![[Table.xlsx#Two]]");
    editor.configure({ livePreview: true });
    await vi.waitFor(() => expect(parent.textContent).toContain("inline A1"));
    disable();
    expect(parent.querySelector(".plugin-embed")).toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
  it("does not replace embeds in code, lists, or mid-paragraph", async () => {
    const { parent } = await mount(
      "`![[Table.xlsx]]`\n\n- ![[Table.xlsx]]\n\nText ![[Table.xlsx]] suffix\n",
    );
    expect(parent.querySelector(".plugin-embed")).toBeNull();
  });
  it("cancels rendering when the note is closed before the first frame", async () => {
    const { loaded } = await mount();
    editor.setState(editor.createState("Other note"));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    expect(loaded).not.toHaveBeenCalled();
  });
  it("releases hidden surfaces without changing the note or selection and restores them", async () => {
    const { parent, cleanup, loaded } = await mount();
    await vi.waitFor(() => expect(loaded).toHaveBeenCalledOnce());
    editor.view.dispatch({ selection: { anchor: 12 } });
    const text = editor.text;
    editor.releasePluginBlocks();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(parent.querySelector(".plugin-embed")).toBeNull();
    expect(editor.text).toBe(text);
    expect(editor.state.selection.main.head).toBe(12);
    editor.refreshPluginBlocks();
    await vi.waitFor(() => expect(loaded).toHaveBeenCalledTimes(2));
  });
});
