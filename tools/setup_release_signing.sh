#!/usr/bin/env bash
# One-time setup for signed Basalt releases (see docs/release-signing.md).
#
# Generates the Android release keystore and a dedicated OpenPGP signing key,
# creates the GitHub environment `release` and stores the six signing secrets
# there through the GitHub CLI. Passwords are read from the terminal and only
# handed to the tools through environment variables or stdin; nothing secret is
# printed, written into the repository or passed on a command line.
#
# Runs on Linux and in Git Bash on Windows. Needs: keytool (JDK, e.g. Android
# Studio's jbr/bin), gpg, base64, and gh (logged in with `gh auth login`).
#
# Usage: tools/setup_release_signing.sh [output-directory]
#   output-directory  where keys are kept (default: ~/basalt-release-keys);
#                     must be outside the repository. Back it up afterwards.
set -euo pipefail

REPO="${BASALT_REPO:-Nino4you/basalt}"
ENV_NAME="release"
KEY_ALIAS="basalt"
OUT="${1:-$HOME/basalt-release-keys}"

die() {
  echo "Fehler: $*" >&2
  exit 1
}

for tool in keytool gpg base64 gh; do
  command -v "$tool" > /dev/null || die "'$tool' nicht gefunden (siehe docs/release-signing.md)."
done
gh auth status > /dev/null 2>&1 || die "GitHub-CLI ist nicht angemeldet: zuerst 'gh auth login' ausführen."

repo_root=$(git rev-parse --show-toplevel 2> /dev/null || true)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
if [ -n "$repo_root" ]; then
  case "$OUT/" in "$(cd "$repo_root" && pwd)/"*) die "$OUT liegt im Repository. Bitte einen Ordner außerhalb wählen." ;; esac
fi
chmod 700 "$OUT"

KEYSTORE="$OUT/basalt-release.jks"
GNUPGHOME="$OUT/gnupg"
export GNUPGHOME
[ -e "$KEYSTORE" ] && die "$KEYSTORE existiert bereits. Vorhandene Schlüssel werden nicht überschrieben."
[ -e "$GNUPGHOME" ] && die "$GNUPGHOME existiert bereits. Vorhandene Schlüssel werden nicht überschrieben."

read_secret() {
  # $1 prompt, result in REPLY_SECRET; asks twice and requires 12+ characters.
  local first second
  while true; do
    read -r -s -p "$1: " first
    echo
    read -r -s -p "$1 (Wiederholung): " second
    echo
    if [ "$first" != "$second" ]; then
      echo "Die Eingaben stimmen nicht überein." >&2
    elif [ "${#first}" -lt 12 ]; then
      echo "Bitte mindestens 12 Zeichen verwenden." >&2
    else
      REPLY_SECRET="$first"
      return
    fi
  done
}

read -r -p "E-Mail-Adresse für den OpenPGP-Schlüssel: " email
[ -n "$email" ] || die "Keine E-Mail-Adresse angegeben."
read_secret "Passwort für den Android-Keystore"
KS_PASS="$REPLY_SECRET"
read_secret "Passphrase für den OpenPGP-Schlüssel"
GPG_PASS="$REPLY_SECRET"
export KS_PASS

echo
echo "== Android-Release-Keystore erzeugen"
umask 077
keytool -genkeypair -v -keystore "$KEYSTORE" -storetype PKCS12 \
  -alias "$KEY_ALIAS" -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Basalt, O=Basalt" \
  -storepass:env KS_PASS -keypass:env KS_PASS -noprompt
android_sha256=$(keytool -list -v -keystore "$KEYSTORE" -storepass:env KS_PASS -alias "$KEY_ALIAS" |
  sed -n 's/^[[:space:]]*SHA256: //p' | head -n1)

echo "== OpenPGP-Schlüssel erzeugen (eigener Schlüsselbund in $GNUPGHOME)"
mkdir -m 700 "$GNUPGHOME"
printf '%s' "$GPG_PASS" | gpg --batch --pinentry-mode loopback --passphrase-fd 0 \
  --quick-gen-key "Basalt Release Signing <$email>" ed25519 sign 2y
GPG_FPR=$(gpg --batch --with-colons --list-secret-keys | awk -F: '/^fpr:/ {print $10; exit}')
[ -n "$GPG_FPR" ] || die "OpenPGP-Schlüssel wurde nicht erzeugt."
gpg --batch --armor --export "$GPG_FPR" > "$OUT/basalt-release-key.asc"

echo "== GitHub-Umgebung '$ENV_NAME' in $REPO anlegen"
gh api --silent -X PUT "repos/$REPO/environments/$ENV_NAME"

echo "== Secrets in '$ENV_NAME' speichern"
set_secret() {
  gh secret set "$1" --repo "$REPO" --env "$ENV_NAME" > /dev/null
  echo "   $1 gesetzt"
}
base64 < "$KEYSTORE" | tr -d '\r\n' | set_secret ANDROID_RELEASE_KEYSTORE
printf '%s' "$KS_PASS" | set_secret ANDROID_RELEASE_KEYSTORE_PASSWORD
printf '%s' "$KEY_ALIAS" | set_secret ANDROID_RELEASE_KEY_ALIAS
# PKCS12 keystores use the store password for the key as well.
printf '%s' "$KS_PASS" | set_secret ANDROID_RELEASE_KEY_PASSWORD
printf '%s' "$GPG_PASS" | gpg --batch --pinentry-mode loopback --passphrase-fd 0 \
  --armor --export-secret-keys "$GPG_FPR" | set_secret RELEASE_GPG_PRIVATE_KEY
printf '%s' "$GPG_PASS" | set_secret RELEASE_GPG_PASSPHRASE
unset KS_PASS GPG_PASS REPLY_SECRET

cat > "$OUT/FINGERPRINTS.txt" << EOF
OpenPGP release key fingerprint: $GPG_FPR
Android signing certificate SHA-256: $android_sha256
EOF

cat << EOF

Fertig. Alle sechs Secrets liegen in der Umgebung '$ENV_NAME' von $REPO.

Jetzt unbedingt den Ordner sichern (Passwortmanager plus Offline-Kopie):
  $OUT
Er enthält den Android-Keystore, den OpenPGP-Schlüsselbund mit
Widerrufszertifikat (gnupg/openpgp-revocs.d/) und die Fingerabdrücke.
Ohne Keystore und Passwort kann Basalt auf Android keine Updates mehr erhalten.

Fingerabdrücke (öffentlich, für README und Prüfung der Downloads):
$(cat "$OUT/FINGERPRINTS.txt")
EOF
