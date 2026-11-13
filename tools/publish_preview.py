"""Publish only successful main-branch CI artifacts matching the clean local commit."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
REPO = "Nino4you/basalt"


def output(*command):
    return subprocess.check_output(command, cwd=ROOT, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_id", type=int)
    parser.add_argument("--publish", action="store_true", help="Actually create the prerelease")
    args = parser.parse_args()
    if output("git", "status", "--porcelain"):
        raise SystemExit("Refusing to publish a dirty working tree")
    commit = output("git", "rev-parse", "HEAD")
    run = json.loads(output("gh", "api", f"repos/{REPO}/actions/runs/{args.run_id}"))
    if not (
        run["conclusion"] == "success"
        and run["head_sha"] == commit
        and run["head_branch"] == "main"
        and run["event"] in {"push", "workflow_dispatch"}
    ):
        raise SystemExit("CI must succeed on this exact main-branch commit; no PR artifacts allowed")

    destination = Path(f"/tmp/basalt-preview-{args.run_id}")
    destination.mkdir(exist_ok=False)
    for name in ("Basalt-linux-x86_64", "Basalt-android-arm64-preview"):
        subprocess.run([
            "gh", "run", "download", str(args.run_id), "--repo", REPO,
            "--name", name, "--dir", str(destination / name),
        ], cwd=ROOT, check=True)
    assets = []
    for suffix in (".deb", ".AppImage", ".apk"):
        found = list(destination.rglob(f"*{suffix}"))
        if len(found) != 1:
            raise SystemExit(f"Expected exactly one {suffix} artifact, found {len(found)}")
        asset = destination / found[0].name
        shutil.copyfile(found[0], asset)
        assets.append(asset)
    checksum_file = destination / "SHA256SUMS"
    checksums = []
    for asset in assets:
        with asset.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        checksums.append(f"{digest}  {asset.name}")
    checksum_file.write_text("\n".join(checksums) + "\n")
    assets.append(checksum_file)

    notes = destination / "release-notes.md"
    notes.write_text(
        (ROOT / "docs/releases/0.1.0-preview.1.md").read_text()
        + f"\n\nBuild: `{commit}` · [CI-Nachweis]({run['html_url']})\n"
    )
    print(f"Verified release inputs: {destination}")
    print("\n".join(checksums))
    if args.publish:
        subprocess.run([
            "gh", "release", "create", "v0.1.0-preview.1", "--repo", REPO,
            "--target", commit, "--prerelease", "--title", "Basalt 0.1.0 — erste Vorschau",
            "--notes-file", str(notes), *(str(asset) for asset in assets),
        ], cwd=ROOT, check=True)
    else:
        print("Dry run only. No GitHub release was created.")


if __name__ == "__main__":
    main()
