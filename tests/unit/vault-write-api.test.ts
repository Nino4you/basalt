import { expect, it } from "vitest";
import { memoryVault } from "../helpers/vault-store";

it("appends text and keeps the appended content after a reread", async () => {
  const vault = await memoryVault({ "Note.md": "Start" });
  const file = vault.getFileByPath("Note.md")!;

  await vault.append(file, "\nMehr");

  expect(await vault.read(file)).toBe("Start\nMehr");
});

it("trashes a file so it leaves the index and cannot be read", async () => {
  const vault = await memoryVault({ "Note.md": "Inhalt" });
  const file = vault.getFileByPath("Note.md")!;

  await vault.trash(file, true);

  expect(vault.getFileByPath("Note.md")).toBeNull();
  await expect(vault.read(file)).rejects.toThrow();
});
