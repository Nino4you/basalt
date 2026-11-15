/**
 * Object URLs of decoded vault images, shared by the reading view and the
 * live preview. Moving the cursor onto an embed line in the editor re-creates
 * its widget; without the cache every such move would read the image again
 * through the native bridge and let the text jump while it loads.
 *
 * Entries belong to one vault session and are keyed by path, size and
 * modification time, so a changed file is read again. The oldest URLs are
 * revoked once the cache holds more than `MAX_BYTES` or `MAX_ENTRIES`.
 */
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 256;

interface Entry {
  url: string;
  bytes: number;
}

export class ImageCacheCleared extends Error {
  constructor() {
    super("Image cache cleared");
  }
}

let owner: object | null = null;
const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<string>>();
let total = 0;

function claim(session: object): void {
  if (owner === session) return;
  clearImageCache();
  owner = session;
}

/** Revokes every cached URL; the app calls it when the vault changes. */
export function clearImageCache(): void {
  for (const entry of entries.values()) URL.revokeObjectURL(entry.url);
  entries.clear();
  pending.clear();
  total = 0;
  owner = null;
}

/**
 * The object URL for `key` in `session`, loading it with `load` once. A
 * failed load is not cached.
 */
export function cachedImageUrl(
  session: object,
  key: string,
  load: () => Promise<Blob>,
): Promise<string> {
  claim(session);
  const hit = entries.get(key);
  if (hit) {
    // Re-insert so the map order stays least recently used first.
    entries.delete(key);
    entries.set(key, hit);
    return Promise.resolve(hit.url);
  }
  const running = pending.get(key);
  if (running) return running;
  const promise = load().then(
    (blob) => {
      // The cache was cleared meanwhile: the vault changed, nobody waits.
      if (pending.get(key) !== promise) throw new ImageCacheCleared();
      pending.delete(key);
      const url = URL.createObjectURL(blob);
      entries.set(key, { url, bytes: blob.size });
      total += blob.size;
      evict();
      return url;
    },
    (error: unknown) => {
      if (pending.get(key) === promise) pending.delete(key);
      throw error;
    },
  );
  pending.set(key, promise);
  return promise;
}

function evict(): void {
  for (const [key, entry] of entries) {
    if (total <= MAX_BYTES && entries.size <= MAX_ENTRIES) return;
    // Keep the newest entry even when it alone exceeds the budget.
    if (entries.size === 1) return;
    entries.delete(key);
    total -= entry.bytes;
    URL.revokeObjectURL(entry.url);
  }
}
