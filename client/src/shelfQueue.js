// Prefetch queue for "Back to the Shelf" — every shuffle is instant because the
// next titles (and their images) are already loaded before the user asks.
//
// State model:  [current, next, prefetched]
//   current    → displayed now
//   next       → shown on the next shuffle, image already cached
//   prefetched → fetched + image-cached in the background, becomes `next` after
//                the following shuffle
//
// We keep `current` displayed plus up to READY_AHEAD ready items queued. On each
// shuffle we dequeue instantly and top the queue back up in the background.

import { api } from './api.js';
import { imageCache } from './imageCache.js';

const READY_AHEAD = 2; // ready items to keep queued behind `current` (→ 3 total)

// Warm both the fanart disc AND the poster fallback, so whichever render path
// the disc takes, the image is already in the in-memory cache.
function preloadItem(item) {
  if (!item) return;
  if (item.poster_url) imageCache.load(item.poster_url).catch(() => {});
  if (item.fanart && item.fanart.url) imageCache.load(item.fanart.url).catch(() => {});
}

export function createShelfQueue() {
  let type = 'movie';
  let current = null;
  let queue = []; // ready items (images preloaded), excluding `current`
  let topping = false;
  let loadedType = null; // type the queue is currently loaded for (null until first load)
  let loadPromise = null; // in-flight load(), so a prefetch + popup-open share one fetch
  let loadPromiseType = null; // the type that in-flight load is for

  // Fetch n titles, silently retrying once before giving up. Returns an array
  // (possibly empty) on success, or null if both attempts failed.
  async function fetchN(n) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await api.shelfRandom(type, n);
        return (res && res.items) || [];
      } catch {
        /* fall through to a single silent retry */
      }
    }
    return null;
  }

  function isDuplicate(item) {
    if (!item) return true;
    if (current && current.tmdb_id === item.tmdb_id) return true;
    return queue.some((q) => q.tmdb_id === item.tmdb_id);
  }

  // One fresh title, avoiding an immediate repeat when the library is big enough
  // to offer one (falls back to accepting a repeat for tiny libraries).
  async function fetchOneDistinct() {
    for (let attempt = 0; attempt < 2; attempt++) {
      const got = await fetchN(1);
      if (got === null) return null; // network failed twice
      if (!got.length) return null; // empty library
      const item = got[0];
      if (!isDuplicate(item) || attempt === 1) return item;
    }
    return null;
  }

  // Refill the queue up to READY_AHEAD in the background. Never throws.
  async function topUp() {
    if (topping) return;
    topping = true;
    try {
      let guard = 0;
      while (queue.length < READY_AHEAD && guard++ < READY_AHEAD + 2) {
        const item = await fetchOneDistinct();
        if (!item) break; // failure or nothing new to add
        preloadItem(item);
        queue.push(item);
      }
    } finally {
      topping = false;
    }
  }

  // (Re)initialize for a type: flush, fetch 3, show the first, preload the rest.
  // Returns { first, empty } on success or { failed: true } if the fetch failed
  // outright (queue completely empty → the caller surfaces an error).
  async function load(nextType) {
    type = nextType;
    current = null;
    queue = [];
    const items = await fetchN(READY_AHEAD + 1);
    if (items === null) return { failed: true };
    items.forEach(preloadItem);
    current = items.shift() || null;
    queue = items;
    return { first: current, empty: current === null };
  }

  // Load for `nextType` only if the queue isn't already warm for it, deduping a
  // background prefetch and a popup-open so they share a single fetch. Same
  // return shape as load(). This is purely a reuse gate around the existing
  // load() — the shuffle/top-up logic is unchanged — letting the app warm the
  // queue before the popup is ever opened.
  async function ensureLoaded(nextType) {
    // A load for this same type is already running (e.g. the app-load prefetch) →
    // await it instead of firing a second one.
    if (loadPromise && loadPromiseType === nextType) return loadPromise;
    // Already warm for this type and nothing in flight → hand back the head now.
    if (loadedType === nextType && !loadPromise) {
      return { first: current, empty: current === null };
    }
    loadPromiseType = nextType;
    loadPromise = load(nextType);
    try {
      const res = await loadPromise;
      loadedType = res.failed ? null : nextType;
      return res;
    } finally {
      loadPromise = null;
    }
  }

  // Advance to the next title. Resolves instantly with a preloaded item when the
  // queue is warm; only in the rare drained case does it wait on a fetch.
  async function next() {
    if (queue.length) {
      current = queue.shift();
    } else {
      const item = await fetchOneDistinct();
      if (item) {
        preloadItem(item);
        current = item;
      }
      // else: keep showing `current` (e.g. a single-title library)
    }
    topUp();
    return current;
  }

  return { load, ensureLoaded, next, current: () => current };
}

// One shared queue PER TYPE. They are independent instances of the same module —
// same READY_AHEAD, same top-up-on-shuffle logic — so Movies and TV Shows stay
// warm side by side and the type toggle never has to refetch. (A single shared
// queue used to be flushed and reloaded on every type switch, which is what put
// a loading state behind the toggle.)
const sharedQueues = new Map(); // type -> queue

export function getSharedShelfQueue(type = 'movie') {
  let q = sharedQueues.get(type);
  if (!q) {
    q = createShelfQueue();
    sharedQueues.set(type, q);
  }
  return q;
}

export const SHELF_TYPES = ['movie', 'show'];

// Fire-and-forget: silently warm one type's queue in the background. Idempotent
// (ensureLoaded skips when already warm / in flight) and never throws — a failed
// prefetch just means that type loads on demand, exactly as before.
export function prefetchShelfQueue(type = 'movie') {
  try {
    getSharedShelfQueue(type).ensureLoaded(type).catch(() => {});
  } catch {
    /* ignore */
  }
}

// Warm EVERY type at once, in parallel — each call starts its own fetch and none
// waits on the other. Used on home idle and again on popup open, so whichever
// type the user toggles to already has its first title (and its image) ready.
export function prefetchShelfQueues() {
  SHELF_TYPES.forEach(prefetchShelfQueue);
}
