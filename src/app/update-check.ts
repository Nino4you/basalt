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
  /** Download URL of the signed universal Android APK, when the release has one. */
  apk?: string;
}

/** Release downloads are only accepted from Basalt's own release assets. */
export const RELEASE_DOWNLOADS =
  "https://github.com/Nino4you/basalt/releases/download/";

/** The universal APK among a release's assets, e.g. `Basalt_0.5.0_android-universal.apk`. */
export function androidApk(assets: unknown, version: string): string | null {
  if (!Array.isArray(assets)) return null;
  const name = `Basalt_${version}_android-universal.apk`;
  for (const asset of assets) {
    const value = asset as Record<string, unknown> | null;
    const url = value?.browser_download_url;
    if (
      value?.name === name &&
      typeof url === "string" &&
      url.startsWith(RELEASE_DOWNLOADS) &&
      url.endsWith(`/${name}`)
    )
      return url;
  }
  return null;
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
  const version = tag.replace(/^v/i, "");
  const apk = androidApk(value?.assets, version);
  return {
    version,
    url,
    notes: typeof value?.body === "string" ? value.body : "",
    ...(apk ? { apk } : {}),
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
 * installer); Android through the activity's installer bridge (see
 * `androidUpdater`). The browser demo only announces new releases.
 */
export const selfUpdating =
  isTauri() && !/Android/i.test(globalThis.navigator?.userAgent ?? "");

/**
 * The installer bridge of the patched Android activity (tools/patch_android.mjs).
 * Missing in store builds, which update through their store.
 */
interface AndroidUpdateBridge {
  installUpdate(url: string, version: string): boolean;
}

export function androidUpdater(): AndroidUpdateBridge | null {
  const bridge = (
    globalThis as { BasaltAndroid?: Partial<AndroidUpdateBridge> }
  ).BasaltAndroid;
  return typeof bridge?.installUpdate === "function"
    ? (bridge as AndroidUpdateBridge)
    : null;
}

/** Events of the Android installer, sent as `basalt-update` window events. */
interface AndroidUpdateEvent {
  state:
    | "progress"
    | "signature-checked"
    | "confirm"
    | "installed"
    | "cancelled"
    | "error";
  downloaded?: number;
  total?: number;
  message?: string;
}

/**
 * Lets the activity download the APK, check that it is Basalt in exactly
 * `version` signed with the installed app's certificate, and hand it to the
 * system installer. Android asks the user to confirm and then replaces the
 * app, which ends this process; a cancelled confirmation or a failed step
 * rejects, so the caller can offer the button again.
 */
export function installAndroidUpdate(
  update: AvailableUpdate,
  onProgress: (progress: UpdateProgress) => void,
  bridge = androidUpdater(),
  target: EventTarget = window,
): Promise<void> {
  const apk = update.apk;
  if (!bridge || !apk || !apk.startsWith(RELEASE_DOWNLOADS))
    return Promise.reject(new Error("No installable Android package"));
  return new Promise((resolve, reject) => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<AndroidUpdateEvent>).detail;
      if (!detail || typeof detail !== "object") return;
      if (detail.state === "progress")
        onProgress({
          downloaded: Number(detail.downloaded) || 0,
          total: Number(detail.total) > 0 ? Number(detail.total) : null,
        });
      else if (detail.state === "installed") {
        target.removeEventListener("basalt-update", listener);
        resolve();
      } else if (detail.state === "cancelled" || detail.state === "error") {
        target.removeEventListener("basalt-update", listener);
        reject(
          new AndroidUpdateError(detail.state, String(detail.message ?? "")),
        );
      }
    };
    target.addEventListener("basalt-update", listener);
    if (!bridge.installUpdate(apk, update.version)) {
      target.removeEventListener("basalt-update", listener);
      reject(new AndroidUpdateError("busy", ""));
    }
  });
}

export class AndroidUpdateError extends Error {
  constructor(
    readonly state: "cancelled" | "error" | "busy",
    detail: string,
  ) {
    super(detail || state);
  }
}

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
  return (
    release && {
      ...release,
      installable: !!release.apk && androidUpdater() !== null,
    }
  );
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
