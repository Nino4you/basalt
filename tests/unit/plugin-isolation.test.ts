import { EditorState } from "@codemirror/state";
import { beforeEach, expect, it, vi } from "vitest";
import { Editor } from "../../src/compat/editor-adapter";
import { EditorExtensionRegistry } from "../../src/compat/editor-extensions";
import type { FileEntry, FileStats } from "../../src/compat/files";
import { fetchRequestUrl, nativeRequestUrl } from "../../src/compat/request";
import { CompatibilitySession } from "../../src/compat/session";
import type { VaultStoragePort } from "../../src/compat/storage-port";

beforeEach(() => localStorage.clear());

class MemoryPort implements VaultStoragePort {
  readonly files = new Map<
    string,
    { bytes: Uint8Array; stat: FileStats; version: number }
  >();
  readonly folders = new Set<string>();
  private clock = 0;

  constructor(readonly vaultId: string) {}

  seed(path: string, text: string): void {
    const bytes = new TextEncoder().encode(text);
    const at = ++this.clock;
    this.files.set(path, {
      bytes,
      version: at,
      stat: { ctime: at, mtime: at, size: bytes.byteLength },
    });
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++)
      this.folders.add(parts.slice(0, index).join("/"));
  }

  text(path: string): string | null {
    const file = this.files.get(path);
    return file ? new TextDecoder().decode(file.bytes) : null;
  }

  async snapshot(): Promise<FileEntry[]> {
    return [
      ...[...this.folders].map((path) => ({ path, kind: "folder" as const })),
      ...[...this.files].map(([path, { stat }]) => ({
        path,
        kind: "file" as const,
        stat: { ...stat },
      })),
    ];
  }

  async read(path: string) {
    const file = this.files.get(path);
    if (!file) throw new Error(`ENOENT ${path}`);
    return {
      bytes: file.bytes.slice(),
      version: String(file.version),
      stat: { ...file.stat },
    };
  }

  async create(path: string, bytes: Uint8Array) {
    if (this.files.has(path)) throw new Error(`EEXIST ${path}`);
    this.seed(path, new TextDecoder().decode(bytes));
    const file = this.files.get(path)!;
    return { version: String(file.version), stat: { ...file.stat } };
  }

  async write(path: string, bytes: Uint8Array, expected: string) {
    const file = this.files.get(path);
    if (!file || String(file.version) !== expected)
      throw new Error(`Conflict ${path}`);
    this.seed(path, new TextDecoder().decode(bytes));
    const next = this.files.get(path)!;
    return { version: String(next.version), stat: { ...next.stat } };
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }
}

const PLUGIN = `
const { Plugin } = require("obsidian");
module.exports = class extends Plugin {
  async onload() {}
};
`;

function seedPlugin(port: MemoryPort) {
  port.seed(
    "Basalt/Plugins/fixture/manifest.json",
    JSON.stringify({
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
      minAppVersion: "1.0.0",
    }),
  );
  port.seed("Basalt/Plugins/fixture/main.js", PLUGIN);
  port.seed("Note.md", "# Note");
}

async function open(port: MemoryPort) {
  const editor = new Editor({
    state: EditorState.create({ doc: "" }),
    hasFocus: false,
    scrollDOM: document.createElement("div"),
    dispatch: () => {},
    focus: () => {},
    requestMeasure: () => {},
  });
  return CompatibilitySession.create({
    vaultId: port.vaultId,
    name: port.vaultId,
    mobile: false,
    editor,
    extensions: new EditorExtensionRegistry(() => {}),
    container: document.createElement("div"),
    navigate: async () => {},
    port,
  });
}

it("keeps other .obsidian config in Basalt/Config, hidden from vault content", async () => {
  const port = new MemoryPort("config");
  seedPlugin(port);
  const session = await open(port);
  try {
    const adapter = session.vault.adapter as {
      read(path: string): Promise<string>;
      write(path: string, data: string): Promise<void>;
      exists(path: string): Promise<boolean>;
      rename(from: string, to: string): Promise<void>;
    };
    const created = vi.fn();
    session.vault.on("create", created);
    await adapter.write(".obsidian/icons/pack/Icon.svg", "<svg/>");
    await expect(
      adapter.rename(".obsidian/icons/pack/Icon.svg", "Icon.svg"),
    ).rejects.toThrow(/between plugin configuration and vault content/);
    expect(port.text("Basalt/Config/icons/pack/Icon.svg")).toBe("<svg/>");
    expect(await adapter.exists(".obsidian/icons/")).toBe(true);
    expect(await adapter.read(".obsidian/icons/pack/Icon.svg")).toBe("<svg/>");
    expect(created).not.toHaveBeenCalled();
    expect(await adapter.exists("Basalt/Config/icons/pack/Icon.svg")).toBe(
      false,
    );
    expect(
      session.vault
        .getAllLoadedFiles()
        .some((file) => file.path.startsWith("Basalt/Config")),
    ).toBe(false);
    await expect(
      session.vault.create("Basalt/Config/x.md", "x"),
    ).rejects.toThrow(/outside the vault content/);
  } finally {
    await session.dispose();
  }
});

it("hides the plugin folder from vault content but keeps it reachable for the loader and adapter", async () => {
  const port = new MemoryPort("isolated");
  seedPlugin(port);
  const session = await open(port);
  try {
    const paths = session.vault.getAllLoadedFiles().map((file) => file.path);
    expect(paths).toContain("Note.md");
    expect(paths.some((path) => path.startsWith("Basalt/Plugins"))).toBe(false);
    expect(session.vault.getFileByPath("Basalt/Plugins/fixture/main.js")).toBe(
      null,
    );
    await expect(
      session.vault.create("Basalt/Plugins/fixture/x.md", "x"),
    ).rejects.toThrow(/outside the vault content/);

    expect((await session.bundleHost.list()).map((entry) => entry.id)).toEqual([
      "fixture",
    ]);
    await session.bundleHost.enable("fixture");

    const adapter = session.vault.adapter as {
      read(path: string): Promise<string>;
      write(path: string, data: string): Promise<void>;
      exists(path: string): Promise<boolean>;
      rename(from: string, to: string): Promise<void>;
    };
    const created = vi.fn();
    session.vault.on("create", created);
    await adapter.write(".obsidian/plugins/fixture/models/a.bin", "model");
    expect(port.text("Basalt/Plugins/fixture/models/a.bin")).toBe("model");
    expect(await adapter.read(".obsidian/plugins/fixture/models/a.bin")).toBe(
      "model",
    );
    // Sync plugins listen to vault events; plugin files must not appear there.
    expect(created).not.toHaveBeenCalled();
    expect(await adapter.exists("Basalt/Plugins/fixture/main.js")).toBe(false);
    await expect(
      adapter.rename(".obsidian/plugins/fixture/models/a.bin", "a.bin"),
    ).rejects.toThrow(/between plugin configuration and vault content/);

    port.seed("Basalt/Plugins/other/manifest.json", "{}");
    port.seed("Later.md", "later");
    await session.refresh();
    expect(session.vault.getFileByPath("Later.md")).not.toBe(null);
    expect((await session.bundleHost.list()).map((entry) => entry.id)).toEqual([
      "fixture",
      "other",
    ]);
  } finally {
    await session.dispose();
  }
});

it("scopes app localStorage per vault", async () => {
  const first = new MemoryPort("first");
  const second = new MemoryPort("second");
  first.seed("A.md", "a");
  second.seed("B.md", "b");
  const a = await open(first);
  const b = await open(second);
  try {
    a.saveLocalStorage("sample-sync-token", "token-a");
    expect(a.loadLocalStorage("sample-sync-token")).toBe("token-a");
    expect(b.loadLocalStorage("sample-sync-token")).toBe(null);
    b.saveLocalStorage("sample-sync-token", "token-b");
    expect(a.loadLocalStorage("sample-sync-token")).toBe("token-a");
    a.saveLocalStorage("sample-sync-token", null);
    expect(a.loadLocalStorage("sample-sync-token")).toBe(null);
    expect(b.loadLocalStorage("sample-sync-token")).toBe("token-b");
  } finally {
    await a.dispose();
    await b.dispose();
  }
});

it("sends requestUrl through the native command with Obsidian semantics", async () => {
  const run = vi.fn(async (_command: string, _args?: unknown) => ({
    status: 201,
    headers: { "content-type": "application/json" },
    body: btoa('{"ok":true}'),
  }));
  const requestUrl = nativeRequestUrl(run);
  const response = await requestUrl({
    url: "https://sync.example/api",
    method: "post",
    contentType: "application/json",
    body: '{"a":1}',
    headers: { Authorization: "Bearer t" },
  });
  expect(run).toHaveBeenCalledWith("plugin_request_url", {
    request: {
      url: "https://sync.example/api",
      method: "POST",
      headers: {
        Authorization: "Bearer t",
        "Content-Type": "application/json",
      },
      body: btoa('{"a":1}'),
    },
  });
  expect(response.status).toBe(201);
  expect(response.json).toEqual({ ok: true });
  expect(response.text).toBe('{"ok":true}');
  expect([...new Uint8Array(response.arrayBuffer)]).toEqual([
    ...new TextEncoder().encode('{"ok":true}'),
  ]);

  const binary = vi.fn(async (_command: string, args?: unknown) => {
    expect((args as { request: { body: string } }).request.body).toBe(
      btoa(String.fromCharCode(0, 255)),
    );
    return { status: 404, headers: {}, body: "" };
  });
  const bodyBuffer = new Uint8Array([0, 255]).buffer;
  // Obsidian throws for status >= 400 unless `throw: false`.
  await expect(
    nativeRequestUrl(binary)({ url: "https://x.example", body: bodyBuffer }),
  ).rejects.toThrow(/status 404/);
  const quiet = await nativeRequestUrl(binary)({
    url: "https://x.example",
    body: bodyBuffer,
    throw: false,
  });
  expect(quiet.status).toBe(404);
  expect(() => quiet.json).toThrow();

  await expect(
    nativeRequestUrl(async () => ({ status: "200" }))("https://x.example"),
  ).rejects.toThrow(/invalid response/);
});

it("applies the same semantics to the browser fetch transport", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response("nope", { status: 500 }));
  try {
    await expect(fetchRequestUrl("https://x.example")).rejects.toThrow(
      /status 500/,
    );
    const response = await fetchRequestUrl({
      url: "https://x.example",
      throw: false,
    });
    expect(response.status).toBe(500);
    expect(response.text).toBe("nope");
  } finally {
    fetchMock.mockRestore();
  }
});
