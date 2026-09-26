// In-memory, session-scoped image cache. Images are fetched once, kept as Blobs
// and exposed via object URLs so re-renders (and navigating back to a page)
// reuse them instantly with zero network activity. Nothing is ever persisted —
// the cache lives only while the tab is open and is revoked on unload.
//
// Degrades gracefully: if object URLs aren't available, load() returns the
// original URL so callers just set src directly, as before.

import { withBase } from './basePath.js';

const SUPPORTED =
  typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';

const MAX_ENTRIES = 300;
const MAX_BYTES = 150 * 1024 * 1024; // 150 MB

// Map preserves insertion order → we use it directly as an LRU: least-recently
// used is the first key, most-recently used is re-inserted at the end.
const store = new Map(); // url -> { objectUrl, size }
const inflight = new Map(); // url -> Promise<string>
let totalBytes = 0;

function touch(url) {
  const entry = store.get(url);
  if (entry) {
    store.delete(url);
    store.set(url, entry); // move to most-recently-used
  }
  return entry;
}

function removeEntry(url) {
  const entry = store.get(url);
  if (!entry) return;
  try {
    URL.revokeObjectURL(entry.objectUrl);
  } catch {
    /* ignore */
  }
  totalBytes -= entry.size || 0;
  store.delete(url);
}

function evictOldest() {
  const oldest = store.keys().next().value;
  if (oldest !== undefined) removeEntry(oldest);
}

function enforceLimits() {
  while (store.size > MAX_ENTRIES) evictOldest();
  while (totalBytes > MAX_BYTES && store.size > 0) evictOldest();
}

// --- Global image-fetch concurrency scheduler -----------------------------
// Every network image fetch — user-initiated loads AND background preloads —
// funnels through here, so the two together never exceed a fixed number of
// simultaneous requests. User loads run at normal priority and are always
// dequeued before preloads; preloads additionally have a lower concurrency cap,
// so there is always connection headroom for a sudden user burst. Net effect:
// preloading can never delay a user-initiated image.
const MAX_ACTIVE = 6;
const MAX_PRELOAD_ACTIVE = 4;
let active = 0;
let preloadActive = 0;
const userQueue = [];
const preloadQueue = [];

function pumpQueues() {
  while (active < MAX_ACTIVE && userQueue.length) runQueued(userQueue.shift(), false);
  // Only start preloads when no user load is waiting, and never past their cap.
  while (
    active < MAX_ACTIVE &&
    preloadActive < MAX_PRELOAD_ACTIVE &&
    preloadQueue.length &&
    !userQueue.length
  ) {
    runQueued(preloadQueue.shift(), true);
  }
}
function runQueued(job, isPreload) {
  active++;
  if (isPreload) preloadActive++;
  job.run().finally(() => {
    active--;
    if (isPreload) preloadActive--;
    pumpQueues();
  });
}
// Run `task` (an async fn) under the scheduler; resolves with its result.
function scheduleFetch(task, isPreload) {
  return new Promise((resolve) => {
    const q = isPreload ? preloadQueue : userQueue;
    q.push({ run: () => task().then(resolve, resolve) });
    pumpQueues();
  });
}

export const imageCache = {
  // Returns the cached object URL (marking it most-recently-used), or null.
  get(url) {
    if (!url) return null;
    url = withBase(url); // server emits root-absolute paths; serve under /base
    const entry = touch(url);
    return entry ? entry.objectUrl : null;
  },

  // Returns a usable image URL for `url`: the cached object URL if present,
  // otherwise fetches + caches it. On any failure (or when unsupported) resolves
  // to the original URL so the caller can still display the image.
  // opts.preload: fetch at low (background) priority — used by the preloader so
  // it yields to user-initiated loads. Omitted → normal (user) priority.
  load(url, opts) {
    if (!url) return Promise.resolve(url);
    if (!SUPPORTED) return Promise.resolve(withBase(url));
    url = withBase(url);
    const entry = touch(url); // direct — url is already base-prefixed (avoids a 2nd withBase)
    if (entry) return Promise.resolve(entry.objectUrl);
    if (inflight.has(url)) return inflight.get(url);

    const isPreload = !!(opts && opts.preload);
    const p = scheduleFetch(async () => {
      // Bound each fetch so a stalled request can't hold a scheduler slot (and
      // starve other image loads) indefinitely; on timeout we fall back to the
      // direct URL like any other failure.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30000);
      try {
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) return url;
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        // Revoke any entry this replaces (clear() + a still-in-flight fetch can
        // race), else the old object URL would leak for the life of the tab.
        removeEntry(url);
        store.set(url, { objectUrl, size: blob.size || 0 });
        totalBytes += blob.size || 0;
        enforceLimits();
        return objectUrl;
      } catch {
        return url; // network/other error → fall back to the direct URL
      } finally {
        clearTimeout(timer);
        inflight.delete(url);
      }
    }, isPreload);
    inflight.set(url, p);
    return p;
  },

  // Fire-and-forget background warm for a list of URLs (skips already-cached /
  // in-flight ones). Order is preserved, so pass visible items first.
  preload(urls) {
    if (!SUPPORTED || !Array.isArray(urls)) return;
    for (const raw of urls) {
      const u = withBase(raw);
      if (u && !store.has(u) && !inflight.has(u)) {
        this.load(u, { preload: true }).catch(() => {});
      }
    }
  },

  // Revoke and drop everything (e.g. on unload or under memory pressure).
  clear() {
    for (const url of [...store.keys()]) removeEntry(url);
    totalBytes = 0;
  },

  // Introspection (used by tests / diagnostics).
  _stats() {
    return { entries: store.size, bytes: totalBytes };
  },
};

if (typeof window !== 'undefined') {
  const release = () => imageCache.clear();
  // beforeunload is unreliable on iOS Safari — pagehide covers tab close there.
  window.addEventListener('beforeunload', release);
  window.addEventListener('pagehide', release);
  // Diagnostic handle (in-memory only; nothing is persisted).
  window.__imageCache = imageCache;
}
