#!/usr/bin/env node
// Bulk compatibility survey for Obsidian community plugins.
//
//   node tools/plugin-survey/run.mjs                 # top 100 by downloads
//   node tools/plugin-survey/run.mjs --top 300
//   node tools/plugin-survey/run.mjs --ids dataview,calendar
//   node tools/plugin-survey/run.mjs --local <dir>   # every <dir>/<id>/main.js
//   node tools/plugin-survey/run.mjs --report-only   # rebuild the report
//   other options: --dir <cache> --workers 4 --api <obsidian version> --config <playwright config>
//
// Steps: fetch the official API typings (`obsidian` npm package) and the
// community plugin list, download each plugin's latest release, load it
// unchanged in the browser demo (tests/e2e/plugin-survey.spec.ts), then
// write report.md / report.json. Downloads are cached in --dir (default
// node_modules/.cache/basalt-plugin-survey) and never committed.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractApiSurface } from "./api-surface.mjs";
import { analyze, renderMarkdown } from "./report.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const flag = (name) => args.includes(`--${name}`);
const dir = resolve(
  option("dir", join(repo, "node_modules/.cache/basalt-plugin-survey")),
);
const top = Number(option("top", "100"));
const only = option("ids", "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const local = option("local", "");
const workers = option("workers", "4");
const apiVersion = option("api", "latest");
const RELEASES =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master";

async function fetchOk(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response;
}

async function apiSurface() {
  const work = mkdtempSync(join(tmpdir(), "basalt-obsidian-api-"));
  try {
    const name = execFileSync(
      "npm",
      [
        "pack",
        `obsidian@${apiVersion}`,
        "--silent",
        "--pack-destination",
        work,
      ],
      { encoding: "utf8", shell: process.platform === "win32" },
    )
      .trim()
      .split("\n")
      .pop();
    execFileSync("tar", ["-xzf", join(work, name), "-C", work]);
    const version = JSON.parse(
      readFileSync(join(work, "package/package.json"), "utf8"),
    ).version;
    const surface = extractApiSurface(
      readFileSync(join(work, "package/obsidian.d.ts"), "utf8"),
    );
    return { version, ...surface };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function selectPlugins() {
  const [list, stats] = await Promise.all([
    fetchOk(`${RELEASES}/community-plugins.json`).then((r) => r.json()),
    fetchOk(`${RELEASES}/community-plugin-stats.json`).then((r) => r.json()),
  ]);
  const withDownloads = list.map((entry) => ({
    ...entry,
    downloads: stats[entry.id]?.downloads ?? 0,
  }));
  if (only.length)
    return withDownloads.filter((entry) => only.includes(entry.id));
  return withDownloads.sort((a, b) => b.downloads - a.downloads).slice(0, top);
}

async function download(entry, target) {
  mkdirSync(target, { recursive: true });
  const base = `https://github.com/${entry.repo}/releases/latest/download`;
  for (const name of ["manifest.json", "main.js", "styles.css"]) {
    if (existsSync(join(target, name))) continue;
    const response = await fetch(`${base}/${name}`);
    if (!response.ok) {
      if (name === "styles.css") continue;
      throw new Error(`${name}: HTTP ${response.status}`);
    }
    writeFileSync(
      join(target, name),
      Buffer.from(await response.arrayBuffer()),
    );
  }
  writeFileSync(
    join(target, "survey.json"),
    JSON.stringify({ repo: entry.repo, downloads: entry.downloads }),
  );
}

async function main() {
  mkdirSync(dir, { recursive: true });
  const pluginDir = join(dir, "plugins");
  if (!flag("report-only")) {
    console.log("Reading the API typings …");
    const surface = await apiSurface();
    writeFileSync(join(dir, "surface.json"), JSON.stringify(surface));
    rmSync(pluginDir, { recursive: true, force: true });
    mkdirSync(pluginDir, { recursive: true });
    const failures = [];
    if (local) {
      for (const id of readdirSync(local))
        if (existsSync(join(local, id, "main.js")))
          cpSync(join(local, id), join(pluginDir, id), { recursive: true });
    } else {
      const cache = join(dir, "downloads");
      const plugins = await selectPlugins();
      console.log(`Downloading ${plugins.length} plugins …`);
      const queue = [...plugins];
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          for (let entry = queue.shift(); entry; entry = queue.shift()) {
            try {
              await download(entry, join(cache, entry.id));
              // A release may carry another id (e.g. a beta); the folder must match it.
              const { id } = JSON.parse(
                readFileSync(join(cache, entry.id, "manifest.json"), "utf8"),
              );
              cpSync(join(cache, entry.id), join(pluginDir, id), {
                recursive: true,
              });
            } catch (error) {
              failures.push({
                id: entry.id,
                error: String(error.message ?? error),
              });
              rmSync(join(cache, entry.id), { recursive: true, force: true });
            }
          }
        }),
      );
    }
    writeFileSync(
      join(dir, "download-failures.json"),
      JSON.stringify(failures, null, 2),
    );
    rmSync(join(dir, "results"), { recursive: true, force: true });
    console.log("Loading every plugin in the browser demo …");
    const run = spawnSync(
      "npx",
      [
        "playwright",
        "test",
        "tests/e2e/plugin-survey.spec.ts",
        "--project=desktop",
        `--workers=${workers}`,
        "--reporter=dot",
        "--trace=off",
        "--retries=0",
        ...(option("config", "") ? [`--config=${option("config", "")}`] : []),
      ],
      {
        cwd: repo,
        stdio: "inherit",
        shell: process.platform === "win32",
        env: { ...process.env, BASALT_PLUGIN_SURVEY: dir },
      },
    );
    if (run.status !== 0)
      console.warn(
        "Playwright reported failures; the report still covers every finished plugin.",
      );
  }
  const report = analyze(dir);
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, "report.md"), renderMarkdown(report));
  console.log(`\nReport: ${join(dir, "report.md")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
