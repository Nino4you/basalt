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
# Usage: tools/setup_release_signing.sh [--reuse] [output-directory]
#   --reuse           do not create keys: store the existing keys from
#                     output-directory (for example after moving to a new
#                     repository). Checks both passwords and compares the
#                     fingerprints with the README before anything is stored.
#   output-directory  where keys are kept (default: ~/basalt-release-keys);
#                     must be outside the repository. Back it up afterwards.
set -euo pipefail

REPO="${BASALT_REPO:-Nino4you/basalt}"
ENV_NAME="release"
KEY_ALIAS="basalt"
REUSE=false
if [ "${1:-}" = "--reuse" ]; then
  REUSE=true
  shift
fi
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
if $REUSE; then
  [ -d "$OUT" ] || die "$OUT does not exist."
else
  mkdir -p "$OUT"
fi
OUT=$(cd "$OUT" && pwd)
if [ -n "$repo_root" ]; then
  case "$OUT/" in "$(cd "$repo_root" && pwd)/"*) die "$OUT is inside the repository. Please choose a folder outside of it." ;; esac
fi
chmod 700 "$OUT"

KEYSTORE="$OUT/basalt-release.jks"
GNUPGHOME="$OUT/gnupg"
export GNUPGHOME
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

norm() { tr -d ' :\r\n' | tr '[:lower:]' '[:upper:]'; }

# The fingerprint in the README, or nothing outside a checkout.
readme_fingerprint() {
  [ -n "$repo_root" ] && [ -f "$repo_root/README.md" ] || return 0
  grep -F "| $1" "$repo_root/README.md" | head -n1 | cut -d'`' -f2 | norm
}

if $REUSE; then
  [ -f "$KEYSTORE" ] || die "$KEYSTORE not found."
  [ -d "$GNUPGHOME" ] || die "$GNUPGHOME not found."
  read -r -s -p "Password of the existing Android keystore: " KS_PASS
  echo
  read -r -s -p "Passphrase of the existing OpenPGP key: " GPG_PASS
  echo
  export KS_PASS

  echo
  echo "== Checking the existing keys"
  android_sha256=$(keytool -list -v -keystore "$KEYSTORE" -storepass:env KS_PASS -alias "$KEY_ALIAS" 2> /dev/null |
    sed -n 's/^[[:space:]]*SHA256: //p' | head -n1) || true
  [ -n "$android_sha256" ] || die "Cannot open $KEYSTORE (wrong password or no alias '$KEY_ALIAS')."
  GPG_FPR=$(gpg --batch --with-colons --list-secret-keys | awk -F: '/^fpr:/ {print $10; exit}')
  [ -n "$GPG_FPR" ] || die "No secret OpenPGP key in $GNUPGHOME."
  # A passphrase cached by a running agent would hide a typo.
  gpgconf --kill gpg-agent 2> /dev/null || true
  printf '%s' "$GPG_PASS" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
    --local-user "$GPG_FPR" --output /dev/null --detach-sign "$KEYSTORE" 2> /dev/null ||
    die "The OpenPGP passphrase is wrong."

  expected_gpg=$(readme_fingerprint "OpenPGP")
  expected_android=$(readme_fingerprint "Android certificate")
  [ -n "$expected_gpg" ] && [ -n "$expected_android" ] ||
    die "No fingerprints found in README.md. Run the script from a checkout of the repository."
  [ "$expected_gpg" = "$(printf '%s' "$GPG_FPR" | norm)" ] ||
    die "The OpenPGP key in $GNUPGHOME is not the one in the README. Nothing was stored."
  [ "$expected_android" = "$(printf '%s' "$android_sha256" | norm)" ] ||
    die "The keystore is not the one in the README; apps signed with it could not update. Nothing was stored."
  echo "   Both keys match the README fingerprints."
else
  [ -e "$KEYSTORE" ] && die "$KEYSTORE already exists. Existing keys are never overwritten."
  [ -e "$GNUPGHOME" ] && die "$GNUPGHOME already exists. Existing keys are never overwritten."

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
fi

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

$REUSE || cat > "$OUT/FINGERPRINTS.txt" << EOF
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
