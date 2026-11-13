// Native end-to-end check. Refuses to install or control apps on a physical device.
import { _android as android, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const appId = "io.github.nino4you.basalt";
function adb(...args) {
  return execFileSync("adb", args, { encoding: "utf8", timeout: 60000 }).trim();
}
function runAs(command, input) {
  const quoted = `'${command.replace(/'/g, "'\\''")}'`;
  return execFileSync("adb", ["shell", `run-as ${appId} sh -c ${quoted}`], {
    input,
    encoding: "utf8",
    timeout: 60000,
  }).trim();
}
if (adb("shell", "getprop", "ro.kernel.qemu") !== "1") {
  throw new Error(
    "Native smoke tests may only run against an Android emulator",
  );
}
function apks(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? apks(path)
      : path.endsWith(".apk")
        ? [path]
        : [];
  });
}
const apk = apks(
  process.env.BASALT_APK_DIR ?? "src-tauri/gen/android/app/build/outputs/apk",
).find((path) => path.includes("debug") && path.includes("universal"));
if (!apk) throw new Error("Universal debug APK not found");
mkdirSync("test-results", { recursive: true });
let device;
let failed = true;
// Progress markers: the CI step's outer timeout kills the script without a
// stack trace, and the diagnostics artifact may not upload on a full quota.
const step = (name) => console.log(`[smoke] ${name}`);
try {
  // Start from a clean install: the cached AVD can carry an earlier build
  // signed with another key, which `install -r` refuses to replace.
  try {
    adb("uninstall", appId);
  } catch {
    // Not installed.
  }
  step("install");
  adb("install", apk);
  step("launch");
  adb("shell", "am", "start", "-W", "-n", `${appId}/.MainActivity`);
  device = (await android.devices()).find((candidate) =>
    candidate.serial().startsWith("emulator-"),
  );
  if (
    !device ||
    (await device.shell("getprop ro.kernel.qemu")).toString().trim() !== "1"
  )
    throw new Error("No verified emulator connection");
  step("attach WebView");
  const webview = await device.webView({ pkg: appId }, { timeout: 60000 });
  // Android WebViews need Playwright's WebView transport, not desktop browser discovery.
  const page = await webview.page();
  // Playwright actions have no timeout by default; fail with a message instead.
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);
  page.on("console", (message) => {
    if (message.type() === "error") console.error("WebView:", message.text());
  });
  page.on("pageerror", (error) =>
    console.error("WebView error:", error.message),
  );
  await expect(page.locator("#environment")).toContainText("Android", {
    timeout: 30000,
  });
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  // Phones get the drawer layout; larger emulators the desktop workspace.
  const mobile = await page.evaluate(() =>
    document.body.classList.contains("is-mobile"),
  );
  const openFromMenu = async (item) => {
    await page
      .getByRole("button", { name: "Menü", exact: true })
      .click({ force: true });
    await page.getByRole("menuitem", { name: item }).click({ force: true });
  };
  const quickOpen = async (query) => {
    await page
      .getByRole("button", { name: "Schnellauswahl öffnen", exact: true })
      .click({ force: true });
    await page.getByRole("textbox", { name: "Schnellauswahl" }).fill(query);
    // The soft keyboard animates the viewport on Android. Force the click on the
    // already filtered result instead of waiting for Playwright's stability check.
    await page.locator(".suggestion-item").first().click({ force: true });
  };
  step("create note");
  await page
    .getByRole("button", { name: "Neue Notiz", exact: true })
    .click({ force: true });
  await page.locator("#new-name").fill("Native Smoke");
  await page
    .getByRole("button", { name: "Notiz anlegen", exact: true })
    .click({ force: true });
  await expect(page.locator("#tab-name")).toHaveText("Native Smoke");
  const editor = page.getByRole("textbox", { name: "Markdown-Editor" });
  await editor.fill(
    "# Native Android\n\nPersisted through the Rust vault backend.",
  );
  await expect(page.locator("#save-status")).toContainText(
    "Alle Änderungen gespeichert",
  );
  // The workspace is restored with the same note open after a reload.
  step("reload and quick open");
  await page.reload();
  await expect(page.locator("#tab-name")).toHaveText("Native Smoke");
  await quickOpen("Willkommen");
  await expect(page.locator("#tab-name")).toHaveText("Willkommen");
  await quickOpen("Native Smoke");
  await expect(page.locator("#tab-name")).toHaveText("Native Smoke");
  await expect(editor).toContainText(
    "Persisted through the Rust vault backend.",
  );
  await page
    .getByRole("button", { name: "Leseansicht", exact: true })
    .click({ force: true });
  await expect(page.locator("#preview h1")).toHaveText("Native Android");
  await expect(page.locator("#preview")).toContainText(
    "Persisted through the Rust vault backend.",
  );
  await page.screenshot({ path: "test-results/android-native.png" });

  // Install a tiny bundle into the app-private vault, then activate it through
  // the real settings UI. This proves eval/CSP, manifest reading and lifecycle.
  step("install test plugin");
  const vaultDir = runAs(
    `find /data/user/0/${appId} -maxdepth 5 -type d -name "Mein Vault" | head -1`,
  );
  if (!vaultDir) throw new Error("App-private vault folder not found");
  const pluginDir = `${vaultDir}/Basalt/Plugins/basalt-smoke`;
  runAs(`mkdir -p "${pluginDir}"`);
  runAs(
    `cat > "${pluginDir}/manifest.json"`,
    JSON.stringify(
      {
        id: "basalt-smoke",
        name: "Smoke Loader",
        version: "1.0.0",
        minAppVersion: "1.0.0",
        isDesktopOnly: false,
      },
      null,
      2,
    ),
  );
  runAs(
    `cat > "${pluginDir}/main.js"`,
    [
      'const { Plugin, editorInfoField } = require("obsidian");',
      "module.exports = class SmokePlugin extends Plugin {",
      "  onload() {",
      '    document.body.dataset.smokePlugin = "loaded";',
      '    this.addStatusBarItem().setText("Smoke aktiv");',
      "    this.addCommand({",
      '      id: "smoke-ping",',
      '      name: "Smoke-Ping",',
      "      editorCallback: (editor, view) => {",
      '        if (view.file?.path !== "Native Smoke.md") throw new Error("Wrong plugin view");',
      '        if (editor.cm.state.field(editorInfoField).file !== view.file) throw new Error("Stale editor info");',
      '        editor.setValue(editor.getValue() + "\\n\\nEdited by native plugin.");',
      '        document.body.dataset.smokeCommand = "ran";',
      "      },",
      "    });",
      "  }",
      "  onunload() {",
      "    delete document.body.dataset.smokePlugin;",
      "  }",
      "};",
    ].join("\n"),
  );
  runAs(`cat > "${pluginDir}/styles.css"`, "body { --basalt-smoke: 1; }\n");

  step("activate test plugin");
  if (mobile) await openFromMenu("Einstellungen");
  else
    await page
      .getByRole("button", { name: "Einstellungen", exact: true })
      .click({ force: true });
  await page
    .getByRole("tab", { name: "Community-Plugins" })
    .click({ force: true });
  await expect(page.locator("#plugin-bundles")).toContainText("Smoke Loader", {
    timeout: 20000,
  });
  const pluginRow = page
    .locator("#plugin-bundles .plugin-card")
    .filter({ hasText: "Smoke Loader" });
  await pluginRow
    .getByRole("switch", { name: "Smoke Loader aktivieren", exact: true })
    .click({ force: true });
  await expect(page.locator("#plugin-status-items")).toContainText(
    "Smoke aktiv",
    { timeout: 20000 },
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-smoke-plugin",
    "loaded",
  );
  const styleInjected = await page.evaluate(() =>
    Boolean(document.querySelector('style[data-basalt-plugin="basalt-smoke"]')),
  );
  if (!styleInjected) throw new Error("Plugin stylesheet was not injected");
  await page.screenshot({ path: "test-results/android-native-plugin.png" });

  step("run plugin command");
  await page
    .locator('#settings [data-close="settings"]')
    .click({ force: true });
  if (mobile) await openFromMenu("Befehlspalette öffnen");
  else
    await page
      .getByRole("button", { name: "Befehlspalette öffnen", exact: true })
      .click({ force: true });
  await page
    .getByRole("textbox", { name: "Befehlspalette" })
    .fill("Smoke-Ping");
  await page.locator(".suggestion-item").first().click({ force: true });
  await expect(page.locator("body")).toHaveAttribute(
    "data-smoke-command",
    "ran",
  );
  await expect(page.locator("#preview")).toContainText(
    "Edited by native plugin.",
  );
  await expect(page.locator("#save-status")).toContainText(
    "Alle Änderungen gespeichert",
  );
  step("reload with active plugin");
  await page.reload();
  await expect(page.locator("#plugin-status-items")).toContainText(
    "Smoke aktiv",
  );
  // The restored tab is still in reading view; switch back to the editor.
  await expect(page.locator("#tab-name")).toHaveText("Native Smoke");
  await page
    .getByRole("button", { name: "Bearbeiten", exact: true })
    .click({ force: true });
  await expect(editor).toContainText("Edited by native plugin.");
  failed = false;
  console.log(
    "Native Android: storage, preview, plugin activation, editor command, shared editor info and persisted plugin edit passed.",
  );
} finally {
  try {
    writeFileSync(
      "test-results/android-native-logcat.txt",
      adb("logcat", "-d", "-t", "1000"),
    );
  } catch (error) {
    console.error("Could not collect logcat:", error.message);
  }
  try {
    const pid = adb("shell", "pidof", appId).split(" ")[0];
    if (pid) {
      const appLog = adb("logcat", "-d", "--pid", pid);
      writeFileSync("test-results/android-native-app-logcat.txt", appLog);
      if (failed)
        console.error(
          "App logcat (last 60 lines):\n" +
            appLog.split("\n").slice(-60).join("\n"),
        );
    }
  } catch (error) {
    console.error("Could not collect app logcat:", error.message);
  }
  try {
    if (device)
      await device.screenshot({
        path: "test-results/android-native-device.png",
      });
  } catch (error) {
    console.error("Could not collect device screenshot:", error.message);
  }
  await device?.close();
}
