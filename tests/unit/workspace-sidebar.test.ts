import { EditorState } from "@codemirror/state";
import { expect, it, vi } from "vitest";
import { Component } from "../../src/compat/component";
import { Editor } from "../../src/compat/editor-adapter";
import { EditorExtensionRegistry } from "../../src/compat/editor-extensions";
import {
  MarkdownView,
  sideName,
  Workspace,
  type SideName,
  type SidebarHost,
  type WorkspaceLeaf,
} from "../../src/compat/workspace";

class CalendarView extends Component {
  readonly containerEl = document.createElement("div");
  opened = 0;
  getViewType() {
    return "calendar";
  }
  getDisplayText() {
    return "Calendar";
  }
  onOpen() {
    this.opened += 1;
  }
}

function setup(withHost = true) {
  const editor = new Editor({
    state: EditorState.create({ doc: "" }),
    hasFocus: false,
    scrollDOM: document.createElement("div"),
    dispatch: vi.fn(),
    focus: vi.fn(),
    requestMeasure: vi.fn(),
  });
  const markdown = new MarkdownView(editor, document.createElement("div"));
  const workspace = new Workspace(
    markdown,
    vi.fn(async () => {}),
    new EditorExtensionRegistry(vi.fn()),
  );
  const views: CalendarView[] = [];
  const registered = new Set(["calendar"]);
  const services = {
    getView: (type: string) =>
      registered.has(type)
        ? () => {
            const view = new CalendarView();
            views.push(view);
            return view;
          }
        : undefined,
    getViewsFor: () => ["calendar"],
    viewListener: undefined as ((type: string) => void) | undefined,
  };
  workspace.connect({}, services as never);
  /** What `PluginServices.registerView` does for an already known factory. */
  const register = (type: string) => {
    registered.add(type);
    services.viewListener?.(type);
  };
  const open = { left: true, right: false };
  const sidebar: SidebarHost = {
    show: vi.fn(),
    reveal: vi.fn(),
    isOpen: (side: SideName) => open[side],
    setOpen: vi.fn((side: SideName, value: boolean) => {
      open[side] = value;
    }),
  };
  const detach = vi.fn();
  if (withHost) workspace.host = { open: vi.fn(), detach, sidebar };
  return { workspace, markdown, views, sidebar, detach, register, registered };
}

it("opens plugin views in a sidebar without taking focus from the note", async () => {
  const { workspace, views, sidebar } = setup();
  const main = workspace.activeLeaf;
  const leaf = workspace.getRightLeaf(false);
  expect(leaf.side).toBe("right");
  expect(workspace.rightSplit.children).toEqual([leaf]);
  await leaf.setViewState({ type: "calendar", active: true });
  expect(views).toHaveLength(1);
  expect(views[0].opened).toBe(1);
  expect(leaf.view).toBe(views[0]);
  expect(leaf.containerEl.contains(views[0].containerEl)).toBe(true);
  expect(sidebar.show).toHaveBeenCalledWith(leaf);
  expect(sidebar.reveal).toHaveBeenCalledWith(leaf);
  // The note stays active, so editor commands keep working.
  expect(workspace.activeLeaf).toBe(main);
  expect(workspace.getLeavesOfType("calendar")).toEqual([leaf]);
  const roots: WorkspaceLeaf[] = [];
  workspace.iterateRootLeaves((root) => roots.push(root));
  expect(roots).not.toContain(leaf);
  expect(leaf.getRoot()).toBe(workspace.rightSplit);
  expect(leaf.getContainer()).toBe(workspace.rootSplit);
});

it("reuses an existing side leaf in ensureSideLeaf and detaches cleanly", async () => {
  const { workspace, views, sidebar, detach } = setup();
  const first = await workspace.ensureSideLeaf("calendar", "left");
  expect(first.side).toBe("left");
  expect(sidebar.reveal).toHaveBeenCalledWith(first);
  const again = await workspace.ensureSideLeaf("calendar", "right", {
    reveal: false,
  });
  expect(again).toBe(first);
  expect(views).toHaveLength(1);
  workspace.detachLeavesOfType("calendar");
  await workspace.flushPending();
  expect(detach).toHaveBeenCalledWith(first);
  expect(workspace.leftSplit.children).toEqual([]);
  expect(views[0].containerEl.isConnected).toBe(false);
});

it("refuses to open notes in a sidebar", async () => {
  const { workspace } = setup();
  await expect(
    workspace.getLeftLeaf(false).setViewState({ type: "markdown" }),
  ).rejects.toThrow("sidebar");
});

it("collapses and expands sidebars through the host", () => {
  const { workspace, sidebar } = setup();
  expect(workspace.leftSplit.collapsed).toBe(false);
  expect(workspace.rightSplit.collapsed).toBe(true);
  workspace.rightSplit.expand();
  expect(sidebar.setOpen).toHaveBeenLastCalledWith("right", true);
  expect(workspace.rightSplit.collapsed).toBe(false);
  workspace.leftSplit.toggle();
  expect(sidebar.setOpen).toHaveBeenLastCalledWith("left", false);
});

it("fails visibly when the host has no sidebars", () => {
  const { workspace } = setup(false);
  expect(workspace.rightSplit.collapsed).toBe(true);
  expect(() => workspace.rightSplit.expand()).toThrow(
    "Sidebars are not available",
  );
});

it("maps Obsidian side names", () => {
  expect(sideName("primary")).toBe("left");
  expect(sideName("secondary")).toBe("right");
  expect(() => sideName("top" as never)).toThrow("Unknown sidebar");
});

it("loads a side leaf once its view type is registered", async () => {
  const { workspace, views, sidebar, register, registered } = setup();
  registered.delete("calendar");
  const leaf = workspace.getRightLeaf(false);
  await leaf.setViewState({ type: "calendar", active: true });
  expect(views).toHaveLength(0);
  expect(sidebar.show).not.toHaveBeenCalled();
  // Plugins look for their leaf before opening another one.
  expect(workspace.getLeavesOfType("calendar")).toEqual([leaf]);
  register("calendar");
  await workspace.flushPending();
  expect(views).toHaveLength(1);
  expect(leaf.view).toBe(views[0]);
  expect(sidebar.show).toHaveBeenCalledWith(leaf);
});
