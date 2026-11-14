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
