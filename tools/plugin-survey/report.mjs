// Turns the raw survey results into a ranked list of compatibility gaps.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const readJson = (path, fallback) =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;

/** Property names a bundle accesses (`x.name` or `x["name"]`). */
export function accessedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/\.\s*(?<![\w$])([A-Za-z_$][\w$]*)/g))
    names.add(match[1]);
  for (const match of source.matchAll(
    /\[\s*["'`]([A-Za-z_$][\w$]*)["'`]\s*\]/g,
  ))
    names.add(match[1]);
  return names;
}

/**
 * Names the bundle defines itself (class methods, object keys, assignments);
 * using such a name says nothing about the host API.
 */
export function definedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(
    /(?:^|[\s;{}),])(?:async\s+|get\s+|set\s+|static\s+)?([A-Za-z_$][\w$]*)\s*\([^(){};]{0,200}\)\s*\{/g,
  ))
    names.add(match[1]);
  for (const match of source.matchAll(
    /(?<![\w$])([A-Za-z_$][\w$]*)\s*(?::(?!:)|=(?![=>]))/g,
  ))
    names.add(match[1]);
  return names;
}

/** What an error message says is missing, if it names an API member or module. */
export function classifyError(message) {
  if (/net::ERR_|Failed to fetch|Access to fetch at/.test(message))
    return { kind: "network", name: null };
  const module = /requested an unavailable module: ([^\s"'`]+)/.exec(message);
  if (module) return { kind: "module", name: module[1] };
  if (/exceeds the 8 MiB limit/.test(message))
    return { kind: "size", name: "bundle > 8 MiB" };
  const call =
    /(?:^|[\s(])(?:[\w$]+\.)*([\w$]+) is not a (?:function|constructor)/.exec(
      message,
    );
  if (call && call[1] !== "undefined") return { kind: "call", name: call[1] };
  const read =
    /Cannot (?:read|set) properties of (?:undefined|null) \((?:reading|setting) '([^']+)'\)/.exec(
      message,
    );
  if (read) return { kind: "read", name: read[1] };
  const notDefined = /([\w$]+) is not defined/.exec(message);
  if (notDefined) return { kind: "global", name: notDefined[1] };
  return { kind: "other", name: null };
}

const firstLine = (message) => message.split("\n")[0].slice(0, 220);

export function analyze(dir) {
  const surface = readJson(join(dir, "surface.json"), {
    exports: [],
    version: "?",
  });
  const api = readJson(join(dir, "results", "_api.json"), null);
  const resultDir = join(dir, "results");
  const pluginDir = join(dir, "plugins");
  const downloadFailures = readJson(join(dir, "download-failures.json"), []);
  const provided = new Set(api?.providedNames ?? []);
  // A missing member counts as a gap signal only when its name is not
  // provided anywhere else; generic names would match every bundle.
  const gapsByName = new Map();
  for (const gap of api?.missing ?? []) {
    // Properties are skipped: plugins set fields like `settings` themselves.
    if (
      gap.kind !== "method" ||
      provided.has(gap.member) ||
      gap.member.length < 4
    )
      continue;
    const key = `${gap.type}.${gap.member}`;
    const list = gapsByName.get(gap.member) ?? [];
    if (!list.includes(key)) list.push(key);
    gapsByName.set(gap.member, list);
  }
  for (const entry of api?.exportsMissing ?? [])
    gapsByName.set(entry.name, [`obsidian.${entry.name}`]);

  const plugins = [];
  const ids = existsSync(pluginDir) ? readdirSync(pluginDir).sort() : [];
  for (const id of ids) {
    const result = readJson(join(resultDir, `${id}.json`), null);
    const meta = readJson(join(pluginDir, id, "survey.json"), {});
    const manifest = readJson(join(pluginDir, id, "manifest.json"), {});
    const source = existsSync(join(pluginDir, id, "main.js"))
      ? readFileSync(join(pluginDir, id, "main.js"), "utf8")
      : "";
    const names = accessedNames(source);
    const defined = definedNames(source);
    const staticGaps = [...names]
      .filter((name) => !defined.has(name))
      .flatMap((name) => gapsByName.get(name) ?? []);
    const events = result?.events ?? [];
    const causes = events.map((event) => ({
      ...event,
      cause: classifyError(event.message),
    }));
    const status = !result
      ? "not run"
      : !result.enabled
        ? "fails to load"
        : causes.some((event) => event.cause.kind !== "network")
          ? "loads with errors"
          : "loads cleanly";
    plugins.push({
      id,
      name: manifest.name ?? id,
      version: manifest.version ?? "?",
      repo: meta.repo ?? null,
      downloads: meta.downloads ?? 0,
      isDesktopOnly: Boolean(manifest.isDesktopOnly),
      status,
      commands: result?.contributions?.commands ?? 0,
      settingTabs: result?.contributions?.settingTabs ?? 0,
      settingsRendered: result?.settingsRendered ?? null,
      errors: causes.map((event) => ({
        stage: event.stage,
        source: event.source,
        message: firstLine(event.message),
        cause: event.cause,
      })),
      missingExports: result?.missingExports ?? [],
      staticGaps: [...new Set(staticGaps)].sort(),
    });
  }

  // Rank gaps by how many plugins hit them at runtime, then by how many
  // reference them in their code.
  const gaps = new Map();
  const touch = (key) => {
    if (!gaps.has(key))
      gaps.set(key, {
        key,
        runtime: new Set(),
        referenced: new Set(),
        downloads: 0,
      });
    return gaps.get(key);
  };
  for (const plugin of plugins) {
    const keys = new Set();
    for (const error of plugin.errors) {
      const { kind, name } = error.cause;
      if (!name) continue;
      const key =
        kind === "module"
          ? `require("${name}")`
          : kind === "size"
            ? name
            : (gapsByName.get(name)?.join(" / ") ??
              `${name} (${kind === "read" ? "read of undefined" : kind === "global" ? "undefined global" : "missing call"})`);
      touch(key).runtime.add(plugin.id);
      keys.add(key);
    }
    for (const name of plugin.missingExports) {
      touch(`obsidian.${name}`).runtime.add(plugin.id);
      keys.add(`obsidian.${name}`);
    }
    for (const key of plugin.staticGaps) {
      touch(key).referenced.add(plugin.id);
      keys.add(key);
    }
    for (const key of keys) gaps.get(key).downloads += plugin.downloads;
  }
  const ranked = [...gaps.values()]
    .map((gap) => ({
      key: gap.key,
      runtime: [...gap.runtime].sort(),
      referenced: [...gap.referenced].sort(),
      plugins: new Set([...gap.runtime, ...gap.referenced]).size,
      downloads: gap.downloads,
    }))
    .sort(
      (a, b) =>
        b.runtime.length - a.runtime.length ||
        b.plugins - a.plugins ||
        b.downloads - a.downloads,
    );

  const counts = {};
  for (const plugin of plugins)
    counts[plugin.status] = (counts[plugin.status] ?? 0) + 1;
  return {
    apiVersion: surface.version,
    generated: new Date().toISOString(),
    coverage: api
      ? {
          checked: api.checked,
          present: api.present,
          missing: api.missing,
          exportsMissing: api.exportsMissing,
          unchecked: api.unchecked.length,
        }
      : null,
    counts,
    downloadFailures,
    gaps: ranked,
    plugins: plugins.sort((a, b) => b.downloads - a.downloads),
  };
}

const escape = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
const sample = (list, limit = 6) =>
  list.length > limit
    ? `${list.slice(0, limit).join(", ")} … (+${list.length - limit})`
    : list.join(", ");

export function renderMarkdown(report) {
  const lines = [];
  const total = report.plugins.length;
  lines.push(`# Plugin compatibility survey`, "");
  lines.push(
    `Generated ${report.generated} against \`obsidian\` typings ${report.apiVersion}.`,
    "",
  );
  lines.push(`## Summary`, "");
  for (const status of [
    "loads cleanly",
    "loads with errors",
    "fails to load",
    "not run",
  ])
    if (report.counts[status])
      lines.push(`- **${status}:** ${report.counts[status]} of ${total}`);
  if (report.downloadFailures.length)
    lines.push(
      `- **no downloadable release:** ${report.downloadFailures.length} (${sample(report.downloadFailures.map((f) => f.id))})`,
    );
  if (report.coverage) {
    const { checked, present } = report.coverage;
    lines.push(
      `- **API coverage:** ${present} of ${checked} checked members of \`obsidian.d.ts\` exist (${((100 * present) / checked).toFixed(1)} %), ${report.coverage.exportsMissing.length} module exports missing`,
    );
  }
  lines.push(
    "",
    "“loads cleanly” means: the plugin loaded, survived opening a note and its settings page and unloaded without an error. It does not mean every feature works.",
    "",
  );

  lines.push(`## Gaps ranked by impact`, "");
  lines.push(
    "*Runtime* = the plugin actually failed on it. *Referenced* = its code uses that name, which Basalt lacks (static heuristic, may over-count).",
    "",
  );
  lines.push(
    "| Gap | Runtime | Referenced | Plugins | Downloads | Examples |",
    "|---|---:|---:|---:|---:|---|",
  );
  for (const gap of report.gaps.slice(0, 60))
    lines.push(
      `| \`${escape(gap.key)}\` | ${gap.runtime.length} | ${gap.referenced.length} | ${gap.plugins} | ${gap.downloads.toLocaleString("en")} | ${escape(sample([...new Set([...gap.runtime, ...gap.referenced])], 5))} |`,
    );
  lines.push("");

  lines.push(`## Plugins`, "");
  lines.push(
    "| Plugin | Downloads | Result | First error |",
    "|---|---:|---|---|",
  );
  for (const plugin of report.plugins) {
    const first = plugin.errors[0];
    lines.push(
      `| ${escape(plugin.name)} (\`${plugin.id}\` ${escape(plugin.version)}${plugin.isDesktopOnly ? ", desktop only" : ""}) | ${plugin.downloads.toLocaleString("en")} | ${plugin.status} | ${first ? `${first.stage}: ${escape(first.message)}` : ""} |`,
    );
  }
  lines.push("");

  if (report.coverage) {
    lines.push(`## Missing API members`, "");
    lines.push(
      "Members of `obsidian.d.ts` that the live Basalt objects (or exported class prototypes) lack.",
      "",
    );
    const byType = new Map();
    for (const gap of report.coverage.missing) {
      const list = byType.get(gap.type) ?? [];
      list.push(gap.member);
      byType.set(gap.type, list);
    }
    if (report.coverage.exportsMissing.length)
      lines.push(
        `- **module exports:** ${report.coverage.exportsMissing.map((e) => `\`${e.name}\``).join(", ")}`,
      );
    for (const [type, members] of [...byType].sort())
      lines.push(`- **${type}:** ${members.map((m) => `\`${m}\``).join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
