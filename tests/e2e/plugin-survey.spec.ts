import { test, type Page } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// Bulk survey of community plugins, driven by `node tools/plugin-survey/run.mjs`.
// That tool downloads the bundles and the official API typings into
// BASALT_PLUGIN_SURVEY; this spec loads each plugin unchanged into a fresh
// browser-demo session and records what breaks. It never runs in CI.
const root = process.env.BASALT_PLUGIN_SURVEY ?? "";
const pluginRoot = root ? join(root, "plugins") : "";
const resultRoot = root ? join(root, "results") : "";
const ids =
  pluginRoot && existsSync(pluginRoot)
    ? readdirSync(pluginRoot)
        .filter((id) => existsSync(join(pluginRoot, id, "main.js")))
        .sort()
    : [];

test.describe.configure({ mode: "parallel" });

const NOTES: Record<string, string> = {
  "Note.md":
    "---\ntags: [demo]\naliases: [Start]\n---\n# Note\n\nSee [[Other]] and #topic.\n\n- [ ] Task\n",
  "Other.md": "# Other\n\nBack to [[Note]].\n",
  "Folder/Inner.md": "# Inner\n\n```js\nconsole.log(1)\n```\n",
};

async function openSession(page: Page, files: Record<string, string>) {
  await page.goto("/tests/fixtures/vault.html");
  await page.evaluate(async (files) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [{ App }, { CompatibilitySession }, { MemoryPort }] =
      await Promise.all([
        load("/src/app/app.ts"),
        load("/src/compat/session.ts"),
        load("/tests/helpers/vault-store.ts"),
      ]);
    const app = new App(document.querySelector("#app"));
    await app.start();
    const port = new MemoryPort(files);
    const session = await CompatibilitySession.create({
      vaultId: port.vaultId,
      name: "Plugin survey",
      mobile: false,
      port,
      editor: app.editor.compat,
      extensions: app.editor.extensions,
      container: app.shell.viewContent,
      navigate: (path: string) => app.openPath(path),
      ribbonEl: app.shell.pluginRibbon,
      statusBarEl: app.shell.pluginStatus,
    });
    app.compatibility = session;
    app.bindPluginWorkspace(session);
    app.syncVisibleFiles();
    (window as any).survey = { app, session, port, missingExports: new Set() };
  }, files);
}

test("survey: API coverage against obsidian.d.ts", async ({ page }) => {
  test.skip(!root, "Run through tools/plugin-survey/run.mjs");
  const surface = JSON.parse(readFileSync(join(root, "surface.json"), "utf8"));
  await openSession(page, NOTES);
  const coverage = await page.evaluate(async (surface) => {
    const { app, session } = (window as any).survey;
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { createObsidianApi } = await load("/src/compat/obsidian-api.ts");
    const api = createObsidianApi({ app: session });
    await app.openPath("Note.md");
    const div = () => document.createElement("div");
    const manifest = {
      id: "survey-probe",
      name: "Survey probe",
      version: "1.0.0",
      minAppVersion: "1.0.0",
      author: "",
      description: "",
    };
    const make = (factory: () => unknown) => {
      try {
        return factory();
      } catch {
        return undefined;
      }
    };
    const plugin = make(() => new api.Plugin(session, manifest));
    // Live objects that plugins actually receive; everything else is
    // checked on the exported class's prototype.
    const live: Record<string, unknown> = {
      App: session,
      Vault: session.vault,
      DataAdapter: session.vault.adapter,
      FileSystemAdapter: session.vault.adapter,
      Workspace: session.workspace,
      MetadataCache: session.metadataCache,
      FileManager: session.fileManager,
      Plugin: plugin,
      Editor: session.workspace.activeEditor?.editor,
      MarkdownView: make(() =>
        session.workspace.getActiveViewOfType(api.MarkdownView),
      ),
      WorkspaceLeaf: make(() => session.workspace.getMostRecentLeaf()),
      TFile: session.vault.getFileByPath("Note.md"),
      TFolder: session.vault.getRoot(),
      Component: make(() => new api.Component()),
      Events: make(() => new api.Events()),
      Scope: make(() => new api.Scope()),
      Menu: make(() => new api.Menu()),
      Modal: make(() => new api.Modal(session)),
      Setting: make(() => new api.Setting(div())),
      PluginSettingTab: make(() => new api.PluginSettingTab(session, plugin)),
      ButtonComponent: make(() => new api.ButtonComponent(div())),
      ExtraButtonComponent: make(() => new api.ExtraButtonComponent(div())),
      TextComponent: make(() => new api.TextComponent(div())),
      TextAreaComponent: make(() => new api.TextAreaComponent(div())),
      ToggleComponent: make(() => new api.ToggleComponent(div())),
      DropdownComponent: make(() => new api.DropdownComponent(div())),
      SliderComponent: make(() => new api.SliderComponent(div())),
      SearchComponent: make(() => new api.SearchComponent(div())),
      ColorComponent: make(() => new api.ColorComponent(div())),
      MomentFormatComponent: make(() => new api.MomentFormatComponent(div())),
    };
    const globals: Record<string, unknown> = {
      ObjectConstructor: Object,
      ArrayConstructor: Array,
      Array: Array.prototype,
      Math,
      StringConstructor: String,
      String: String.prototype,
      NumberConstructor: Number,
      Node: Node.prototype,
      Element: Element.prototype,
      HTMLElement: HTMLElement.prototype,
      SVGElement: SVGElement.prototype,
      DocumentFragment: DocumentFragment.prototype,
      Document: Document.prototype,
      UIEvent: UIEvent.prototype,
      Touch: typeof Touch === "function" ? Touch.prototype : undefined,
      window,
      Window: window,
    };
    type Member = {
      name: string;
      kind: string;
      static: boolean;
      owner?: string;
    };
    const flatten = (name: string, seen = new Set<string>()): Member[] => {
      const entry = surface.types[name];
      if (!entry || seen.has(name)) return [];
      seen.add(name);
      const members = new Map<string, Member>(
        entry.members.map((member: Member) => [
          `${member.static}:${member.name}`,
          { ...member, owner: name },
        ]),
      );
      for (const parent of entry.extends)
        for (const member of flatten(parent.replace(/<.*$/, ""), seen))
          if (!members.has(`${member.static}:${member.name}`))
            members.set(`${member.static}:${member.name}`, member);
      return [...members.values()];
    };
    const has = (target: unknown, name: string) =>
      target !== null &&
      target !== undefined &&
      (typeof target === "object" || typeof target === "function") &&
      name in (target as object);
    const missing: {
      type: string;
      member: string;
      kind: string;
      owner: string;
    }[] = [];
    const unchecked: string[] = [];
    let checked = 0;
    let present = 0;
    const exportsMissing = surface.exports
      .filter((entry: { name: string }) => !(entry.name in api))
      .map((entry: { name: string; kind: string }) => entry);
    for (const [name, entry] of Object.entries<any>(surface.types)) {
      const target = live[name];
      const ctor = (api as Record<string, unknown>)[name];
      const isLive = target !== undefined && target !== null;
      if (!isLive && entry.kind === "interface") continue;
      if (!isLive && typeof ctor !== "function") continue;
      for (const member of flatten(name)) {
        let ok: boolean | null;
        if (member.static) ok = has(ctor, member.name);
        else if (isLive) ok = has(target, member.name);
        else if (member.kind === "method")
          ok = has((ctor as { prototype?: unknown }).prototype, member.name);
        else
          ok = has((ctor as { prototype?: unknown }).prototype, member.name)
            ? true
            : null;
        if (ok === null) {
          unchecked.push(`${name}.${member.name}`);
          continue;
        }
        checked += 1;
        if (ok) present += 1;
        else
          missing.push({
            type: name,
            member: member.name,
            kind: member.kind,
            owner: member.owner ?? name,
          });
      }
    }
    for (const [name, members] of Object.entries<Member[]>(surface.globals)) {
      const target = globals[name];
      if (target === undefined) continue;
      for (const member of members) {
        checked += 1;
        if (has(target, member.name)) present += 1;
        else
          missing.push({
            type: `global ${name}`,
            member: member.name,
            kind: member.kind,
            owner: `global ${name}`,
          });
      }
    }
    // Names that some host object, DOM or JS built-in already provides:
    // a plugin using one of them says nothing about a gap.
    const known = new Set<string>();
    const collect = (target: unknown) => {
      for (
        let object = target;
        object && object !== Object.prototype;
        object = Object.getPrototypeOf(object)
      )
        for (const key of Object.getOwnPropertyNames(object)) known.add(key);
    };
    for (const target of [
      ...Object.values(live),
      ...Object.values(globals),
      api,
      ...Object.values(api).map(
        (value) => (value as { prototype?: unknown })?.prototype,
      ),
      HTMLInputElement.prototype,
      HTMLCanvasElement.prototype,
      Promise.prototype,
      Map.prototype,
      Set.prototype,
      Object,
      Object.prototype,
      Function.prototype,
      Number.prototype,
      JSON,
      console,
      document,
      navigator,
      localStorage,
      Event.prototype,
      KeyboardEvent.prototype,
      MouseEvent.prototype,
      Date.prototype,
      RegExp.prototype,
    ])
      collect(target);
    return {
      checked,
      present,
      exportsMissing,
      missing,
      unchecked,
      providedNames: [...known],
    };
  }, surface);
  mkdirSync(resultRoot, { recursive: true });
  writeFileSync(
    join(resultRoot, "_api.json"),
    JSON.stringify(coverage, null, 2),
  );
});

for (const id of ids) {
  test(`survey: ${id}`, async ({ page }) => {
    test.setTimeout(60_000);
    const directory = join(pluginRoot, id);
    const files: Record<string, string> = { ...NOTES };
    for (const name of ["main.js", "manifest.json", "styles.css"]) {
      const path = join(directory, name);
      if (existsSync(path))
        files[`Basalt/Plugins/${id}/${name}`] = readFileSync(path, "utf8");
    }
    const manifest = JSON.parse(files[`Basalt/Plugins/${id}/manifest.json`]);
    const events: { stage: string; source: string; message: string }[] = [];
    let stage = "setup";
    page.on("pageerror", (error) =>
      events.push({
        stage,
        source: "uncaught",
        message: (error.stack ?? error.message).slice(0, 1500),
      }),
    );
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      events.push({
        stage,
        source: "console",
        message: message.text().slice(0, 1500),
      });
    });
    const step = async <T>(name: string, run: () => Promise<T>) => {
      stage = name;
      try {
        return await run();
      } catch (error) {
        events.push({
          stage: name,
          source: "thrown",
          message: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 1500),
        });
        return undefined;
      }
    };
    const result: Record<string, unknown> = {
      id,
      name: manifest.name,
      version: manifest.version,
      isDesktopOnly: Boolean(manifest.isDesktopOnly),
    };
    await step("setup", () => openSession(page, files));
    const enabled = await step("enable", () =>
      page.evaluate(async (id) => {
        const { app, session, missingExports } = (window as any).survey;
        // Record every `obsidian` export the bundle asks for but Basalt lacks:
        // a missing class only surfaces as "Class extends value undefined".
        const host = session.bundleHost.options.moduleHost;
        const real = host.obsidian;
        host.obsidian = new Proxy(real, {
          get(target, property, receiver) {
            if (
              typeof property === "string" &&
              !(property in target) &&
              !["default", "__esModule", "then"].includes(property)
            )
              missingExports.add(property);
            return Reflect.get(target, property, receiver);
          },
        });
        // Errors are rethrown with their stack so the report keeps it.
        try {
          await session.bundleHost.enable(id);
        } catch (error) {
          // Rollback failures wrap the real cause in an AggregateError.
          const parts =
            error instanceof AggregateError ? error.errors : [error];
          throw new Error(
            parts
              .map((part: unknown) =>
                part instanceof Error
                  ? `${part.message}\n${part.stack ?? ""}`
                  : String(part),
              )
              .join("\n---\n"),
          );
        }
        app.refreshPluginUi();
        return true;
      }, id),
    );
    result.enabled = enabled === true;
    if (enabled) {
      await step("open-note", async () => {
        await page.evaluate((text) => {
          const { app, session } = (window as any).survey;
          // The isolated port is not the demo backend, so open the note the
          // way plugins see it: active file plus editor contents.
          session.setActivePath("Note.md");
          app.editor.setText(text);
        }, NOTES["Note.md"]);
        await page.waitForTimeout(1_000);
      });
      result.contributions = await step("inspect", () =>
        page.evaluate((id) => {
          const { session } = (window as any).survey;
          const sidebar = [
            ...session.workspace.leftSplit.children,
            ...session.workspace.rightSplit.children,
          ];
          return {
            commands: session.services.getCommandsFor(id).length,
            settingTabs: session.services.getSettingTabs(id).length,
            sidebarViews: sidebar.map(
              (leaf: any) => `${leaf.side}:${leaf.view.getViewType()}`,
            ),
          };
        }, id),
      );
      const sidebarViews =
        (result.contributions as { sidebarViews?: string[] } | undefined)
          ?.sidebarViews ?? [];
      if (sidebarViews.length)
        await step("sidebar", async () => {
          // Show each sidebar view once so its rendering runs, and keep a picture.
          await page.evaluate(() => {
            const { session } = (window as any).survey;
            for (const leaf of [
              ...session.workspace.leftSplit.children,
              ...session.workspace.rightSplit.children,
            ])
              session.workspace.revealLeaf(leaf);
          });
          await page.waitForTimeout(500);
          mkdirSync(resultRoot, { recursive: true });
          await page.screenshot({ path: join(resultRoot, `${id}.png`) });
        });
      const tabs =
        (result.contributions as { settingTabs?: number } | undefined)
          ?.settingTabs ?? 0;
      if (tabs > 0)
        await step("settings", async () => {
          await page.evaluate(async (id) => {
            const { app } = (window as any).survey;
            const load = (path: string) => import(/* @vite-ignore */ path);
            const { openSettings } = await load("/src/app/settings-modal.ts");
            openSettings(app, `plugin:${id}:0`);
          }, id);
          await page.waitForTimeout(500);
          result.settingsRendered = await page.evaluate(
            () =>
              (
                document.querySelector("#settings .vertical-tab-content")
                  ?.textContent ?? ""
              ).trim().length > 0,
          );
          await page.keyboard.press("Escape");
        });
      await step("disable", async () => {
        await page.evaluate(
          (id) => (window as any).survey.session.bundleHost.disable(id),
          id,
        );
        await page.waitForTimeout(200);
      });
    }
    result.missingExports = await page
      .evaluate(() => [...((window as any).survey?.missingExports ?? [])])
      .catch(() => []);
    result.events = events;
    mkdirSync(resultRoot, { recursive: true });
    writeFileSync(
      join(resultRoot, `${id}.json`),
      JSON.stringify(result, null, 2),
    );
  });
}
