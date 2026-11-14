# Signed releases

The workflow `.github/workflows/release.yml` builds production-signed packages and stores them as
a **draft** GitHub release. Nothing is published until the draft is released manually on GitHub.

| Artifact                                 | Signature                                                    |
| ---------------------------------------- | ------------------------------------------------------------ |
| `Basalt_<version>_android-universal.apk` | Android release key (APK signature scheme v1–v3)             |
| `Basalt_<version>_android-universal.aab` | Android release key (JAR signature, upload key)              |
| `.deb`, `.AppImage` (Linux x86_64)       | detached OpenPGP signature `<file>.asc`                      |
| `SHA256SUMS`                             | checksums of all packages, OpenPGP-signed (`SHA256SUMS.asc`) |
| `basalt-release-key.asc`, `SIGNING.txt`  | public OpenPGP key and both fingerprints                     |

The APK/AAB contains ARM64, ARMv7 and x86_64. Signing keys exist only in GitHub secrets, never
in the git history; the workflow writes the keystore only temporarily to `$RUNNER_TEMP` and
deletes it at the end of the job.

## One-time setup

### Dry run without keys (optional, beforehand)

**Actions → Signed release → Run workflow** with **test_keys** checked runs the whole pipeline
before any setup: the run creates throwaway keys (valid for 1–2 days, named
"Basalt TEST KEY – NOT FOR DISTRIBUTION"), needs no secrets and only uploads the Actions
artifact `Basalt-v<version>-testkeys-signed`. This tests the build (including ARMv7), signing and
verification before real keys exist. **Never distribute** these packages; the switch is not
available for tag releases.

### Automatically with the setup script (recommended)

`tools/setup_release_signing.sh` performs steps 1 to 3 in one go: it asks for an email address,
the keystore password and the GPG passphrase (hidden, each twice), creates both keys, creates the
GitHub environment `release` and stores all six secrets through the GitHub CLI. Passwords never
appear on screen or on the command line.

Requirements: `keytool` (from a JDK; in Android Studio under `jbr/bin`), `gpg`, `base64` and a
signed-in GitHub CLI (`gh auth login`). On Windows, run it in **Git Bash**, which ships `gpg` and
`base64`:

```sh
export PATH="$PATH:/c/Program Files/Android/Android Studio/jbr/bin"   # only if keytool is missing
tools/setup_release_signing.sh                 # keys end up in ~/basalt-release-keys
```

The script never overwrites existing keys and refuses a target folder inside the repository.
Afterwards, back up the printed folder (it contains the keystore, the OpenPGP keyring with its
revocation certificate and `FINGERPRINTS.txt`) and continue with step 4.

### Existing keys for a new repository

When the repository moves or the secrets are lost, store the **existing** keys again instead of
creating new ones: a new Android key means installed apps can no longer update, and a new OpenPGP
key no longer matches the fingerprints in the README. From a checkout of the repository:

```sh
tools/setup_release_signing.sh --reuse         # reads ~/basalt-release-keys
BASALT_REPO=owner/name tools/setup_release_signing.sh --reuse /path/to/keys   # other repository or folder
```

It asks for the keystore password and the GPG passphrase once, checks both against the keys,
compares both fingerprints with the README and stops before storing anything if one of them
differs. Then it creates the environment `release` and sets the six secrets as above.

### Manually

Run all commands locally on a trusted machine, **not** inside the repository folder (`*.jks` is
excluded by `.gitignore`, but keep it outside anyway).

### 1. Android release keystore

```sh
keytool -genkeypair -v \
  -keystore basalt-release.jks -storetype PKCS12 \
  -alias basalt -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Basalt, O=Basalt"
```

`keytool` asks for a password. With PKCS12, keystore and key password are the same; enter the
same password for both secrets.

> **Important:** Back up this keystore and its password safely (for example in a password manager
> plus an offline copy). If the key is lost, installed apps can no longer receive updates. If it
> is compromised, a third party can ship "updates".

### 2. OpenPGP key for Linux packages and checksums

```sh
gpg --quick-gen-key "Basalt Release Signing <your-address@example.org>" ed25519 sign 2y
gpg --list-secret-keys --keyid-format long      # note the fingerprint
gpg --armor --export-secret-keys <FINGERPRINT> > basalt-release-private.asc
```

Use a dedicated key for CI, not your personal primary key. The expiry (2 years) can be extended
later with `gpg --quick-set-expire`; keep the revocation certificate from
`~/.gnupg/openpgp-revocs.d/` in a safe place.

### 3. Create the GitHub secrets

Under **Settings → Environments → New environment**, create an environment `release` (optionally
with "Required reviewers" so every release run has to be approved) and add these secrets there.
Repository secrets with the same names work too.

| Secret                              | Content                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| `ANDROID_RELEASE_KEYSTORE`          | `base64 -w0 basalt-release.jks` (one line)                   |
| `ANDROID_RELEASE_KEYSTORE_PASSWORD` | keystore password                                            |
| `ANDROID_RELEASE_KEY_ALIAS`         | `basalt` (or the name chosen with `-alias`)                  |
| `ANDROID_RELEASE_KEY_PASSWORD`      | key password (identical to the keystore password for PKCS12) |
| `RELEASE_GPG_PRIVATE_KEY`           | full content of `basalt-release-private.asc`                 |
| `RELEASE_GPG_PASSPHRASE`            | passphrase of the OpenPGP key                                |

With the GitHub CLI, for example:

```sh
base64 -w0 basalt-release.jks | gh secret set ANDROID_RELEASE_KEYSTORE --env release
gh secret set ANDROID_RELEASE_KEYSTORE_PASSWORD --env release
gh secret set ANDROID_RELEASE_KEY_ALIAS --env release --body basalt
gh secret set ANDROID_RELEASE_KEY_PASSWORD --env release
gh secret set RELEASE_GPG_PRIVATE_KEY --env release < basalt-release-private.asc
gh secret set RELEASE_GPG_PASSPHRASE --env release
```

Then delete `basalt-release-private.asc` (`shred -u`) and keep only the backed-up copy. The
existing `ANDROID_DEBUG_KEYSTORE` stays unchanged for the regular CI preview builds.

### 4. Dry run

**Actions → Signed release → Run workflow** starts a dry run: everything is built and signed, but
only uploaded as the Actions artifact `Basalt-v<version>-dryrun-signed`. A missing secret stops
the run immediately with a clear message.

Between jobs, packages travel through the Actions cache rather than artifacts: the artifact
storage of a private repository (500 MB on the free plan) is too small for a release and is
shared with CI. If it is full, the dry run still succeeds (built, signed and verified); only the
download artifact is missing. Tag releases attach the files directly to the release draft.

## Creating a release

1. Set the same version in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml` (the workflow checks this). Android derives its `versionCode` from this
   version, so bump it for every release that should install as an update.
2. Optionally add release notes as `docs/releases/<version>.md`, for example
   `docs/releases/0.2.0.md` for the tag `v0.2.0`. They are copied into the release text.
3. Push the tag:

   ```sh
   git tag -a v0.2.0 -m "Basalt 0.2.0"
   git push origin v0.2.0
   ```

   A tag with a suffix (`v0.2.0-preview.1`) is marked as a pre-release; the part before the
   hyphen must match the app version.

4. Review the release draft on GitHub and publish it.

## Verifying downloads

```sh
gpg --import basalt-release-key.asc        # compare the fingerprint with README/SIGNING.txt
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS
gpg --verify Basalt_0.2.0_amd64.AppImage.asc Basalt_0.2.0_amd64.AppImage
apksigner verify --print-certs Basalt_0.2.0_android-universal.apk
```

The certificate SHA-256 shown by `apksigner` must match the value in `SIGNING.txt`. Both
fingerprints are also listed in the README, so they are not distributed only through the same
channel as the downloads.

## Limits and notes

- **Switching from a preview APK:** Earlier preview APKs are signed with the development key.
  Android does not install a release APK as an update over them; uninstall the preview first.
  Export notes from the app's private vault beforehand.
- **Google Play:** The AAB is signed with the release key. With Play App Signing it serves as the
  upload key; Google then signs the delivered APKs with its own app key. The workflow does not
  upload to Play.
- **Linux packages:** `.deb` and AppImage carry no embedded signature, only detached `.asc`
  files. There is no signed APT repository yet.
- **No auto-update:** The Tauri updater is not included. It would need the
  `tauri-plugin-updater` plugin, a dedicated updater key and an update endpoint; that is a
  separate step.
- **Build provenance:** GitHub attestations (Sigstore) are only available for private
  repositories with GitHub Enterprise Cloud and are therefore not enabled.
