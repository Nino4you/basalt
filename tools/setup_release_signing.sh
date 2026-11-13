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
  echo "Error: $*" >&2
  exit 1
}

for tool in keytool gpg base64 gh; do
  command -v "$tool" > /dev/null || die "'$tool' not found (see docs/release-signing.md)."
done
gh auth status > /dev/null 2>&1 || die "GitHub CLI is not signed in: run 'gh auth login' first."

repo_root=$(git rev-parse --show-toplevel 2> /dev/null || true)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
if [ -n "$repo_root" ]; then
  case "$OUT/" in "$(cd "$repo_root" && pwd)/"*) die "$OUT is inside the repository. Please choose a folder outside of it." ;; esac
fi
chmod 700 "$OUT"

KEYSTORE="$OUT/basalt-release.jks"
GNUPGHOME="$OUT/gnupg"
export GNUPGHOME
[ -e "$KEYSTORE" ] && die "$KEYSTORE already exists. Existing keys are never overwritten."
[ -e "$GNUPGHOME" ] && die "$GNUPGHOME already exists. Existing keys are never overwritten."

read_secret() {
  # $1 prompt, result in REPLY_SECRET; asks twice and requires 12+ characters.
  local first second
  while true; do
    read -r -s -p "$1: " first
    echo
    read -r -s -p "$1 (repeat): " second
    echo
    if [ "$first" != "$second" ]; then
      echo "The entries do not match." >&2
    elif [ "${#first}" -lt 12 ]; then
      echo "Please use at least 12 characters." >&2
    else
      REPLY_SECRET="$first"
      return
    fi
  done
}

read -r -p "Email address for the OpenPGP key: " email
[ -n "$email" ] || die "No email address given."
read_secret "Password for the Android keystore"
KS_PASS="$REPLY_SECRET"
read_secret "Passphrase for the OpenPGP key"
GPG_PASS="$REPLY_SECRET"
export KS_PASS

echo
echo "== Creating the Android release keystore"
umask 077
keytool -genkeypair -v -keystore "$KEYSTORE" -storetype PKCS12 \
  -alias "$KEY_ALIAS" -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Basalt, O=Basalt" \
  -storepass:env KS_PASS -keypass:env KS_PASS -noprompt
android_sha256=$(keytool -list -v -keystore "$KEYSTORE" -storepass:env KS_PASS -alias "$KEY_ALIAS" |
  sed -n 's/^[[:space:]]*SHA256: //p' | head -n1)

echo "== Creating the OpenPGP key (separate keyring in $GNUPGHOME)"
mkdir -m 700 "$GNUPGHOME"
printf '%s' "$GPG_PASS" | gpg --batch --pinentry-mode loopback --passphrase-fd 0 \
  --quick-gen-key "Basalt Release Signing <$email>" ed25519 sign 2y
GPG_FPR=$(gpg --batch --with-colons --list-secret-keys | awk -F: '/^fpr:/ {print $10; exit}')
[ -n "$GPG_FPR" ] || die "The OpenPGP key was not created."
gpg --batch --armor --export "$GPG_FPR" > "$OUT/basalt-release-key.asc"

echo "== Creating the GitHub environment '$ENV_NAME' in $REPO"
gh api --silent -X PUT "repos/$REPO/environments/$ENV_NAME"

echo "== Storing secrets in '$ENV_NAME'"
set_secret() {
  gh secret set "$1" --repo "$REPO" --env "$ENV_NAME" > /dev/null
  echo "   $1 set"
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

Done. All six secrets are stored in the environment '$ENV_NAME' of $REPO.

Back up this folder now (password manager plus an offline copy):
  $OUT
It contains the Android keystore, the OpenPGP keyring with its
revocation certificate (gnupg/openpgp-revocs.d/) and the fingerprints.
Without the keystore and its password, Basalt on Android can no longer receive updates.

Fingerprints (public, for the README and for verifying downloads):
$(cat "$OUT/FINGERPRINTS.txt")
EOF
