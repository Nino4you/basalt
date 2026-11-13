import { beforeEach, expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: run, isTauri: () => true }));
import { backend } from "../../src/backend";

beforeEach(() => run.mockReset());

it("pins binary deletion to its vault and exact read version", async () => {
  run.mockResolvedValueOnce({
    id: "other",
    files: [],
    platform: "linux",
    name: "Other",
  });
  await backend.info();
  run.mockResolvedValueOnce({
    data: "/wA=",
    version: "v1",
    stat: { ctime: 1, mtime: 2, size: 2 },
  });
  run.mockResolvedValueOnce(undefined);
  await backend.remove("Sheet.xlsx", undefined, "original");
  expect(run).toHaveBeenNthCalledWith(2, "plugin_vault_read", {
    vaultId: "original",
    path: "Sheet.xlsx",
  });
  expect(run).toHaveBeenNthCalledWith(3, "plugin_vault_delete", {
    vaultId: "original",
    path: "Sheet.xlsx",
    expectedVersion: "v1",
  });
});

it("does not delete a note that changed outside the editor", async () => {
  run.mockResolvedValueOnce({
    data: "bmV3",
    version: "v2",
    stat: { ctime: 1, mtime: 2, size: 3 },
  });
  await expect(backend.remove("Note.md", "old", "vault")).rejects.toThrow(
    "außerhalb",
  );
  expect(run).toHaveBeenCalledTimes(1);
});

it("surfaces a version conflict after reading instead of retrying deletion", async () => {
  run.mockResolvedValueOnce({
    data: "bmV3",
    version: "v2",
    stat: { ctime: 1, mtime: 2, size: 3 },
  });
  run.mockRejectedValueOnce(new Error("version conflict"));
  await expect(backend.remove("Note.md", "new", "vault")).rejects.toThrow(
    "version conflict",
  );
  expect(run).toHaveBeenCalledTimes(2);
});
