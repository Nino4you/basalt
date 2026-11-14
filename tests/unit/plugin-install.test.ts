import { afterEach, expect, it, vi } from "vitest";
import type { App } from "../../src/app/app";
import { installFromFiles } from "../../src/app/plugin-install";
import { memoryVault } from "../helpers/vault-store";

afterEach(() => document.body.replaceChildren());

const file = (name: string, text: string) =>
  ({ name, text: async () => text }) as unknown as File;

/** Just the parts of App and its plugin session that installing touches. */
async function fakeApp(enabled = false) {
  const configVault = await memoryVault({});
  const calls: string[] = [];
  const session = {
    configVault,
    bundleHost: {
      list: async () => {
        const manifest = configVault.getFileByPath(
          "Basalt/Plugins/mine/manifest.json",
        );
        return manifest
          ? [
              {
                id: "mine",
                manifest: JSON.parse(await configVault.read(manifest)),
                error: null,
              },
            ]
          : [];
      },
      isEnabled: () => enabled,
      disable: async (id: string) => void calls.push(`disable ${id}`),
      enable: async (id: string) => void calls.push(`enable ${id}`),
    },
    refresh: async () => void calls.push("refresh"),
    saveEnabledPlugins: () => calls.push("save"),
  };
  const app = {
    compatibility: session,
    pluginErrors: new Map<string, string>(),
    releasePluginUi: () => calls.push("release"),
    refreshPluginUi: () => calls.push("refresh ui"),
    report: vi.fn(),
  } as unknown as App;
  return { app, configVault, calls };
}

const manifest = (version: string) =>
  JSON.stringify({ id: "mine", name: "My plugin", version });

async function answer(button: "Installieren" | "Aktualisieren" | "Abbrechen") {
  await vi.waitFor(() => {
    const dialog = document.querySelector(".mod-plugin-confirm");
    if (!dialog) throw new Error("no confirmation yet");
  });
  const target = [
    ...document.querySelectorAll<HTMLButtonElement>(
      ".mod-plugin-confirm button",
    ),
  ].find((element) => element.textContent === button);
  target!.click();
}

it("asks, warns and installs picked files without enabling them", async () => {
  const { app, configVault, calls } = await fakeApp();
  const changed = vi.fn();
  const done = installFromFiles(
    app,
    [
      file("manifest.json", manifest("1.0.0")),
      file("main.js", "module.exports = {}"),
      file("notes.txt", "ignored"),
    ],
    changed,
  );
  await vi.waitFor(() =>
    expect(document.querySelector(".plugin-warning")?.textContent).toContain(
      "nicht abgeschottet",
    ),
  );
  await answer("Installieren");
  await done;
  expect(changed).toHaveBeenCalled();
  expect(
    await configVault.read(
      configVault.getFileByPath("Basalt/Plugins/mine/main.js")!,
    ),
  ).toBe("module.exports = {}");
  expect(calls).not.toContain("enable mine");
  expect(app.report).not.toHaveBeenCalled();
});

it("writes nothing when the user cancels", async () => {
  const { app, configVault } = await fakeApp();
  const changed = vi.fn();
  const done = installFromFiles(
    app,
    [file("manifest.json", manifest("1.0.0")), file("main.js", "x")],
    changed,
  );
  await answer("Abbrechen");
  await done;
  expect(changed).not.toHaveBeenCalled();
  expect(configVault.getFileByPath("Basalt/Plugins/mine/main.js")).toBeNull();
});

it("restarts an enabled plugin around an update", async () => {
  const { app, configVault, calls } = await fakeApp(true);
  await configVault.createFolder("Basalt");
  await configVault.createFolder("Basalt/Plugins");
  await configVault.createFolder("Basalt/Plugins/mine");
  await configVault.create(
    "Basalt/Plugins/mine/manifest.json",
    manifest("1.0.0"),
  );
  await configVault.create("Basalt/Plugins/mine/main.js", "old");
  const done = installFromFiles(
    app,
    [file("manifest.json", manifest("1.1.0")), file("main.js", "new")],
    vi.fn(),
  );
  await vi.waitFor(() =>
    expect(
      document.querySelector(".mod-plugin-confirm .modal-description")
        ?.textContent,
    ).toContain("ersetzt 1.0.0"),
  );
  await answer("Aktualisieren");
  await done;
  expect(calls.indexOf("disable mine")).toBeLessThan(
    calls.indexOf("enable mine"),
  );
  expect(
    await configVault.read(
      configVault.getFileByPath("Basalt/Plugins/mine/main.js")!,
    ),
  ).toBe("new");
});

it("needs a manifest and main.js", async () => {
  const { app } = await fakeApp();
  await installFromFiles(app, [file("main.js", "x")], vi.fn());
  expect(document.querySelector(".mod-plugin-confirm")).toBeNull();
  expect(document.body.textContent).toContain("manifest.json und main.js");
});

it("installs a picked older release from the catalog", async () => {
  const { app, configVault } = await fakeApp();
  await configVault.createFolder("Basalt");
  await configVault.createFolder("Basalt/Plugins");
  await configVault.createFolder("Basalt/Plugins/mine");
  await configVault.create(
    "Basalt/Plugins/mine/manifest.json",
    manifest("1.1.0"),
  );
  await configVault.create("Basalt/Plugins/mine/main.js", "new");
  const assets = [{ name: "manifest.json" }, { name: "main.js" }];
  const pages: Record<string, string> = {
    "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json":
      JSON.stringify([
        {
          id: "mine",
          name: "My plugin",
          author: "Me",
          description: "Mine",
          repo: "owner/mine",
        },
      ]),
    "https://api.github.com/repos/owner/mine/releases?per_page=30":
      JSON.stringify([
        { tag_name: "1.1.0", assets },
        { tag_name: "1.0.0", assets },
      ]),
    "https://raw.githubusercontent.com/owner/mine/HEAD/versions.json":
      JSON.stringify({ "1.1.0": "99.0.0", "1.0.0": "0.15.0" }),
    "https://github.com/owner/mine/releases/download/1.0.0/manifest.json":
      manifest("1.0.0"),
    "https://github.com/owner/mine/releases/download/1.0.0/main.js": "old",
  };
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    const body = pages[url];
    return new Response(body ?? "", { status: body === undefined ? 404 : 200 });
  });
  try {
    const { openPluginCatalog } = await import("../../src/app/plugin-install");
    const changed = vi.fn();
    openPluginCatalog(app, changed);
    const row = await vi.waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>(
        ".plugin-catalog-row",
      );
      if (!found) throw new Error("no catalog yet");
      return found;
    });
    row.click();
    const picker = await vi.waitFor(() => {
      const found = document.querySelector<HTMLSelectElement>(
        ".plugin-catalog-version",
      );
      if (!found || found.disabled) throw new Error("no releases yet");
      return found;
    });
    const options = [...picker.options].map((option) => option.textContent);
    expect(options[0]).toBe("Neueste Version (1.1.0)");
    expect(options[1]).toContain("installiert");
    expect(options[1]).toContain("braucht Obsidian 99.0.0");
    const action = document.querySelector<HTMLButtonElement>(
      ".plugin-catalog-details .mod-cta",
    )!;
    picker.value = "1.1.0";
    picker.dispatchEvent(new Event("change"));
    expect(action.textContent).toBe("Installiert");
    expect(action.disabled).toBe(true);
    picker.value = "1.0.0";
    picker.dispatchEvent(new Event("change"));
    expect(action.textContent).toBe("Version wechseln");
    action.click();
    await vi.waitFor(() => {
      if (document.querySelector(".mod-plugin-confirm")) return;
      expect(app.report).not.toHaveBeenCalled();
      throw new Error("no confirmation yet");
    });
    expect(
      document.querySelector(".mod-plugin-confirm")?.textContent,
    ).toContain("ältere Version");
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".mod-plugin-confirm button",
      ),
    ].find((element) => element.textContent === "Version wechseln")!;
    confirm.click();
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(
      await configVault.read(
        configVault.getFileByPath("Basalt/Plugins/mine/main.js")!,
      ),
    ).toBe("old");
    expect(fetched).not.toContain(
      "https://github.com/owner/mine/releases/latest/download/main.js",
    );
    expect(app.report).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
