// Durable on-device cache (localStorage) for the handful of things the home
// screen must show even offline and ACROSS app relaunches: display name, stats,
// watchlist titles, and the avatar / cover / badge IMAGE BYTES (as data: URLs).
//
// Why localStorage — and not the two stores we used before:
//   • sessionStorage is wiped every time an iOS home-screen PWA is reopened, so
//     the "instant paint" values were gone on the next launch.
//   • the service-worker Cache Storage is evicted by iOS under storage pressure,
//     so profile/cover images (only ever kept there) sometimes vanished.
// localStorage survives relaunches and, together with navigator.storage.persist()
// (requested at startup), is the most reliable small-KV store on iOS PWAs.
//
// Values are JSON. Images are stored as data: URLs so they render with zero
// network and zero dependency on the SW cache. Everything is best-effort: a
// disabled store or a quota hit simply means we fall back to the network path.

import { imageCache } from './imageCache.js';

const PREFIX = 'shelfit:';

// Key names for the persisted pieces (kept short; values live under PREFIX).
export const PK = {
  name: 'profile:name',
  avatarUrl: 'profile:avatarUrl',
  avatarData: 'profile:avatarData',
  badgeUrl: 'profile:badgeUrl',
  badgeData: 'profile:badgeData',
  coverUrl: 'profile:coverUrl',
  coverData: 'profile:coverData',
  statsEpisodes: 'stats:episodes',
  statsMovies: 'stats:movies',
  // TMDB movie/tv genre lists for the Dust It Off filters. Change very rarely, so
  // the cached copy paints instantly and is revalidated on each open.
  genres: 'discover:genres',
  // Set true the first time the feature showcase auto-opens, so it only ever
  // shows itself once. The header "?" button reopens it on demand thereafter.
  showcaseSeen: 'showcase:seen',
};

// Plan-to-Watch titles are stored per library type: `plan:movie`, `plan:show`.
export function planKey(type) {
  return `plan:${type}`;
}

// Currently-watching cards shown on the home screen. Stored as a compact array
// with each poster's BYTES embedded (data: URL), so the home paints them
// instantly on the next launch — no ghost skeleton, no network, even offline.
// Best-effort; the watching list changes seldom, so brief staleness (a just-
// added / removed title) is acceptable and reconciled on the next fetch.
const WATCHING_KEY = 'home:watching';
const WATCHING_MAX = 24; // cap embedded posters so the blob stays well under quota

export function getWatching() {
  return pget(WATCHING_KEY); // array | undefined
}

export async function persistWatching(items) {
  try {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let posterData = null;
      // Reuse the blob the rendered poster already loaded through imageCache
      // (a local object URL → reading it back is a memory read, not a download).
      if (it.poster_url && i < WATCHING_MAX) {
        try {
          const resolved = await imageCache.load(it.poster_url);
          const res = await fetch(resolved);
          if (res.ok) {
            const blob = await res.blob();
            if (blob && blob.size <= 220 * 1024) posterData = await blobToDataUrl(blob);
          }
        } catch {
          /* leave posterData null → renders via the normal cached-image path */
        }
      }
      out.push({
        id: it.id,
        type: it.type,
        title_it: it.title_it,
        poster_url: it.poster_url,
        last_watched: it.last_watched || null,
        posterData,
      });
    }
    pset(WATCHING_KEY, out);
  } catch {
    /* quota / disabled storage — the ghost simply shows next time */
  }
}

// Returns the stored value, or `undefined` when absent / unreadable. `null` is a
// valid stored value (distinct from `undefined`).
export function pget(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined; // storage disabled (private mode) or malformed
  }
}

// Writes only when the value actually changed; returns true if it wrote.
export function pset(key, value) {
  try {
    const next = JSON.stringify(value);
    if (localStorage.getItem(PREFIX + key) === next) return false;
    localStorage.setItem(PREFIX + key, next);
    return true;
  } catch {
    return false; // quota (e.g. an oversized image) / disabled — best-effort
  }
}

export function premove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

// Deep-equality good enough for our small plain values/objects.
export function pequal(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('read failed'));
    fr.readAsDataURL(blob);
  });
}

// Fetch an image and store its bytes as a data: URL under `dataKey`, so it can
// be rendered offline on the next launch. A sibling `<dataKey>:src` marker holds
// the source URL, so we refetch only when the image actually changed. Passing a
// falsy url clears the stored bytes (e.g. the badge was removed). Best-effort:
// offline, a non-OK response, an oversized image, or a full quota all no-op.
export async function persistImage(dataKey, url) {
  const markKey = dataKey + ':src';
  try {
    if (!url) {
      premove(dataKey);
      premove(markKey);
      return;
    }
    if (pget(markKey) === url && typeof pget(dataKey) === 'string') return; // unchanged
    // Reuse the blob the rendered avatar/cover/badge already load through
    // imageCache (shared in-flight + LRU) instead of firing a SECOND network
    // request for the same image. `load` returns a local object URL on a cache
    // hit; reading it back is a memory read, not a download.
    const resolved = await imageCache.load(url);
    const res = await fetch(resolved);
    if (!res.ok) return;
    const blob = await res.blob();
    // localStorage tops out around ~5 MB; keep well clear so a big backdrop can
    // never evict the small text values we care about most.
    if (!blob || blob.size > 3 * 1024 * 1024) return;
    const dataUrl = await blobToDataUrl(blob);
    if (pset(dataKey, dataUrl)) pset(markKey, url);
  } catch {
    /* offline / decode / quota — leave any previously stored bytes intact */
  }
}
