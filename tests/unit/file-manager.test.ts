import { expect, it, vi } from "vitest";
import { FileManager } from "../../src/compat/file-manager";
import { Vault } from "../../src/compat/vault";
import { MemoryPort, memoryVault } from "../helpers/vault-store";

async function setup(contents: string) {
  const vault = await memoryVault({ "Note.md": contents });
  const file = vault.getFileByPath("Note.md")!;
  return { vault, file, manager: new FileManager(vault) };
}

it("changes one key and keeps comments, other keys and the body", async () => {
  const { vault, file, manager } = await setup(
    "---\ntitle: Alt\n# keep me\nnested:\n  a: 1\n---\n\nBody\n",
  );

  await manager.processFrontMatter(file, (frontmatter) => {
    expect(frontmatter.title).toBe("Alt");
    expect(frontmatter.nested).toEqual({ a: 1 });
    frontmatter.status = "offen";
  });

  const text = await vault.read(file);
  expect(text).toContain("status: offen");
  expect(text).toContain("# keep me");
  expect(text).toContain("  a: 1");
  expect(text.endsWith("Body\n")).toBe(true);
});

it("removes a key and leaves the body untouched", async () => {
  const { vault, file, manager } = await setup(
    "---\ntitle: Alt\ntags:\n  - a\n---\n\nBody\n",
  );

  await manager.processFrontMatter(file, (frontmatter) => {
    delete frontmatter.title;
  });

  const text = await vault.read(file);
  expect(text).not.toContain("title:");
  expect(text).toContain("tags:");
  expect(text.endsWith("Body\n")).toBe(true);
});

it("creates a frontmatter block when the note has none", async () => {
  const { vault, file, manager } = await setup("Nur Text\n");

  await manager.processFrontMatter(file, (frontmatter) => {
    frontmatter.tags = ["a", "b"];
  });

  expect(await vault.read(file)).toBe(
    "---\ntags:\n  - a\n  - b\n---\n\nNur Text\n",
  );
});

it("writes nothing when the callback throws", async () => {
  const original = "---\ntitle: Alt\n---\n\nBody\n";
  const { vault, file, manager } = await setup(original);

  await expect(
    manager.processFrontMatter(file, () => {
      throw new Error("Stop");
    }),
  ).rejects.toThrow("Stop");

  expect(await vault.read(file)).toBe(original);
});

it("rejects invalid YAML without touching the note", async () => {
  const original = "---\nfoo: [\n---\n\nBody\n";
  const { vault, file, manager } = await setup(original);

  await expect(
    manager.processFrontMatter(file, (frontmatter) => {
      frontmatter.foo = "bar";
    }),
  ).rejects.toThrow();

  expect(await vault.read(file)).toBe(original);
});

it("fills an empty frontmatter block instead of adding a second one", async () => {
  const { vault, file, manager } = await setup("---\n---\n\nBody\n");

  await manager.processFrontMatter(file, (frontmatter) => {
    frontmatter.status = "offen";
  });

  expect(await vault.read(file)).toBe("---\nstatus: offen\n---\n\nBody\n");
});

it("does not rewrite the note when the callback changes nothing", async () => {
  const original = "---\n---\n\nBody\n";
  const { vault, file, manager } = await setup(original);

  await manager.processFrontMatter(file, () => {});

  expect(await vault.read(file)).toBe(original);
});

it("preserves both concurrent frontmatter changes", async () => {
  const { vault, file, manager } = await setup(
    "---\ntitle: Alt\n---\n\nBody\n",
  );

  await Promise.all([
    manager.processFrontMatter(file, (frontmatter) => {
      frontmatter.title = "Neu";
    }),
    manager.processFrontMatter(file, (frontmatter) => {
      frontmatter.status = "offen";
    }),
  ]);

  const text = await vault.read(file);
  expect(text).toContain("title: Neu");
  expect(text).toContain("status: offen");
  expect(text.endsWith("Body\n")).toBe(true);
});

it("rejects an external change after reading without retrying the callback", async () => {
  const port = new MemoryPort({ "Note.md": "---\ntitle: Alt\n---\n\nBody\n" });
  const vault = new Vault(port, "Vault");
  await vault.initialize();
  const file = vault.getFileByPath("Note.md")!;
  const read = port.read.bind(port);
  const external = "---\ntitle: External\n---\n\nChanged body\n";
  vi.spyOn(port, "read").mockImplementationOnce(async (path) => {
    const snapshot = await read(path);
    await port.write(
      path,
      new TextEncoder().encode(external),
      snapshot.version,
    );
    return snapshot;
  });
  const callback = vi.fn((frontmatter: Record<string, unknown>) => {
    frontmatter.status = "offen";
  });

  await expect(
    new FileManager(vault).processFrontMatter(file, callback),
  ).rejects.toThrow("conflict");

  expect(callback).toHaveBeenCalledTimes(1);
  expect(await vault.read(file)).toBe(external);
});

it("renameFile rewrites links to the file when the user wants that", async () => {
  const files = {
    "Plan.md": "# Plan",
    "Home.md": "See [[Plan]] and [x](Plan.md#Goals).",
    "Other.md": "Nothing here.",
    "Board.canvas": JSON.stringify({
      nodes: [
        {
          id: "a",
          type: "file",
          file: "Plan.md",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      ],
      edges: [],
    }),
  };
  const vault = await memoryVault(files);
  const manager = new FileManager(vault, () => true);
  await manager.renameFile(
    vault.getFileByPath("Plan.md")!,
    "Projects/Roadmap.md",
  );
  const read = (path: string) => vault.read(vault.getFileByPath(path)!);
  expect(vault.getFileByPath("Plan.md")).toBeNull();
  expect(await read("Projects/Roadmap.md")).toBe("# Plan");
  expect(await read("Home.md")).toBe(
    "See [[Roadmap]] and [x](Roadmap.md#Goals).",
  );
  expect(await read("Other.md")).toBe("Nothing here.");
  expect(JSON.parse(await read("Board.canvas")).nodes[0].file).toBe(
    "Projects/Roadmap.md",
  );

  const plain = await memoryVault(files);
  await new FileManager(plain).renameFile(
    plain.getFileByPath("Plan.md")!,
    "Roadmap.md",
  );
  expect(await plain.read(plain.getFileByPath("Home.md")!)).toBe(
    files["Home.md"],
  );
});
