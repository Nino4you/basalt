#!/usr/bin/env bash
# Replaces the user ID (name and email) of the release OpenPGP key, for
# example to publish a noreply address instead of a personal one. The key and
# its fingerprint stay the same, so existing signatures and the fingerprint in
# the README remain valid.
#
# Works on the keyring created by setup_release_signing.sh: adds the new user
# ID, rebuilds the keyring with only that user ID (the old keyring is kept as
# gnupg.old-<time> until you delete it), writes basalt-release-key.asc and
# replaces the RELEASE_GPG_PRIVATE_KEY secret in the `release` environment.
# The passphrase is read from the terminal and only passed to gpg via stdin.
#
# Runs on Linux and in Git Bash on Windows. Needs gpg and a signed-in gh.
#
# Usage: tools/release_key_set_uid.sh <email> [keys-directory]
#   email           the new address, e.g. 1234+name@users.noreply.github.com
#   keys-directory  default: ~/basalt-release-keys
set -euo pipefail

REPO="${BASALT_REPO:-Nino4you/basalt}"
ENV_NAME="release"
NAME="${BASALT_KEY_NAME:-Basalt Release Signing}"
EMAIL="${1:-}"
OUT="${2:-$HOME/basalt-release-keys}"

die() {
  echo "Error: $*" >&2
  exit 1
}

[[ "$EMAIL" =~ ^[^[:space:]@\<\>]+@[^[:space:]@\<\>]+$ ]] || die "Usage: $0 <email> [keys-directory]"
for tool in gpg gpgconf gh; do
  command -v "$tool" > /dev/null || die "'$tool' not found."
done
gh auth status > /dev/null 2>&1 || die "GitHub CLI is not signed in: run 'gh auth login' first."
[ -d "$OUT/gnupg" ] || die "$OUT/gnupg not found."
OUT=$(cd "$OUT" && pwd)
NEW_UID="$NAME <$EMAIL>"
OLD_HOME="$OUT/gnupg"
NEW_HOME="$OUT/gnupg.new"
[ -e "$NEW_HOME" ] && die "$NEW_HOME exists from an earlier attempt; remove it first."

export GNUPGHOME="$OLD_HOME"
FPR=$(gpg --batch --with-colons --list-secret-keys | awk -F: '/^fpr:/ {print $10; exit}')
[ -n "$FPR" ] || die "No secret OpenPGP key in $OLD_HOME."

read -r -s -p "Passphrase of the OpenPGP key: " GPG_PASS
echo
# A passphrase cached by a running agent would hide a typo.
gpgconf --kill gpg-agent 2> /dev/null || true
gpg_pass() { printf '%s' "$GPG_PASS" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 "$@"; }
gpg_pass --local-user "$FPR" --output /dev/null --detach-sign "$OUT/FINGERPRINTS.txt" 2> /dev/null ||
  die "The OpenPGP passphrase is wrong."

echo "== Setting the user ID to: $NEW_UID"
if ! gpg --batch --with-colons --list-keys "$FPR" | awk -F: '$1 == "uid" {print $10}' | grep -qxF "$NEW_UID"; then
  gpg_pass --quick-add-uid "$FPR" "$NEW_UID"
fi
gpg_pass --quick-set-primary-uid "$FPR" "$NEW_UID"

echo "== Rebuilding the keyring with only the new user ID"
umask 077
mkdir -m 700 "$NEW_HOME"
gpg_pass --armor --export-secret-keys --export-filter "keep-uid=mbox = $EMAIL" "$FPR" |
  GNUPGHOME="$NEW_HOME" gpg --batch --quiet --import
gpg --batch --export-ownertrust | GNUPGHOME="$NEW_HOME" gpg --batch --quiet --import-ownertrust
if [ -d "$OLD_HOME/openpgp-revocs.d" ]; then cp -R "$OLD_HOME/openpgp-revocs.d" "$NEW_HOME/"; fi
export GNUPGHOME="$NEW_HOME"
uids=$(gpg --batch --with-colons --list-keys "$FPR" | awk -F: '$1 == "uid" {print $10}')
[ "$uids" = "$NEW_UID" ] || die "Unexpected user IDs in the new keyring: $uids"
gpg_pass --local-user "$FPR" --output /dev/null --detach-sign "$OUT/FINGERPRINTS.txt" ||
  die "The new keyring cannot sign."
gpgconf --kill gpg-agent 2> /dev/null || true
GNUPGHOME="$OLD_HOME" gpgconf --kill gpg-agent 2> /dev/null || true
backup="$OUT/gnupg.old-$(date +%Y%m%d-%H%M%S)"
mv "$OLD_HOME" "$backup"
mv "$NEW_HOME" "$OLD_HOME"
export GNUPGHOME="$OLD_HOME"
gpg --batch --armor --export "$FPR" > "$OUT/basalt-release-key.asc"

echo "== Replacing RELEASE_GPG_PRIVATE_KEY in '$ENV_NAME' of $REPO"
gpg_pass --armor --export-secret-keys "$FPR" |
  gh secret set RELEASE_GPG_PRIVATE_KEY --repo "$REPO" --env "$ENV_NAME" > /dev/null
unset GPG_PASS

cat << DONE

Done. The key $FPR now carries only:
  $NEW_UID
The fingerprint is unchanged. New public key: $OUT/basalt-release-key.asc
The previous keyring (with the old user ID) is kept in:
  $backup
Delete it once you have checked the new one; back up $OUT again.
Releases built from now on ship the new public key. To replace the key file
of an already published release:
  gh release upload <tag> "$OUT/basalt-release-key.asc" --clobber --repo $REPO
DONE
