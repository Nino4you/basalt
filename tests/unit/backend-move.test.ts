import { beforeEach, expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: run, isTauri: () => true }));
import { backend } from "../../src/backend";

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValueOnce({
    data: "/wA=",
    version: "v1",
    stat: { ctime: 1, mtime: 2, size: 2 },
  });
});

it("moves exact binary bytes before deleting the observed version in the same vault", async () => {
  run.mockResolvedValueOnce({
    version: "copy",
    stat: { ctime: 3, mtime: 3, size: 2 },
  });
  run.mockResolvedValueOnce(undefined);

  await backend.move("Sheet.xlsx", "Folder/Sheet.xlsx", undefined, "original");

  expect(run.mock.calls).toEqual([
    ["plugin_vault_read", { vaultId: "original", path: "Sheet.xlsx" }],
    [
      "plugin_vault_create",
      { vaultId: "original", path: "Folder/Sheet.xlsx", data: "/wA=" },
    ],
    [
      "plugin_vault_delete",
      { vaultId: "original", path: "Sheet.xlsx", expectedVersion: "v1" },
    ],
  ]);
});

it("does not create or delete anything when the loaded note changed externally", async () => {
  run.mockReset();
  run.mockResolvedValueOnce({
    data: "bmV3",
    version: "v2",
    stat: { ctime: 1, mtime: 2, size: 3 },
  });

  await expect(
    backend.move("Note.md", "Folder/Note.md", "old", "vault"),
  ).rejects.toThrow("außerhalb");
  expect(run).toHaveBeenCalledTimes(1);
});

it("leaves the source untouched if exclusive destination creation fails", async () => {
  run.mockRejectedValueOnce(new Error("Destination exists"));

  await expect(
    backend.move("Sheet.xlsx", "Folder/Sheet.xlsx", undefined, "vault"),
  ).rejects.toThrow("Destination exists");
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenLastCalledWith("plugin_vault_create", {
    vaultId: "vault",
    path: "Folder/Sheet.xlsx",
    data: "/wA=",
  });
});

it("keeps the destination copy and reports its path if source deletion fails", async () => {
  run.mockResolvedValueOnce({
    version: "copy",
    stat: { ctime: 3, mtime: 3, size: 2 },
  });
  const conflict = new Error("Source changed after reading");
  run.mockRejectedValueOnce(conflict);

  await expect(
    backend.move("Sheet.xlsx", "Folder/Sheet.xlsx", undefined, "vault"),
  ).rejects.toMatchObject({
    message: expect.stringContaining(
      "Kopie unter „Folder/Sheet.xlsx“ bleibt erhalten",
    ),
    cause: conflict,
  });
  expect(run).toHaveBeenCalledTimes(3);
  expect(run).toHaveBeenLastCalledWith("plugin_vault_delete", {
    vaultId: "vault",
    path: "Sheet.xlsx",
    expectedVersion: "v1",
  });
});
