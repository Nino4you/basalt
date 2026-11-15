import { isTauri } from "@tauri-apps/api/core";

/**
 * Pop-out windows show a single note in a window of its own (desktop only).
 *
 * The browser demo passes the path as `?popout=` on a normal `window.open`.
 * Native windows load the plain app URL and find their path under their
 * window label in localStorage, so no query string has to survive Tauri's
 * app URL handling.
 */

const QUERY = "popout";
const LABEL_PREFIX = "popout-";
const handoffKey = (label: string) => `basalt-popout:${JSON.stringify(label)}`;

/** The note this window was opened for, or null in the main window. */
export function popoutPath(
  search = location.search,
  storage: Pick<Storage, "getItem"> = localStorage,
): string | null {
  const fromQuery = new URLSearchParams(search).get(QUERY);
  if (fromQuery) return fromQuery;
  const label = nativeLabel();
  if (!label?.startsWith(LABEL_PREFIX)) return null;
  try {
    // Kept (not removed) so a reload of the pop-out shows the same note.
    return storage.getItem(handoffKey(label));
  } catch {
    return null;
  }
}

function nativeLabel(): string | null {
  if (!isTauri()) return null;
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__?: {
        metadata?: { currentWindow?: { label?: string } };
      };
    }
  ).__TAURI_INTERNALS__;
  return internals?.metadata?.currentWindow?.label ?? null;
}

/** Opens `path` in a new window; rejects when the window cannot be created. */
export async function openPopout(path: string, title: string): Promise<void> {
  const size = { width: 900, height: 720 };
  if (!isTauri()) {
    const url = new URL(location.href);
    url.search = new URLSearchParams({ [QUERY]: path }).toString();
    url.hash = "";
    const opened = window.open(
      url.toString(),
      "_blank",
      `popup,width=${size.width},height=${size.height}`,
    );
    if (!opened) throw new Error("blocked");
    return;
  }
  const label = `${LABEL_PREFIX}${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  localStorage.setItem(handoffKey(label), path);
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const popup = new WebviewWindow(label, {
    url: "index.html",
    title,
    ...size,
    minWidth: 320,
    minHeight: 320,
    dragDropEnabled: false,
    backgroundColor: "#161b1e",
  });
  await new Promise<void>((resolve, reject) => {
    void popup.once("tauri://created", () => resolve());
    void popup.once("tauri://error", (event) => {
      localStorage.removeItem(handoffKey(label));
      reject(new Error(String(event.payload)));
    });
  });
  void popup.once("tauri://destroyed", () =>
    localStorage.removeItem(handoffKey(label)),
  );
}

/**
 * Tells the app's other windows about saves, so a note open in two windows
 * shows the newest text instead of running into a save conflict later.
 */
export class SaveBroadcast {
  private readonly channel: BroadcastChannel | null;

  constructor(onSaved: (vaultId: string, path: string, text: string) => void) {
    this.channel =
      typeof BroadcastChannel === "function"
        ? new BroadcastChannel("basalt-saves")
        : null;
    this.channel?.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null;
      if (
        data &&
        typeof data.vaultId === "string" &&
        typeof data.path === "string" &&
        typeof data.text === "string"
      )
        onSaved(data.vaultId, data.path, data.text);
    });
  }

  post(vaultId: string, path: string, text: string): void {
    this.channel?.postMessage({ vaultId, path, text });
  }

  close(): void {
    this.channel?.close();
  }
}
