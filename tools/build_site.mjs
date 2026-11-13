// Assembles the project page for GitHub Pages into _site/:
//
//   _site/        the static landing page from site/
//   _site/demo/   the browser demo (the same build as `npm run build`, with
//                 relative asset paths so it works below /<repo>/demo/)
//
// Run `npm ci` first. Preview the result with any static file server, e.g.
// `python3 -m http.server -d _site`.
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = `${root}_site`;

rmSync(out, { recursive: true, force: true });
cpSync(`${root}site`, out, { recursive: true });

// Source maps are several times the size of the code; the page does not need them.
execFileSync(
  process.execPath,
  [
    `${root}node_modules/vite/bin/vite.js`,
    "build",
    "--base",
    "./",
    "--outDir",
    `${out}/demo`,
    "--sourcemap",
    "false",
  ],
  { cwd: root, stdio: "inherit" },
);

console.log(`Project page written to ${out}`);
