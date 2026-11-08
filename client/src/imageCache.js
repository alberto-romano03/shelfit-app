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

// Enough for a large library's posters, which the grids keep for the session;
// the byte cap is the real bound.
const MAX_ENTRIES = 800;
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
// Preload jobs still waiting for a slot, by URL, so a user load of the same
// image can move its job up to the user queue instead of waiting behind every
// grid preload ahead of it (see promote()).
const waiting = new Map();
// Debug counters (window.__imageCache._stats()): did a visible image find its
// bytes in memory? Preloads are not counted, only what the UI asked for.
let hits = 0;
let misses = 0;

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
  if (job.url) waiting.delete(job.url);
  active++;
  if (isPreload) preloadActive++;
  job.run(isPreload).finally(() => {
    active--;
    if (isPreload) preloadActive--;
    pumpQueues();
  });
}
// Run `task` (an async fn) under the scheduler; resolves with its result.
function scheduleFetch(task, isPreload, url) {
  return new Promise((resolve) => {
    const job = { run: (low) => task(low).then(resolve, resolve) };
    if (isPreload) {
      job.url = url;
      waiting.set(url, job);
      preloadQueue.push(job);
    } else {
      userQueue.push(job);
    }
    pumpQueues();
  });
}
// The UI now needs an image that is still queued as a preload: run it as a user
// load. One already running keeps its request; it is about to land anyway.
function promote(url) {
  const job = waiting.get(url);
  if (!job) return;
  waiting.delete(url);
  const i = preloadQueue.indexOf(job);
  if (i < 0) return;
  preloadQueue.splice(i, 1);
  job.url = null;
  userQueue.push(job);
  pumpQueues();
}

export const imageCache = {
  // Returns the cached object URL (marking it most-recently-used), or null.
  get(url) {
    if (!url) return null;
    url = withBase(url); // server emits root-absolute paths; serve under /base
    const entry = touch(url);
    if (entry) hits++;
    else misses++;
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
    const isPreload = !!(opts && opts.preload);
    const entry = touch(url); // direct — url is already base-prefixed (avoids a 2nd withBase)
    if (!isPreload) {
      if (entry) hits++;
      else misses++;
    }
    if (entry) return Promise.resolve(entry.objectUrl);
    if (inflight.has(url)) {
      if (!isPreload) promote(url);
      return inflight.get(url);
    }

    const p = scheduleFetch(async (low) => {
      // Bound each fetch so a stalled request can't hold a scheduler slot (and
      // starve other image loads) indefinitely; on timeout we fall back to the
      // direct URL like any other failure.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30000);
      try {
        // Background fetches also tell the browser they can wait (ignored
        // where Fetch Priority is not supported).
        const res = await fetch(url, { signal: ac.signal, priority: low ? 'low' : 'auto' });
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
    }, isPreload, url);
    inflight.set(url, p);
    return p;
  },

  // Load AND decode, so the next <img> with this image paints in its first
  // frame. Resolves with the src to use (the object URL, or the file's own URL
  // on failure) and never rejects. opts.decodeCapMs bounds the decode only (a
  // big image on a slow phone must not hold the caller); opts.preload loads at
  // background priority. Callers that must not wait on the network either race
  // this against their own timeout.
  ready(url, opts = {}) {
    if (!url) return Promise.resolve(null);
    const cap = opts.decodeCapMs == null ? 1500 : opts.decodeCapMs;
    return this.load(url, { preload: !!opts.preload })
      .catch(() => null)
      .then((u) => {
        const src = u || withBase(url);
        const probe = new Image();
        probe.decoding = 'async';
        probe.src = src;
        const decoded = probe.decode ? probe.decode().catch(() => {}) : Promise.resolve();
        return Promise.race([decoded, new Promise((r) => setTimeout(r, cap))]).then(() => src);
      });
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

  // Zero the debug counters (to measure one dialog's first screen).
  _resetStats() {
    hits = 0;
    misses = 0;
  },

  // Introspection (used by tests / diagnostics).
  _stats() {
    return { entries: store.size, bytes: totalBytes, hits, misses, queued: preloadQueue.length };
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
