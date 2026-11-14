// Writes latest.json, the static update manifest that the desktop app's
// updater (tauri-plugin-updater) reads from the latest GitHub release.
//
//   node tools/updater_manifest.mjs <dir> <version> <download-base-url> [notes-file]
//
// <dir> holds the release packages and the updater signatures (`<file>.sig`)
// that `tauri build` writes when `bundle.createUpdaterArtifacts` is on.
// Every package needs its signature; a missing one fails the release instead
// of shipping a manifest the app would reject.
import fs from "node:fs";
import path from "node:path";

const [dir, version, baseUrl, notesFile] = process.argv.slice(2);
if (!dir || !version || !baseUrl) {
  console.error(
    "Usage: node tools/updater_manifest.mjs <dir> <version> <download-base-url> [notes-file]",
  );
  process.exit(2);
}
if (!/^https:\/\//.test(baseUrl) && !process.env.BASALT_UPDATER_INSECURE_TEST)
  throw new Error(`Download URLs must use HTTPS: ${baseUrl}`);

const files = fs.readdirSync(dir);
const one = (pattern, what) => {
  const matches = files.filter((name) => pattern.test(name));
  if (matches.length !== 1)
    throw new Error(
      `Expected exactly one ${what} in ${dir}, found ${matches.length}`,
    );
  return matches[0];
};
const entry = (file) => {
  const sig = path.join(dir, `${file}.sig`);
  if (!fs.existsSync(sig)) throw new Error(`Missing updater signature ${sig}`);
  return {
    signature: fs.readFileSync(sig, "utf8").trim(),
    url: `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(file)}`,
  };
};

const appImage = entry(one(/_amd64\.AppImage$/, "x86_64 AppImage"));
const deb = entry(one(/_amd64\.deb$/, "amd64 .deb"));
const nsis = entry(one(/_x64-setup\.exe$/, "x64 Windows installer"));

const manifest = {
  version,
  notes: notesFile ? fs.readFileSync(notesFile, "utf8").trim() : "",
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    // The updater looks for `<os>-<arch>-<bundle>` first, then `<os>-<arch>`.
    "linux-x86_64-appimage": appImage,
    "linux-x86_64-deb": deb,
    "linux-x86_64": appImage,
    "windows-x86_64-nsis": nsis,
    "windows-x86_64": nsis,
  },
};
fs.writeFileSync(
  path.join(dir, "latest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`latest.json for ${version}:`, Object.keys(manifest.platforms));
