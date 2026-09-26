// In-process RAM cache for frequently-served media images (posters, episode
// thumbnails, covers). It sits in front of the disk in the /assets/* handler so
// hot images are served straight from memory with no disk read. Strictly images,
// strictly in-process — no Redis, no persistence, no JSON/API responses.
//
// Behaviour:
//   • LRU eviction (an insertion-ordered Map: touched entries move to the end,
//     eviction removes from the front) bounded by a total-bytes cap.
//   • A per-file cap keeps a single large backdrop from hogging RAM (large files
//     are always streamed from disk, never cached).
//   • Invalidation by path when the image pipeline rewrites a file on disk.
//   • Background warm-up at boot for the highest-frequency images.
//
// Node built-ins only (Buffer, fs/promises, Map).

import fsp from 'node:fs/promises';
import path from 'node:path';
import db from './db.js';
import { CACHE_DIR } from './config.js';
import { sniffMime } from './images.js';

// --- Tunables (named constants — adjust here without touching logic) --------
export const PER_FILE_MAX = 280 * 1024; // never cache a file larger than this (bytes)
const TOTAL_CAP = 64 * 1024 * 1024; // total RAM budget for cached images (bytes)
const WARMUP_CONCURRENCY = 4; // parallel file reads during warm-up
const LOG_INTERVAL_MS = 60 * 60 * 1000; // hit-rate summary cadence (hourly)

// --- LRU store -------------------------------------------------------------
const store = new Map(); // absPath -> { buf, size, mime, etag }
let totalBytes = 0;
let hits = 0;
let misses = 0;

function evictOldest() {
  const oldest = store.keys().next().value; // insertion order → least recently used
  if (oldest === undefined) return;
  const e = store.get(oldest);
  totalBytes -= e ? e.size : 0;
  store.delete(oldest);
}

const EXT_MIME = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};
// Same detection order as the assets route (sniff header, then extension), so a
// cached entry's Content-Type is identical whether it was warmed or served-on-miss.
function mimeFor(absPath, buf) {
  return (
    sniffMime(buf.subarray(0, 12)) ||
    EXT_MIME[path.extname(absPath).toLowerCase()] ||
    'application/octet-stream'
  );
}

export const imageRamCache = {
  PER_FILE_MAX,

  // Returns { buf, mime, etag } and marks the entry most-recently-used, or null.
  get(abs) {
    const e = store.get(abs);
    if (!e) {
      misses += 1;
      return null;
    }
    store.delete(abs);
    store.set(abs, e); // move to the most-recently-used position
    hits += 1;
    return e;
  },

  // Store a buffer if within the per-file cap; evicts LRU entries to stay under
  // the total cap. Caller guarantees the bytes are an image. Returns true if cached.
  set(abs, buf, { mime, etag }) {
    if (!buf || buf.length > PER_FILE_MAX) return false;
    const prev = store.get(abs);
    if (prev) {
      totalBytes -= prev.size;
      store.delete(abs);
    }
    const entry = { buf, size: buf.length, mime, etag };
    store.set(abs, entry);
    totalBytes += entry.size;
    while (totalBytes > TOTAL_CAP && store.size > 1) evictOldest();
    return true;
  },

  // Drop a single entry (the image pipeline rewrote this file on disk).
  invalidate(abs) {
    const e = store.get(abs);
    if (!e) return;
    totalBytes -= e.size;
    store.delete(abs);
  },

  // Drop every entry under a directory (a title's cache folder was cleared).
  invalidatePrefix(dirAbs) {
    const prefix = dirAbs.endsWith(path.sep) ? dirAbs : dirAbs + path.sep;
    for (const key of [...store.keys()]) {
      if (key === dirAbs || key.startsWith(prefix)) this.invalidate(key);
    }
  },

  clear() {
    store.clear();
    totalBytes = 0;
  },

  stats() {
    const total = hits + misses;
    return {
      entries: store.size,
      bytes: totalBytes,
      max_bytes: TOTAL_CAP,
      hits,
      misses,
      hit_rate: total ? Number((hits / total).toFixed(3)) : 0,
    };
  },

  // Background warm-up: pre-load the highest-frequency images (Watching posters,
  // What's Next episode stills, profile avatar + cover). Best-effort — never
  // throws, never blocks; missing files / empty DB are simply skipped.
  async warmUp(logger) {
    try {
      const paths = new Set();

      // Watching posters (movies + series) — the home / grid default views.
      let watching = [];
      try {
        watching = db
          .prepare("SELECT tmdb_id, type FROM items WHERE status = 'watching'")
          .all();
      } catch {
        /* DB not ready / empty — skip */
      }
      for (const it of watching) paths.add(posterPath(it.type, it.tmdb_id));

      // Profile avatar + cover (poster/backdrop of the chosen title token).
      try {
        const p = db.prepare('SELECT profile_image, cover_image FROM profile WHERE id = 1').get();
        if (p) {
          const avatar = tokenToPath(p.profile_image, 'poster');
          if (avatar) paths.add(avatar);
          const cover = tokenToPath(p.cover_image, 'backdrop');
          if (cover) paths.add(cover);
        }
      } catch {
        /* no profile row — skip */
      }

      // What's Next episode stills (next unwatched aired episode per started show).
      try {
        for (const still of await nextEpisodeStills()) paths.add(still);
      } catch {
        /* meta not cached — skip */
      }

      await loadBatch([...paths], WARMUP_CONCURRENCY);
      if (logger) {
        logger.info(
          `image RAM cache warmed: ${store.size} entries, ${(totalBytes / 1024 / 1024).toFixed(1)}MB`
        );
      }
    } catch (err) {
      if (logger) logger.warn(`image RAM cache warm-up skipped: ${err.message}`);
    }
    startLogging(logger);
  },
};

// --- Path helpers (kept local to avoid importing cache.js — that module
// imports this one for invalidation, so the dependency must stay one-way) -----
function posterPath(type, tmdbId) {
  const folder = type === 'movie' ? 'movies' : 'shows';
  return path.join(CACHE_DIR, folder, String(tmdbId), 'poster.webp');
}
function backdropPath(type, tmdbId) {
  const folder = type === 'movie' ? 'movies' : 'shows';
  return path.join(CACHE_DIR, folder, String(tmdbId), 'backdrop.webp');
}
// Resolve a 'movie:123' / 'show:123' profile token to a poster/backdrop path.
function tokenToPath(token, kind) {
  if (!token || token === 'custom') return null; // custom upload lives elsewhere
  const [type, id] = String(token).split(':');
  if (!type || !id) return null;
  const t = type === 'movie' ? 'movie' : 'show';
  return kind === 'backdrop' ? backdropPath(t, id) : posterPath(t, id);
}

async function readJson(p) {
  try {
    return JSON.parse(await fsp.readFile(p, 'utf-8'));
  } catch {
    return null;
  }
}

// Compact async re-implementation of the What's Next "next episode" pick, using
// async reads so warm-up never blocks the event loop (mirrors routes/upcoming.js).
async function nextEpisodeStills() {
  let shows = [];
  try {
    shows = db.prepare("SELECT id, tmdb_id FROM items WHERE type = 'show' AND status = 'watching'").all();
  } catch {
    return [];
  }
  if (!shows.length) return [];

  const progRows = db.prepare('SELECT item_id, season, episode FROM progress WHERE season > 0').all();
  const watchedByItem = new Map();
  for (const r of progRows) {
    let s = watchedByItem.get(r.item_id);
    if (!s) {
      s = new Set();
      watchedByItem.set(r.item_id, s);
    }
    s.add(`${r.season}:${r.episode}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const stills = [];
  for (const show of shows) {
    const watched = watchedByItem.get(show.id);
    if (!watched || watched.size === 0) continue; // not started
    const meta = await readJson(path.join(CACHE_DIR, 'shows', String(show.tmdb_id), 'meta.json'));
    if (!meta || !meta.seasons) continue;
    let found = null;
    for (const s of meta.seasons) {
      if (found || s.season_number < 1) continue;
      const sDir = path.join(CACHE_DIR, 'shows', String(show.tmdb_id), 'seasons', `s${s.season_number}`);
      const sMeta = await readJson(path.join(sDir, 'meta.json'));
      if (!sMeta || !sMeta.episodes) continue;
      for (const ep of sMeta.episodes) {
        if (watched.has(`${s.season_number}:${ep.episode_number}`)) continue; // seen
        if (!ep.air_date || ep.air_date > today) break; // first unwatched not aired → nothing now
        if (ep.still_path) found = path.join(sDir, `ep${ep.episode_number}.webp`);
        break; // first unwatched aired episode is the one to watch next
      }
    }
    if (found) stills.push(found);
  }
  return stills;
}

// Read a set of files into the cache with a small concurrency limit, so warm-up
// doesn't spike disk I/O at startup. Oversized / non-image / missing files skip.
async function loadBatch(paths, concurrency) {
  let idx = 0;
  async function worker() {
    while (idx < paths.length) {
      const p = paths[idx++];
      try {
        const st = await fsp.stat(p);
        if (st.size > PER_FILE_MAX) continue;
        const buf = await fsp.readFile(p);
        const mime = mimeFor(p, buf);
        if (!mime.startsWith('image/')) continue;
        const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
        imageRamCache.set(p, buf, { mime, etag });
      } catch {
        /* missing / unreadable — skip */
      }
    }
  }
  const workers = [];
  for (let k = 0; k < Math.max(1, concurrency); k++) workers.push(worker());
  await Promise.all(workers);
}

// --- Periodic hit-rate summary (minimal, once) -----------------------------
let logTimer = null;
function startLogging(logger) {
  if (logTimer || !logger) return;
  logTimer = setInterval(() => {
    const s = imageRamCache.stats();
    if (s.hits + s.misses === 0) return; // nothing served yet — stay quiet
    logger.info(
      `image RAM cache: ${s.entries} entries, ${(s.bytes / 1024 / 1024).toFixed(1)}MB, ` +
        `hit rate ${(s.hit_rate * 100).toFixed(0)}% (${s.hits}/${s.hits + s.misses})`
    );
  }, LOG_INTERVAL_MS);
  if (logTimer.unref) logTimer.unref();
}
