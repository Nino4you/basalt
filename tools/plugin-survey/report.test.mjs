import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { analyze } from "./report.mjs";

function survey(t, results) {
  const cache = fileURLToPath(new URL("../../node_modules/.cache/", import.meta.url));
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "survey-report-test-"));
  t.after(() => rmSync(dir, { recursive: true }));
  mkdirSync(join(dir, "results"));
  for (const [id, result] of Object.entries(results)) {
    mkdirSync(join(dir, "plugins", id), { recursive: true });
    writeFileSync(join(dir, "plugins", id, "manifest.json"), JSON.stringify({ id, version: "1.0.0" }));
    if (result) writeFileSync(join(dir, "results", `${id}.json`), JSON.stringify(result));
  }
  return analyze(dir);
}

test("network errors remain failures of the zero-error plugin lifecycle", (t) => {
  const report = survey(t, {
    offline: { enabled: true, events: [{ stage: "settings", source: "console", message: "Failed to fetch" }] },
  });
  assert.equal(report.plugins[0].status, "loads with errors");
  assert.equal(report.plugins[0].errors[0].cause.kind, "network");
  assert.equal(report.counts["loads cleanly"] ?? 0, 0);
});

test("only an enabled plugin with no recorded errors is clean", (t) => {
  const report = survey(t, {
    clean: { enabled: true, events: [] },
    broken: { enabled: true, events: [{ stage: "enable", source: "exception", message: "missing is not a function" }] },
    failed: { enabled: false, events: [] },
    missing: null,
  });
  assert.deepEqual(report.plugins.map(({ id, status }) => [id, status]), [
    ["broken", "loads with errors"], ["clean", "loads cleanly"],
    ["failed", "fails to load"], ["missing", "not run"],
  ]);
  assert.equal(report.counts["loads cleanly"], 1);
});
