# Distribution: updates, F-Droid and Google Play

## Updates in the app

Basalt does not update itself. Settings → General shows the installed version and can ask
GitHub for the latest release: on request ("Check now") or, when "Check for updates
automatically" is on, at most once a day at startup. The check is one request to
`api.github.com/repos/Nino4you/basalt/releases/latest`; it sends no data about the user or the
vault. A newer release is only announced, with a link to its GitHub page. Installing stays a
manual step, so every download can be verified against the signing fingerprints in the README.

## Store listing metadata

`fastlane/metadata/android/` holds the store listing in the layout that both F-Droid and
fastlane `supply` (Google Play) read:

- `<locale>/title.txt`, `short_description.txt` (at most 80 characters) and
  `full_description.txt` (at most 4000 characters; simple HTML),
- `<locale>/changelogs/<versionCode>.txt` (at most 500 characters) for each release,
- `en-US/images/icon.png` (512 × 512) and `images/phoneScreenshots/*.png`; other locales fall
  back to these.

Tauri derives the Android `versionCode` from the version: `major × 1000000 + minor × 1000 +
patch`, so 0.2.0 is `2000` and 0.3.0 is `3000`. Add a changelog file for every release.

## F-Droid

F-Droid builds apps from source on its own servers. To get Basalt included:

1. Open a request for packaging at <https://gitlab.com/fdroid/rfp> or, better, a merge request
   to [fdroiddata](https://gitlab.com/fdroid/fdroiddata) with
   `metadata/io.github.nino4you.basalt.yml`. The build recipe follows the Android job in
   `.github/workflows/release.yml` (Node.js, Rust with the Android targets, the NDK version
   listed there, `npm ci`, `npm run tauri -- android init --ci --skip-targets-install`,
   `node tools/patch_android.mjs`, `npm run tauri -- icon public/basalt.svg`, then
   `npm run tauri -- android build`).
2. F-Droid signs with its own key unless the build is reproducible. To keep the release
   signature (so users can switch between GitHub and F-Droid builds), the APK must be
   reproducible and the recipe needs `Binaries:` pointing at the GitHub release APK plus
   `AllowedAPKSigningKeys:` with the certificate fingerprint from the README.
3. The listing text and images come from `fastlane/metadata/android/` automatically.

## Google Play

1. Create the app in the Play Console with the package name `io.github.nino4you.basalt`.
2. Upload the release AAB from the release workflow (the APK is not accepted for new apps) and
   enroll in Play App Signing; the upload key can stay the release key from
   `docs/release-signing.md`.
3. Fill in the content rating, data safety (Basalt collects no data; network access is used
   only for optional update checks, the plugin catalog and plugins the user enables) and the
   target audience.
4. The listing can be uploaded with `fastlane supply --metadata_path fastlane/metadata/android`
   or copied from those files by hand.
