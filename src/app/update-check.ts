import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { RequestUrl } from "../compat/request";
import { compareVersions } from "../compat/plugin-catalog";

/** Basalt's own releases; asked only when the user wants update checks. */
export const RELEASE_API =
  "https://api.github.com/repos/Nino4you/basalt/releases/latest";
export const RELEASE_PAGE =
  "https://github.com/Nino4you/basalt/releases/latest";

const KEY = "basalt-update-check";
/** Automatic checks run at most once a day. */
export const CHECK_INTERVAL = 24 * 60 * 60 * 1000;

export interface ReleaseInfo {
  version: string;
  url: string;
  /** Release notes as Markdown, possibly empty. */
  notes: string;
}

/** The latest published release (drafts and pre-releases are not "latest"). */
export async function latestRelease(request: RequestUrl): Promise<ReleaseInfo> {
  const response = await request({
    url: RELEASE_API,
    headers: { Accept: "application/vnd.github+json" },
  });
  const value = response.json as Record<string, unknown> | null;
  const tag = typeof value?.tag_name === "string" ? value.tag_name : "";
  if (!/^v?\d+\.\d+/.test(tag))
    throw new Error(`Unexpected release tag: ${tag || "none"}`);
  const url =
    typeof value?.html_url === "string" &&
    value.html_url.startsWith("https://github.com/")
      ? value.html_url
      : RELEASE_PAGE;
  return {
    version: tag.replace(/^v/i, ""),
    url,
    notes: typeof value?.body === "string" ? value.body : "",
  };
}

/** A newer release; `installable` when the app can install it itself. */
export interface AvailableUpdate extends ReleaseInfo {
  installable: boolean;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

/**
 * The desktop app installs signed updates itself (AppImage, .deb, Windows
 * installer). Android and the browser demo only announce new releases.
 */
export const selfUpdating =
  isTauri() && !/Android/i.test(globalThis.navigator?.userAgent ?? "");

/** Asks the native updater (signed `latest.json` of the latest release). */
export async function checkSignedUpdate(): Promise<AvailableUpdate | null> {
  const found = await invoke<{
    version: string;
    notes: string;
    installable: boolean;
  } | null>("app_update_check");
  return found && { ...found, url: RELEASE_PAGE };
}

/**
 * Downloads, verifies and installs the update from the last check; the app
 * restarts on success. Save every open buffer before calling this.
 */
export async function installSignedUpdate(
  onProgress: (progress: UpdateProgress) => void,
): Promise<void> {
  const channel = new Channel<UpdateProgress>();
  channel.onmessage = onProgress;
  await invoke("app_update_install", { onProgress: channel });
}

/**
 * The newer release for this platform. The signed updater is asked first
 * where it exists; when it fails (e.g. a release without `latest.json`), the
 * GitHub release is still announced with a download link.
 */
export async function findUpdate(
  request: RequestUrl,
  current: string,
  signed: (() => Promise<AvailableUpdate | null>) | null = selfUpdating
    ? checkSignedUpdate
    : null,
): Promise<AvailableUpdate | null> {
  if (signed) {
    try {
      return await signed();
    } catch (error) {
      console.warn("Signed update check failed:", error);
    }
  }
  const release = await checkForUpdate(request, current);
  return release && { ...release, installable: false };
}

/** The newer release, or null when `current` is up to date. */
export async function checkForUpdate(
  request: RequestUrl,
  current: string,
): Promise<ReleaseInfo | null> {
  const latest = await latestRelease(request);
  return compareVersions(latest.version, current) > 0 ? latest : null;
}

/** Whether a daily automatic check is due; records the attempt when it is. */
export function updateCheckDue(now = Date.now()): boolean {
  try {
    const last = Number(localStorage.getItem(KEY) ?? 0);
    if (last && last <= now && now - last < CHECK_INTERVAL) return false;
    localStorage.setItem(KEY, String(now));
  } catch {
    // Without storage, check on each start; that is still rare.
  }
  return true;
}
