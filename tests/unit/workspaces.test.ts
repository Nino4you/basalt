import { beforeEach, expect, it } from "vitest";
import {
  namedWorkspace,
  WorkspaceLibrary,
  workspaceName,
  workspacesKey,
} from "../../src/app/workspaces";
import { popoutPath } from "../../src/app/popout";

beforeEach(() => localStorage.clear());

const tabs = (path: string) => ({
  tabs: [{ path, reading: false }],
  active: 0,
});

it("saves, lists, loads and removes workspaces per vault", () => {
  const library = new WorkspaceLibrary("v1");
  library.save(
    namedWorkspace("Schreiben", tabs("a.md"), { leftOpen: false }, 5),
  );
  library.save(namedWorkspace("Ablage", tabs("b.md"), null, 6));
  expect(library.list().map((w) => w.name)).toEqual(["Ablage", "Schreiben"]);
  expect(library.active).toBe("Ablage");

  const reopened = new WorkspaceLibrary("v1");
  expect(reopened.get("schreiben")).toEqual({
    name: "Schreiben",
    saved: 5,
    tabs: tabs("a.md"),
    layout: { leftOpen: false },
  });
  expect(reopened.active).toBe("Ablage");
  expect(new WorkspaceLibrary("v2").list()).toEqual([]);

  reopened.remove("ABLAGE");
  expect(reopened.list().map((w) => w.name)).toEqual(["Schreiben"]);
  expect(reopened.active).toBeNull();
});

it("replaces a workspace of the same name regardless of case", () => {
  const library = new WorkspaceLibrary("v1");
  library.save(namedWorkspace("Recherche", tabs("a.md"), null));
  library.save(namedWorkspace("  recherche ", tabs("b.md"), null));
  expect(library.list()).toHaveLength(1);
  expect(library.get("Recherche")!.tabs.tabs[0].path).toBe("b.md");
});

it("validates names", () => {
  expect(workspaceName("  Zwei   Wörter ")).toBe("Zwei Wörter");
  expect(() => workspaceName("   ")).toThrow("empty");
  expect(() => workspaceName("x".repeat(81))).toThrow("too-long");
});

it("renames without overwriting another workspace", () => {
  const library = new WorkspaceLibrary("v1");
  library.save(namedWorkspace("A", tabs("a.md"), null));
  library.save(namedWorkspace("B", tabs("b.md"), null));
  expect(() => library.rename("A", "b")).toThrow("exists");
  library.rename("B", "C");
  expect(library.active).toBe("C");
  expect(library.list().map((w) => w.name)).toEqual(["A", "C"]);
});

it("drops corrupt entries and keeps the rest", () => {
  localStorage.setItem(
    workspacesKey("v1"),
    JSON.stringify({
      active: "Gone",
      workspaces: [
        null,
        { name: "" },
        { name: 3 },
        {
          name: "Ok",
          saved: "x",
          tabs: {
            tabs: [{ path: 1 }, { path: "n.md", reading: "yes" }],
            active: 1.7,
          },
        },
        { name: "ok", tabs: {} },
      ],
    }),
  );
  const library = new WorkspaceLibrary("v1");
  expect(library.list()).toEqual([
    {
      name: "Ok",
      saved: 0,
      tabs: { tabs: [{ path: "n.md", reading: false }], active: 1 },
      layout: null,
    },
  ]);
  expect(library.active).toBeNull();
  localStorage.setItem(workspacesKey("v2"), "{broken");
  expect(new WorkspaceLibrary("v2").list()).toEqual([]);
});

it("keeps split groups of a saved workspace", () => {
  const library = new WorkspaceLibrary("v1");
  const split = {
    tabs: [{ path: "b.md", reading: true }],
    active: 0,
    groups: [
      { tabs: [{ path: "a.md", reading: false }], active: 0 },
      { tabs: [{ path: "b.md", reading: true }], active: 0 },
    ],
    split: { direction: "row", children: [{ group: 0 }, { group: 1 }] },
    group: 1,
  };
  library.save(namedWorkspace("Split", split, null));
  expect(new WorkspaceLibrary("v1").get("Split")!.tabs).toEqual(split);
});

it("does not keep the state of a refused write", () => {
  const library = new WorkspaceLibrary("v1", {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
  });
  expect(() => library.save(namedWorkspace("A", tabs("a.md"), null))).toThrow(
    "quota",
  );
  expect(library.list()).toEqual([]);
});

it("reads the pop-out note from the query string only", () => {
  expect(popoutPath("?popout=Ordner%2FNotiz.md")).toBe("Ordner/Notiz.md");
  expect(popoutPath("")).toBeNull();
  expect(popoutPath("?other=1")).toBeNull();
});
