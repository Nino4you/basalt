import { describe, expect, it } from "vitest";
import { VaultAdapter } from "../../src/compat/adapter";
import type { FileEntry, FileStats } from "../../src/compat/files";
import type { VaultStoragePort } from "../../src/compat/storage-port";
import { Vault } from "../../src/compat/vault";

interface Stored {
  data: Uint8Array;
  stat: FileStats;
}

class Port implements VaultStoragePort {
  readonly vaultId = "adapter-test";
  readonly files = new Map<string, Stored>();
  readonly folders = new Set<string>();
  private clock = 0;

  async snapshot(): Promise<FileEntry[]> {
    return [
      ...[...this.folders].map((path): FileEntry => ({ path, kind: "folder" })),
      ...[...this.files].map(([path, { stat }]): FileEntry => ({
        path,
        kind: "file",
        stat: { ...stat },
      })),
    ];
  }

  async read(path: string) {
    const stored = this.files.get(path);
    if (!stored) throw new Error(`ENOENT ${path}`);
    return {
      bytes: new Uint8Array(stored.data),
      version: String(stored.stat.mtime),
      stat: { ...stored.stat },
    };
  }

  async create(path: string, bytes: Uint8Array) {
    if (this.files.has(path)) throw new Error(`EEXIST ${path}`);
    const at = ++this.clock;
    const data = new Uint8Array(bytes);
    this.files.set(path, {
      data,
      stat: { ctime: at, mtime: at, size: data.byteLength },
    });
    return { version: String(at), stat: { ...this.files.get(path)!.stat } };
  }

  async write(path: string, bytes: Uint8Array) {
    const stored = this.files.get(path);
    if (!stored) throw new Error(`ENOENT ${path}`);
    const at = ++this.clock;
    const data = new Uint8Array(bytes);
    stored.data = data;
    stored.stat = { ...stored.stat, mtime: at, size: data.byteLength };
    return { version: String(at), stat: { ...stored.stat } };
  }

  async mkdir(path: string): Promise<void> {
    if (this.folders.has(path) || this.files.has(path))
      throw new Error(`EEXIST ${path}`);
    this.folders.add(path);
  }

  async remove(path: string, expectedVersion: string): Promise<void> {
    const stored = this.files.get(path);
    if (!stored || String(stored.stat.mtime) !== expectedVersion)
      throw new Error("Version conflict");
    this.files.delete(path);
  }
}

async function harness() {
  const port = new Port();
  port.folders.add("Basalt");
  port.folders.add("Basalt/Plugins");
  port.folders.add("Basalt/Plugins/ink");
  const vault = new Vault(port, "Vault");
  await vault.initialize();
  return { port, vault, adapter: new VaultAdapter(vault, "/tmp/vault") };
}

describe("vault adapter", () => {
  it("maps Obsidian plugin paths onto the visible Basalt plugin folder", async () => {
    const { adapter, port } = await harness();
    const path = ".obsidian/plugins/ink/models/model.onnx";
    expect(await adapter.exists(path)).toBe(false);
    await adapter.writeBinary(path, Uint8Array.of(1, 2, 3).buffer);
    expect(port.files.has("Basalt/Plugins/ink/models/model.onnx")).toBe(true);
    expect(await adapter.exists(path)).toBe(true);
    expect(await adapter.stat(path)).toMatchObject({
      type: "file",
      size: 3,
    });
    expect(Array.from(new Uint8Array(await adapter.readBinary(path)))).toEqual([
      1, 2, 3,
    ]);

    await adapter.write(path, "text");
    expect(await adapter.read(path)).toBe("text");
    expect(await adapter.list(".obsidian/plugins/ink/models")).toEqual({
      files: [".obsidian/plugins/ink/models/model.onnx"],
      folders: [],
    });
    expect(await adapter.stat(".obsidian/plugins/ink")).toMatchObject({
      type: "folder",
    });
    await expect(adapter.read(".obsidian/plugins/ink/missing")).rejects.toThrow(
      /not found/,
    );
  });

  it("maps other config dir paths onto Basalt/Config", async () => {
    const { adapter, port } = await harness();
    // Iconize's startup check: `${iconPacksPath}/` with a trailing slash.
    expect(await adapter.exists(".obsidian/icons/")).toBe(false);
    await adapter.mkdir(".obsidian/icons/");
    expect(port.folders.has("Basalt/Config/icons")).toBe(true);
    await adapter.write(".obsidian/icons/octicons/Desk.svg", "<svg/>");
    expect(port.files.has("Basalt/Config/icons/octicons/Desk.svg")).toBe(true);
    expect(await adapter.list(".obsidian/icons/octicons")).toEqual({
      files: [".obsidian/icons/octicons/Desk.svg"],
      folders: [],
    });
    expect(await adapter.list(".obsidian/icons")).toEqual({
      files: [],
      folders: [".obsidian/icons/octicons"],
    });
    expect(await adapter.read(".obsidian/icons/octicons/Desk.svg")).toBe(
      "<svg/>",
    );
    await expect(adapter.read(".obsidian/app.json")).rejects.toThrow(
      /not found/,
    );
    expect(() =>
      adapter.getResourcePath(".obsidian/icons/octicons/Desk.svg"),
    ).toThrow(/only available for plugin folders/);
  });

  it("accepts the slash forms Obsidian's normalizePath removes", async () => {
    const { adapter, port } = await harness();
    await adapter.write("/Notes//A.md/", "a");
    expect(port.files.has("Notes/A.md")).toBe(true);
    expect(await adapter.read("Notes/A.md")).toBe("a");
    expect(await adapter.exists("/")).toBe(true);
    expect(await adapter.exists("Notes/")).toBe(true);
    expect(await adapter.exists(".obsidian/plugins/ink/")).toBe(true);
  });

  it("refuses folder mutations", async () => {
    const { adapter } = await harness();
    await expect(adapter.remove("Basalt/Plugins/ink")).rejects.toThrow(
      /not found/,
    );
    await expect(
      adapter.rename("Basalt/Plugins/ink", "Basalt/Plugins/other"),
    ).rejects.toThrow(/not found/);
    expect(() => adapter.getResourcePath("Basalt/Plugins/ink/a.png")).toThrow(
      /No resource URLs are available/,
    );
  });

  it("rejects malformed and hidden paths before reads, writes or URLs", async () => {
    const { adapter, port } = await harness();
    for (const path of [
      "../file",
      "/../file",
      "a/../file",
      "a//../file",
      "a/./file",
      "./file",
      "a\\file",
      "a\u0000file",
      ".obsidian/plugins/ink/../../secret",
      ".obsidian/plugins/ink/.secret",
      ".basalt/history/secret",
      ".obsidian/../secret",
      ".obsidian/icons/.git/config",
      ".obsidian/plugins/Bad/main.js",
    ]) {
      await expect(adapter.write(path, "x")).rejects.toThrow();
      expect(() => adapter.getResourcePath(path)).toThrow();
    }
    expect(port.files.size).toBe(0);
  });

  it("uses the same backup-aware file operations through the adapter", async () => {
    const { adapter } = await harness();
    await adapter.write("A.md", "kept");
    await adapter.rename("A.md", "B.md");
    expect(await adapter.exists("A.md")).toBe(false);
    expect(await adapter.read("B.md")).toBe("kept");
    await adapter.remove("B.md");
    expect(await adapter.exists("B.md")).toBe(false);
  });

  it("creates nested folders only when needed", async () => {
    const { adapter, port } = await harness();
    await adapter.mkdir(".obsidian/plugins/ink/deep/nested");
    expect(port.folders.has("Basalt/Plugins/ink/deep")).toBe(true);
    expect(port.folders.has("Basalt/Plugins/ink/deep/nested")).toBe(true);
    await adapter.mkdir(".obsidian/plugins/ink/deep/nested");
    expect(
      [...port.folders].filter((path) => path.endsWith("nested")),
    ).toHaveLength(1);
  });
});
