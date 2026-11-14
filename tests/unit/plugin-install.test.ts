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
