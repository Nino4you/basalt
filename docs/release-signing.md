# Signierte Releases

Der Workflow `.github/workflows/release.yml` baut produktiv signierte Pakete und legt sie als
**Entwurf** eines GitHub-Releases ab. Veröffentlicht wird erst, wenn der Entwurf auf GitHub
manuell freigegeben wird.

| Artefakt                                 | Signatur                                                     |
| ---------------------------------------- | ------------------------------------------------------------ |
| `Basalt_<version>_android-universal.apk` | Android-Release-Schlüssel (APK-Signaturschema v1–v3)         |
| `Basalt_<version>_android-universal.aab` | Android-Release-Schlüssel (JAR-Signatur, Upload-Schlüssel)   |
| `.deb`, `.AppImage` (Linux x86_64)       | abgesetzte OpenPGP-Signatur `<datei>.asc`                    |
| `SHA256SUMS`                             | Prüfsummen aller Pakete, OpenPGP-signiert (`SHA256SUMS.asc`) |
| `basalt-release-key.asc`, `SIGNING.txt`  | öffentlicher OpenPGP-Schlüssel und beide Fingerabdrücke      |

Die APK/AAB enthält ARM64, ARMv7 und x86_64. Signierschlüssel liegen nur in GitHub-Secrets,
nie im Git-Verlauf; der Workflow schreibt den Keystore nur temporär in `$RUNNER_TEMP` und
löscht ihn am Ende des Jobs.

## Einmalige Einrichtung

### Probelauf ohne Schlüssel (optional, vorab)

Unter **Actions → Signed release → Run workflow** mit Haken bei **test_keys** läuft der komplette
Ablauf schon vor der Einrichtung durch: Der Lauf erzeugt Wegwerf-Schlüssel (Gültigkeit 1–2 Tage,
Name „Basalt TEST KEY – NOT FOR DISTRIBUTION“), braucht keine Secrets und lädt nur das
Actions-Artefakt `Basalt-v<version>-testkeys-signed` hoch. So lassen sich Build (inklusive ARMv7),
Signatur und Prüfung testen, bevor echte Schlüssel existieren. Diese Pakete **nie weitergeben**;
bei einem Tag-Release ist der Schalter nicht verfügbar.

### Automatisch mit dem Einrichtungsskript (empfohlen)

`tools/setup_release_signing.sh` erledigt die Schritte 1 bis 3 in einem Durchgang: Es fragt nach
E-Mail-Adresse, Keystore-Passwort und GPG-Passphrase (verdeckt, jeweils zweimal), erzeugt beide
Schlüssel, legt die GitHub-Umgebung `release` an und speichert alle sechs Secrets über die
GitHub-CLI. Passwörter erscheinen dabei weder auf dem Bildschirm noch in der Kommandozeile.

Voraussetzungen: `keytool` (JDK; bei Android Studio unter `jbr/bin`), `gpg`, `base64` und die
angemeldete GitHub-CLI (`gh auth login`). Unter Windows in **Git Bash** ausführen, das `gpg` und
`base64` mitbringt:

```sh
export PATH="$PATH:/c/Program Files/Android/Android Studio/jbr/bin"   # nur falls keytool fehlt
tools/setup_release_signing.sh                 # Schlüssel landen in ~/basalt-release-keys
```

Das Skript überschreibt keine vorhandenen Schlüssel und verweigert einen Zielordner im Repository.
Danach den ausgegebenen Ordner sichern (er enthält Keystore, OpenPGP-Schlüsselbund mit
Widerrufszertifikat und `FINGERPRINTS.txt`) und mit Schritt 4 weitermachen.

### Manuell

Alle Befehle lokal auf einem vertrauenswürdigen Rechner ausführen, **nicht** im Repository-Ordner
(`*.jks` ist zwar per `.gitignore` ausgeschlossen, trotzdem außerhalb ablegen).

### 1. Android-Release-Keystore

```sh
keytool -genkeypair -v \
  -keystore basalt-release.jks -storetype PKCS12 \
  -alias basalt -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Basalt, O=Basalt"
```

`keytool` fragt nach einem Passwort. Bei PKCS12 sind Keystore- und Schlüsselpasswort gleich;
dasselbe Passwort für beide Secrets eintragen.

> **Wichtig:** Diesen Keystore und das Passwort sicher sichern (z. B. Passwortmanager plus
> Offline-Kopie). Geht der Schlüssel verloren, können installierte Apps keine Updates mehr
> erhalten. Wird er kompromittiert, kann ein Dritter „Updates“ ausliefern.

### 2. OpenPGP-Schlüssel für Linux-Pakete und Prüfsummen

```sh
gpg --quick-gen-key "Basalt Release Signing <deine-adresse@example.org>" ed25519 sign 2y
gpg --list-secret-keys --keyid-format long      # Fingerabdruck notieren
gpg --armor --export-secret-keys <FINGERABDRUCK> > basalt-release-private.asc
```

Für die CI einen eigenen Schlüssel verwenden, nicht den persönlichen Hauptschlüssel. Das
Ablaufdatum (2 Jahre) lässt sich später mit `gpg --quick-set-expire` verlängern; das
Widerrufszertifikat unter `~/.gnupg/openpgp-revocs.d/` sicher aufbewahren.

### 3. GitHub-Secrets anlegen

Unter **Settings → Environments → New environment** eine Umgebung `release` anlegen (optional mit
„Required reviewers“, damit jeder Release-Lauf bestätigt werden muss) und dort diese Secrets
eintragen. Alternativ funktionieren auch gleichnamige Repository-Secrets.

| Secret                              | Inhalt                                                         |
| ----------------------------------- | -------------------------------------------------------------- |
| `ANDROID_RELEASE_KEYSTORE`          | `base64 -w0 basalt-release.jks` (eine Zeile)                   |
| `ANDROID_RELEASE_KEYSTORE_PASSWORD` | Keystore-Passwort                                              |
| `ANDROID_RELEASE_KEY_ALIAS`         | `basalt` (bzw. der bei `-alias` gewählte Name)                 |
| `ANDROID_RELEASE_KEY_PASSWORD`      | Schlüsselpasswort (bei PKCS12 identisch zum Keystore-Passwort) |
| `RELEASE_GPG_PRIVATE_KEY`           | kompletter Inhalt von `basalt-release-private.asc`             |
| `RELEASE_GPG_PASSPHRASE`            | Passphrase des OpenPGP-Schlüssels                              |

Mit der GitHub-CLI geht das z. B. so:

```sh
base64 -w0 basalt-release.jks | gh secret set ANDROID_RELEASE_KEYSTORE --env release
gh secret set ANDROID_RELEASE_KEYSTORE_PASSWORD --env release
gh secret set ANDROID_RELEASE_KEY_ALIAS --env release --body basalt
gh secret set ANDROID_RELEASE_KEY_PASSWORD --env release
gh secret set RELEASE_GPG_PRIVATE_KEY --env release < basalt-release-private.asc
gh secret set RELEASE_GPG_PASSPHRASE --env release
```

Danach `basalt-release-private.asc` löschen (`shred -u`) und nur die gesicherte Kopie behalten.
Das bestehende `ANDROID_DEBUG_KEYSTORE` bleibt für die normalen CI-Vorschau-Builds unverändert.

### 4. Probelauf

Unter **Actions → Signed release → Run workflow** startet ein Probelauf: Alles wird gebaut und
signiert, aber nur als Actions-Artefakt `Basalt-v<version>-dryrun-signed` hochgeladen. Ein
fehlendes Secret bricht den Lauf sofort mit einer klaren Meldung ab.

Zwischen den Jobs reisen die Pakete über den Actions-Cache, nicht über Artefakte: Der
Artefakt-Speicher eines privaten Repositorys (500 MB im Free-Plan) ist für ein Release zu klein und
wird mit der CI geteilt. Ist er voll, gelingt der Probelauf trotzdem (gebaut, signiert und geprüft),
nur das Download-Artefakt fehlt dann. Tag-Releases hängen die Dateien direkt an den
Release-Entwurf.

## Release erstellen

1. Version in `package.json`, `src-tauri/tauri.conf.json` und `src-tauri/Cargo.toml` gleich
   setzen (der Workflow prüft das). Android leitet den `versionCode` aus dieser Version ab, daher
   für jedes Release, das als Update installiert werden soll, die Version erhöhen.
2. Optional Release-Notizen unter `docs/releases/<version>.md` ablegen, z. B.
   `docs/releases/0.2.0.md` für das Tag `v0.2.0`. Sie werden in den Release-Text übernommen.
3. Tag pushen:

   ```sh
   git tag -a v0.2.0 -m "Basalt 0.2.0"
   git push origin v0.2.0
   ```

   Ein Tag mit Suffix (`v0.2.0-preview.1`) wird als Vorabversion markiert; der Teil vor dem
   Bindestrich muss der App-Version entsprechen.

4. Den Release-Entwurf auf GitHub prüfen und veröffentlichen.

## Downloads prüfen

```sh
gpg --import basalt-release-key.asc        # Fingerabdruck mit README/SIGNING.txt vergleichen
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS
gpg --verify Basalt_0.2.0_amd64.AppImage.asc Basalt_0.2.0_amd64.AppImage
apksigner verify --print-certs Basalt_0.2.0_android-universal.apk
```

Der von `apksigner` gezeigte Zertifikat-SHA-256 muss dem Wert in `SIGNING.txt` entsprechen.
Beide Fingerabdrücke stehen zusätzlich in der README, damit sie nicht nur über denselben Kanal wie
die Downloads verteilt werden.

## Grenzen und Hinweise

- **Wechsel vom Vorschau-APK:** Bisherige Vorschau-APKs sind mit dem Entwicklungsschlüssel
  signiert. Android installiert ein Release-APK nicht als Update darüber; die Vorschau muss
  zuerst deinstalliert werden. Notizen im privaten App-Vault vorher exportieren.
- **Google Play:** Die AAB ist mit dem Release-Schlüssel signiert. Mit Play App Signing dient er
  als Upload-Schlüssel; Google signiert die ausgelieferten APKs dann mit dem eigenen App-Schlüssel.
  Einen Play-Upload führt der Workflow nicht aus.
- **Linux-Pakete:** `.deb` und AppImage tragen keine eingebettete Signatur, sondern abgesetzte
  `.asc`-Dateien. Ein signiertes APT-Repository gibt es noch nicht.
- **Kein Auto-Update:** Der Tauri-Updater ist nicht eingebaut. Dafür bräuchte es das Plugin
  `tauri-plugin-updater`, einen eigenen Updater-Schlüssel und einen Update-Endpunkt; das ist ein
  getrennter Schritt.
- **Build-Provenance:** GitHub-Attestierungen (Sigstore) stehen für private Repositories nur mit
  GitHub Enterprise Cloud zur Verfügung und sind deshalb nicht aktiviert.
