# Distribution: updates, F-Droid and Google Play

## Updates in the app

Settings → General shows the installed version and can look for a newer release: on request
("Check now") or, when "Check for updates automatically" is on, at most once a day at startup.
Nothing is installed without the user pressing a button, and no data about the user or the vault
is sent.

- **Desktop (AppImage, `.deb`, Windows installer):** the app reads
  `github.com/Nino4you/basalt/releases/latest/download/latest.json`. A newer version shows
  "Install and restart": Basalt saves all open notes, downloads the package for the way it was
  installed, checks its updater signature against the public key built into the app and restarts
  into the new version. A `.deb` asks for the administrator password; the Windows installer runs
  without questions. If the release has no `latest.json` or Basalt was built from source, the
  update is only announced with a download link.
- **Android:** one request to `api.github.com/repos/Nino4you/basalt/releases/latest`. When the
  release has `Basalt_<version>_android-universal.apk`, "Install" downloads it inside the app,
  checks that it is Basalt in exactly that version and signed with the same certificate as the
  installed app, and hands it to Android's installer, which asks to confirm (the first time
  Android also asks to allow installs from Basalt). An APK from another source (F-Droid, a
  debug build) has another certificate; Basalt then refuses and points to that source.
  Builds made with `BASALT_ANDROID_STORE=1 node tools/patch_android.mjs` have no installer and
  no `REQUEST_INSTALL_PACKAGES` permission, as Google Play requires; they only link to the
  release.
- **Browser demo:** the same request; a newer release is announced with a link to its GitHub
  page.

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
2. Build with `BASALT_ANDROID_STORE=1` set for `node tools/patch_android.mjs` (no in-app
   installer, see above), then upload the release AAB from the release workflow (the APK is not accepted for new apps) and
   enroll in Play App Signing; the upload key can stay the release key from
   `docs/release-signing.md`.
3. Fill in the content rating, data safety (Basalt collects no data; network access is used
   only for optional update checks, the plugin catalog and plugins the user enables) and the
   target audience.
4. The listing can be uploaded with `fastlane supply --metadata_path fastlane/metadata/android`
   or copied from those files by hand.
