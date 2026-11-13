// Regenerates THIRD_PARTY_NOTICES.md from package-lock.json and both Cargo graphs.
// Run after `npm ci` from the repository root: node tools/third_party_notices.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

const FENCE = "`".repeat(3);
const licenseTexts = (dir) => {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^(licen[cs]e|copying|notice)/i.test(f))
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r/g, "").trim());
  } catch {
    return [];
  }
};
const dedupe = (list) =>
  [...new Map(list.map((p) => [`${p.name}@${p.version}`, p])).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const js = dedupe(
  Object.entries(lock.packages)
    .filter(([key, pkg]) => key && !pkg.dev && fs.existsSync(key))
    .map(([key, pkg]) => ({
      name: key.replace(/.*node_modules\//, ""),
      version: pkg.version,
      license: pkg.license ?? "siehe Lizenztext",
      texts: licenseTexts(key),
    })),
);

const rustAll = [];
for (const manifest of ["Cargo.toml", "src-tauri/Cargo.toml"]) {
  const meta = JSON.parse(
    execSync(`cargo metadata --format-version 1 --locked --manifest-path ${manifest}`, {
      maxBuffer: 1 << 28,
    }),
  );
  const resolved = new Set(meta.resolve.nodes.map((n) => n.id));
  for (const pkg of meta.packages)
    if (pkg.source && resolved.has(pkg.id))
      rustAll.push({
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? "siehe Lizenztext",
        texts: licenseTexts(path.dirname(pkg.manifest_path)),
      });
}
const rust = dedupe(rustAll);

const out = [
  "# Drittanbieter-Hinweise\n\n",
  "Basalt selbst steht unter der MPL-2.0 (siehe `LICENSE`). Die ausgelieferten Builds enthalten\n",
  "die folgenden Fremdkomponenten unter ihren jeweiligen Lizenzen. Die Rust-Liste umfasst alle\n",
  "aufgelösten Abhängigkeiten aller Zielplattformen. Erzeugt mit\n",
  "`node tools/third_party_notices.mjs`.\n",
];
for (const [title, list] of [
  ["JavaScript (WebView-Oberfläche)", js],
  ["Rust (Kern und native Shell)", rust],
]) {
  out.push(`\n## ${title}\n\n| Paket | Version | Lizenz |\n| --- | --- | --- |\n`);
  for (const p of list) out.push(`| ${p.name} | ${p.version} | ${p.license.replaceAll("|", "\\|")} |\n`);
}

const texts = new Map();
for (const p of [...js, ...rust])
  for (const text of p.texts) {
    if (!texts.has(text)) texts.set(text, []);
    texts.get(text).push(`${p.name} ${p.version}`);
  }
out.push("\n## Lizenztexte\n");
for (const [text, users] of texts)
  out.push(`\n**${users.join(", ")}**\n\n${FENCE}text\n${text.replaceAll(FENCE, "'''")}\n${FENCE}\n`);

fs.writeFileSync("THIRD_PARTY_NOTICES.md", out.join(""));
console.log(`${js.length} JavaScript- und ${rust.length} Rust-Pakete, ${texts.size} Lizenztexte`);
