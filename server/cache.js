import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE_DIR, CACHE_MAX_AGE_DAYS_SHOWS } from './config.js';
import {
  IMG_SIZES,
  getMovie,
  getTv,
  getSeason,
  downloadImage,
} from './tmdb.js';
import { toWebp, throwIfAborted } from './images.js';
import { customSlots, clearAllCustom } from './customImages.js';
import { getTmdbLanguage } from './language.js';
import { ensureCollection } from './collections.js';
import { imageRamCache } from './imageRamCache.js';

// --- Path helpers ---------------------------------------------------------

export function itemDir(type, tmdbId) {
  const folder = type === 'movie' ? 'movies' : 'shows';
  return path.join(CACHE_DIR, folder, String(tmdbId));
}
export function collectionDir(collectionId) {
  return path.join(CACHE_DIR, 'collections', String(collectionId));
}
function seasonDir(tmdbId, seasonNumber) {
  return path.join(itemDir('show', tmdbId), 'seasons', `s${seasonNumber}`);
}

function metaPath(type, tmdbId) {
  return path.join(itemDir(type, tmdbId), 'meta.json');
}

// --- Meta read/write ------------------------------------------------------

// Parsed meta.json cache. Reading meta is by far the hottest disk operation in
// the process: the stats recompute alone touches ~1 file per library item plus
// one per watched season (measured: 561 reads, ~4.5s of blocking I/O over a
// bind-mounted volume), and the detail / What's Next / receipt handlers do the
// same reads again on every request.
//
// cache.js is the only writer of these files, so entries are invalidated
// explicitly on write (writeJson) and on a title's cache folder being cleared —
// the same contract imageRamCache already uses for the image files next to them.
// Negative results are cached too, so a miss doesn't re-stat on every pass; the
// write path invalidates when a lazily-built meta.json later appears.
//
// Entries are shared by reference, not cloned (cloning would give back the cost
// this exists to remove). The only callers that mutate a returned meta write the
// same value straight back through writeJson, which invalidates the entry — so a
// cached object never disagrees with what a fresh read would produce.
const META_CACHE_MAX = 2000;
const metaCache = new Map(); // absolute path -> parsed JSON | null (known-absent)

function metaCacheGet(p) {
  if (!metaCache.has(p)) return undefined; // not cached (null IS a cached value)
  const v = metaCache.get(p);
  metaCache.delete(p);
  metaCache.set(p, v); // LRU touch
  return v;
}
function metaCacheSet(p, v) {
  metaCache.set(p, v);
  while (metaCache.size > META_CACHE_MAX) metaCache.delete(metaCache.keys().next().value);
}
// Drop one file's entry (it was just rewritten).
function invalidateMeta(filePath) {
  metaCache.delete(filePath);
}
// Drop every entry under a directory (a title's cache folder was cleared).
export function invalidateMetaPrefix(dirAbs) {
  const prefix = dirAbs.endsWith(path.sep) ? dirAbs : dirAbs + path.sep;
  for (const key of [...metaCache.keys()]) {
    if (key === dirAbs || key.startsWith(prefix)) metaCache.delete(key);
  }
}

function parseMeta(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Synchronous reads — unchanged contract, now served from the cache on a hit.
function readMetaFileSync(p) {
  const hit = metaCacheGet(p);
  if (hit !== undefined) return hit;
  let value = null;
  if (fs.existsSync(p)) {
    try {
      value = parseMeta(fs.readFileSync(p, 'utf-8'));
    } catch {
      value = null;
    }
  }
  metaCacheSet(p, value);
  return value;
}

// Async twins of the two readers below. Same cache, same results — but a miss
// awaits real I/O, which yields the event loop instead of blocking it. Callers
// that read many metas in a loop (the stats recompute) MUST use these so the
// health probe and every other request are still answered while they run.
async function readMetaFile(p) {
  const hit = metaCacheGet(p);
  if (hit !== undefined) return hit;
  let value = null;
  try {
    value = parseMeta(await fsp.readFile(p, 'utf-8'));
  } catch {
    value = null; // missing / unreadable — cached as a known-absent entry
  }
  metaCacheSet(p, value);
  return value;
}

export function readMetaSync(type, tmdbId) {
  return readMetaFileSync(metaPath(type, tmdbId));
}

export function readSeasonMetaSync(tmdbId, seasonNumber) {
  return readMetaFileSync(path.join(seasonDir(tmdbId, seasonNumber), 'meta.json'));
}

export function readMeta(type, tmdbId) {
  return readMetaFile(metaPath(type, tmdbId));
}

export function readSeasonMeta(tmdbId, seasonNumber) {
  return readMetaFile(path.join(seasonDir(tmdbId, seasonNumber), 'meta.json'));
}

// Write atomically (temp file + rename) so a crash or a concurrent writer can
// never leave a truncated file that later passes the existence check.
async function writeFileAtomic(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function writeJson(filePath, data) {
  await writeFileAtomic(filePath, JSON.stringify(data, null, 2));
  invalidateMeta(filePath); // the cached parse is now stale — drop it
}

// Aggressive-but-clean WebP quality for all cached art. 62 roughly halves the
// byte size versus 80 with no visible loss at the sizes the UI renders.
const WEBP_QUALITY = 62;

export async function saveImage(dir, name, size, tmdbPath, { signal, maxWidth = 0 } = {}) {
  if (!tmdbPath) return;
  const buf = await downloadImage(size, tmdbPath, { signal });
  if (!buf) return;
  await fsp.mkdir(dir, { recursive: true });
  // Compress to WebP and cap the width to what the UI actually renders (the
  // source is only downscaled when it is wider). Cached images are stored with a
  // real .webp name; if cwebp is unavailable we fall back to the original bytes
  // under the same name (the assets route sniffs the header, so it still serves
  // the correct type).
  const webp = await toWebp(buf, { quality: WEBP_QUALITY, maxWidth });
  const outPath = path.join(dir, name);
  await writeFileAtomic(outPath, webp || buf);
  // A fresh file on disk supersedes any cached copy → drop it so the new version
  // is served (and re-cached) on the next request.
  imageRamCache.invalidate(outPath);
  // Auto-cleanup: never leave a stale sibling from the old .jpg-named scheme, so
  // a folder can never hold both a .webp and a .jpg of the same image.
  if (name.endsWith('.webp')) {
    const jpg = path.join(dir, name.slice(0, -5) + '.jpg');
    await fsp.rm(jpg, { force: true }).catch(() => {});
    imageRamCache.invalidate(jpg);
  }
}

// --- Normalization --------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

// Pull an age-rating certification from a movie's release_dates append. Prefers
// IT, then US/GB, then the first non-empty one found. '' when none.
function pickCertification(raw) {
  const results = raw.release_dates && raw.release_dates.results;
  if (!Array.isArray(results)) return '';
  const byCountry = new Map(results.map((r) => [r.iso_3166_1, r.release_dates || []]));
  const firstCert = (arr) =>
    (arr || []).map((x) => (x.certification || '').trim()).find((c) => c) || '';
  for (const cc of ['IT', 'US', 'GB']) {
    const cert = firstCert(byCountry.get(cc));
    if (cert) return cert;
  }
  for (const r of results) {
    const cert = firstCert(r.release_dates);
    if (cert) return cert;
  }
  return '';
}

// The director's name from the appended credits crew. '' when unknown.
function pickDirector(raw) {
  const crew = raw.credits && raw.credits.crew;
  if (!Array.isArray(crew)) return '';
  const d = crew.find((c) => c.job === 'Director');
  return d && d.name ? d.name : '';
}

function normalizeMovie(raw) {
  return {
    cached_at: nowIso(),
    // The TMDB language this record was fetched in. When the user changes the
    // metadata language in Settings, a mismatch here is what marks the cached
    // copy as stale (see cacheMovie / cacheShow).
    lang: getTmdbLanguage(),
    tmdb_id: String(raw.id),
    type: 'movie',
    title_it: raw.title || raw.original_title || '',
    title_orig: raw.original_title || raw.title || '',
    overview: raw.overview || '',
    tagline: raw.tagline || '', // cinematic one-liner; movies only (shows have none)
    release_date: raw.release_date || '',
    year: raw.release_date ? raw.release_date.slice(0, 4) : '',
    runtime: raw.runtime || 0,
    genres: (raw.genres || []).map((g) => g.name),
    poster_path: raw.poster_path || null,
    backdrop_path: raw.backdrop_path || null,
    imdb_id: raw.imdb_id || null,
    belongs_to_collection: normalizeCollectionRef(raw.belongs_to_collection),
    // --- Bento "Details" fields (added to the pipeline; populated on refresh) ---
    status: raw.status || '',
    budget: raw.budget || 0,
    revenue: raw.revenue || 0,
    original_language: raw.original_language || '',
    origin_country:
      (raw.production_countries && raw.production_countries[0] && raw.production_countries[0].iso_3166_1) ||
      '',
    production_company:
      (raw.production_companies && raw.production_companies[0] && raw.production_companies[0].name) || '',
    certification: pickCertification(raw),
    director: pickDirector(raw),
  };
}

// Keep only the fields we need from a movie's belongs_to_collection stub.
function normalizeCollectionRef(btc) {
  if (!btc || !btc.id) return null;
  return {
    id: String(btc.id),
    name: btc.name || '',
    poster_path: btc.poster_path || null,
    backdrop_path: btc.backdrop_path || null,
  };
}

function normalizeShow(raw) {
  return {
    cached_at: nowIso(),
    lang: getTmdbLanguage(), // see normalizeMovie

    tmdb_id: String(raw.id),
    type: 'show',
    title_it: raw.name || raw.original_name || '',
    title_orig: raw.original_name || raw.name || '',
    overview: raw.overview || '',
    tagline: raw.tagline || '', // TMDB TV details also carry a tagline (often empty)
    first_air_date: raw.first_air_date || '',
    year: raw.first_air_date ? raw.first_air_date.slice(0, 4) : '',
    status: raw.status || '',
    genres: (raw.genres || []).map((g) => g.name),
    episode_run_time: raw.episode_run_time || [],
    number_of_seasons: raw.number_of_seasons || 0,
    number_of_episodes: raw.number_of_episodes || 0,
    poster_path: raw.poster_path || null,
    backdrop_path: raw.backdrop_path || null,
    // --- Bento "Details" fields (added to the pipeline; populated on refresh) ---
    original_language: raw.original_language || '',
    origin_country: (raw.origin_country && raw.origin_country[0]) || '',
    network: (raw.networks && raw.networks[0] && raw.networks[0].name) || '',
    created_by: (raw.created_by || []).map((c) => c.name).filter(Boolean),
    last_air_date: raw.last_air_date || '',
    // Summary of real seasons (specials / season 0 excluded).
    seasons: (raw.seasons || [])
      .filter((s) => s.season_number > 0)
      .map((s) => ({
        season_number: s.season_number,
        name: s.name,
        episode_count: s.episode_count || 0,
        poster_path: s.poster_path || null,
        air_date: s.air_date || null,
      })),
  };
}

function normalizeSeason(raw) {
  return {
    cached_at: nowIso(),
    season_number: raw.season_number,
    name: raw.name || `Season ${raw.season_number}`,
    overview: raw.overview || '',
    poster_path: raw.poster_path || null,
    episodes: (raw.episodes || []).map((e) => ({
      episode_number: e.episode_number,
      name: e.name || '',
      overview: e.overview || '',
      air_date: e.air_date || null,
      runtime: e.runtime || null,
      still_path: e.still_path || null,
    })),
  };
}

// --- Cache builders -------------------------------------------------------

// Download + persist a movie (meta + poster + backdrop). Returns the meta.
export async function cacheMovie(tmdbId, { force = false, signal } = {}) {
  const existing = readMetaSync('movie', tmdbId);
  if (existing && !force && !wrongLanguage(existing)) return existing;

  const raw = await getMovie(tmdbId, { signal });
  const meta = normalizeMovie(raw);
  const dir = itemDir('movie', tmdbId);
  // The meta write and the two image downloads are independent — run them
  // concurrently instead of three serial round-trips (poster/backdrop hit the
  // TMDB CDN and have no rate gate). Roughly halves the image latency of every
  // movie add / lazy rebuild.
  // Artwork the user chose themselves is never overwritten by a refresh (see
  // customImages.js); the meta always refreshes.
  const custom = customSlots('movie', tmdbId);
  await Promise.all([
    writeJson(metaPath('movie', tmdbId), meta),
    custom.poster
      ? null
      : saveImage(dir, 'poster.webp', IMG_SIZES.poster, meta.poster_path, { signal, maxWidth: 500 }),
    custom.backdrop
      ? null
      : saveImage(dir, 'backdrop.webp', IMG_SIZES.backdrop, meta.backdrop_path, { signal, maxWidth: 900 }),
  ]);
  return meta;
}

// Return a movie's collection reference ({id,name,poster_path,...} or null),
// backfilling legacy caches created before this field was stored. Only makes a
// TMDB call once per legacy movie, then persists it into meta.json.
export async function ensureMovieCollectionField(tmdbId) {
  const meta = readMetaSync('movie', tmdbId);
  if (!meta) return null;
  if ('belongs_to_collection' in meta) return meta.belongs_to_collection || null;
  try {
    const raw = await getMovie(tmdbId);
    const ref = normalizeCollectionRef(raw.belongs_to_collection);
    meta.belongs_to_collection = ref;
    await writeJson(metaPath('movie', tmdbId), meta);
    return ref;
  } catch {
    return null;
  }
}

// Download + persist a show, all aired seasons, their posters and episode
// stills. Future seasons (no aired episodes) are skipped. Returns the meta.
export async function cacheShow(tmdbId, { force = false, signal } = {}) {
  const existing = readMetaSync('show', tmdbId);
  if (existing && !force && !wrongLanguage(existing)) return existing;

  const raw = await getTv(tmdbId, { signal });
  const meta = normalizeShow(raw);
  const dir = itemDir('show', tmdbId);
  const custom = customSlots('show', tmdbId);
  await Promise.all([
    writeJson(metaPath('show', tmdbId), meta),
    custom.poster
      ? null
      : saveImage(dir, 'poster.webp', IMG_SIZES.poster, meta.poster_path, { signal, maxWidth: 500 }),
    custom.backdrop
      ? null
      : saveImage(dir, 'backdrop.webp', IMG_SIZES.backdrop, meta.backdrop_path, { signal, maxWidth: 900 }),
  ]);

  for (const s of meta.seasons) {
    if (s.episode_count <= 0) continue; // future / empty season
    // Stop the whole chain the moment the client disconnects — for a show with
    // dozens of seasons this is what frees the backend.
    throwIfAborted(signal);
    try {
      const rawSeason = await getSeason(tmdbId, s.season_number, { signal });
      const seasonMeta = normalizeSeason(rawSeason);
      if (!seasonMeta.episodes.length) continue;
      const sDir = seasonDir(tmdbId, s.season_number);
      await writeJson(path.join(sDir, 'meta.json'), seasonMeta);
      // Season poster + every episode still were downloaded one at a time — for a
      // long season that's dozens of serial CDN round-trips (the biggest latency
      // when adding a series). Batch them ~6 at a time, with an abort check before
      // each batch so navigate-away still stops the chain promptly.
      const jobs = [
        () => saveImage(sDir, 'poster.webp', IMG_SIZES.seasonPoster, seasonMeta.poster_path, { signal }),
      ];
      for (const ep of seasonMeta.episodes) {
        if (ep.still_path) {
          jobs.push(() =>
            saveImage(sDir, `ep${ep.episode_number}.webp`, IMG_SIZES.thumb, ep.still_path, { signal })
          );
        }
      }
      const BATCH = 6;
      for (let i = 0; i < jobs.length; i += BATCH) {
        throwIfAborted(signal);
        await Promise.all(jobs.slice(i, i + BATCH).map((run) => run()));
      }
    } catch (err) {
      // An abort must break the whole loop, not just skip one season.
      if (err && err.name === 'AbortError') throw err;
      /* otherwise skip a season that fails to download; the rest still cache */
    }
  }
  return meta;
}

// Lazy rebuild: guarantee a cached meta exists, downloading if absent.
// Concurrent callers for the same title share one in-flight build instead of
// each launching a full (season-by-season) re-download that races on the files
// and hammers TMDB. When there is no concurrency the build runs directly with
// the caller's signal, preserving abort-on-disconnect.
const inflightBuilds = new Map(); // `${type}:${tmdbId}` -> Promise<meta>
export async function ensureCached(type, tmdbId, { force = false, signal } = {}) {
  const key = `${type}:${tmdbId}`;
  const existing = inflightBuilds.get(key);
  if (existing) return existing;
  const build = (async () => {
    if (type === 'movie') return cacheMovie(tmdbId, { force, signal });
    return cacheShow(tmdbId, { force, signal });
  })();
  inflightBuilds.set(key, build);
  try {
    return await build;
  } finally {
    inflightBuilds.delete(key);
  }
}

// True when a cached record was fetched in a language the user has since changed
// away from. Records written before the language became a setting carry no
// `lang` at all; those were Italian, so treat a missing stamp as it-IT.
export function wrongLanguage(meta) {
  if (!meta) return false;
  return (meta.lang || 'it-IT') !== getTmdbLanguage();
}

// Sentinel fields that exist ONLY in the newer meta schema (Bento "Details").
// Used to detect a meta.json written before those fields were added.
export function metaMissingBento(type, meta) {
  if (!meta) return false;
  // Both types also self-heal the `tagline` field (added later) through the same
  // one-call lightweight refetch — no dedicated tagline API call.
  if (!('tagline' in meta)) return true;
  return type === 'movie' ? !('director' in meta) : !('network' in meta);
}

// Lightweight refresh: re-fetch ONLY the top-level metadata (one TMDB call) and
// rewrite meta.json — WITHOUT re-downloading posters/backdrops or season files.
// Used to backfill new metadata fields into caches created before they existed
// (movies never auto-refresh; some shows aren't ongoing). Shares the in-flight
// map so concurrent opens don't double-fetch.
export async function refreshMetaFields(type, tmdbId, { signal } = {}) {
  const key = `metafields:${type}:${tmdbId}`;
  const existing = inflightBuilds.get(key);
  if (existing) return existing;
  const build = (async () => {
    if (type === 'movie') {
      const raw = await getMovie(tmdbId, { signal });
      const meta = normalizeMovie(raw);
      await writeJson(metaPath('movie', tmdbId), meta);
      return meta;
    }
    const raw = await getTv(tmdbId, { signal });
    const meta = normalizeShow(raw);
    await writeJson(metaPath('show', tmdbId), meta);
    return meta;
  })();
  inflightBuilds.set(key, build);
  try {
    return await build;
  } finally {
    inflightBuilds.delete(key);
  }
}

// --- Freshness ------------------------------------------------------------

function ageDays(cachedAt) {
  if (!cachedAt) return Infinity;
  const then = new Date(cachedAt).getTime();
  if (Number.isNaN(then)) return Infinity;
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

// Ongoing shows (TMDB status != 'Ended') older than the configured window
// should be refreshed. Movies are static and never stale.
export function isStale(meta) {
  if (!meta || meta.type !== 'show') return false;
  if (meta.status === 'Ended') return false;
  return ageDays(meta.cached_at) > CACHE_MAX_AGE_DAYS_SHOWS;
}

// Fire-and-forget background refresh. Never throws to the caller. De-duplicated
// per title so repeated stale-detail views don't stack concurrent full rebuilds.
const refreshing = new Set();
export function refreshInBackground(type, tmdbId, logger) {
  const key = `${type}:${tmdbId}`;
  if (refreshing.has(key)) return;
  refreshing.add(key);
  ensureCached(type, tmdbId, { force: true })
    .catch((err) => {
      if (logger) logger.warn(`background refresh failed for ${type} ${tmdbId}: ${err.message}`);
    })
    .finally(() => refreshing.delete(key));
}

// --- Asset serving (lazy re-download) -------------------------------------

// Given a cache-relative asset request, resolve the on-disk file, downloading
// it from TMDB if missing. Returns the absolute path, or null if it cannot be
// produced. Cached images are WebP; a legacy `.jpg` request (from an old client
// or cached service worker) is transparently resolved to the `.webp` file.
// `rel` examples:
//   movies/123/poster.webp
//   shows/456/backdrop.webp
//   shows/456/seasons/s2/poster.webp
//   shows/456/seasons/s2/ep5.webp
export async function ensureAsset(rel, { signal } = {}) {
  // Normalize legacy .jpg requests to the .webp file the cache now stores.
  rel = rel.replace(/\.jpg$/i, '.webp');
  const abs = path.join(CACHE_DIR, rel);
  if (fs.existsSync(abs)) return abs;

  const parts = rel.split('/').filter(Boolean);
  const folder = parts[0]; // movies | shows | collections
  const tmdbId = parts[1];
  const type = folder === 'movies' ? 'movie' : 'show';

  try {
    // Collection poster/backdrop: collections/{id}/{poster|backdrop}.webp
    if (folder === 'collections' && parts.length === 3) {
      const coll = await ensureCollection(tmdbId, { signal });
      const dir = collectionDir(tmdbId);
      if (parts[2] === 'poster.webp') {
        await saveImage(dir, 'poster.webp', IMG_SIZES.poster, coll.poster_path, { signal, maxWidth: 500 });
      } else if (parts[2] === 'backdrop.webp') {
        await saveImage(dir, 'backdrop.webp', IMG_SIZES.backdrop, coll.backdrop_path, { signal, maxWidth: 900 });
      }
      return fs.existsSync(abs) ? abs : null;
    }
    // Top-level poster/backdrop
    if (parts.length === 3) {
      const file = parts[2];
      let meta = readMetaSync(type, tmdbId);
      if (!meta) meta = await ensureCached(type, tmdbId, { signal });
      if (file === 'poster.webp') {
        await saveImage(itemDir(type, tmdbId), 'poster.webp', IMG_SIZES.poster, meta.poster_path, { signal, maxWidth: 500 });
      } else if (file === 'backdrop.webp') {
        await saveImage(itemDir(type, tmdbId), 'backdrop.webp', IMG_SIZES.backdrop, meta.backdrop_path, { signal, maxWidth: 900 });
      }
    }
    // Season poster or episode still: shows/{id}/seasons/s{N}/{file}
    else if (parts.length === 5 && parts[2] === 'seasons') {
      const seasonNumber = parseInt(parts[3].replace(/^s/, ''), 10);
      const file = parts[4];
      let sMeta = readSeasonMetaSync(tmdbId, seasonNumber);
      if (!sMeta) {
        // Rebuild the whole show (cheapest reliable path to season data).
        await ensureCached('show', tmdbId, { force: true, signal });
        sMeta = readSeasonMetaSync(tmdbId, seasonNumber);
      }
      if (sMeta) {
        const sDir = seasonDir(tmdbId, seasonNumber);
        if (file === 'poster.webp') {
          await saveImage(sDir, 'poster.webp', IMG_SIZES.seasonPoster, sMeta.poster_path, { signal });
        } else if (file.startsWith('ep')) {
          const epNum = parseInt(file.replace(/^ep/, '').replace(/\.webp$/, ''), 10);
          const ep = sMeta.episodes.find((e) => e.episode_number === epNum);
          if (ep && ep.still_path) {
            await saveImage(sDir, `ep${epNum}.webp`, IMG_SIZES.thumb, ep.still_path, { signal });
          }
        }
      }
    }
  } catch {
    return null;
  }

  return fs.existsSync(abs) ? abs : null;
}

// --- One-time cache migration to WebP-only names --------------------------
// Older builds stored cached images under a `.jpg` name (holding WebP bytes),
// and an even older scheme wrote real `.webp` files, so folders can hold both.
// This walks the image cache once and normalizes every folder to a single
// `.webp` per image:
//   • rename each `X.jpg` → `X.webp` (its bytes are already WebP), overwriting
//     any stale `X.webp` sibling so no duplicates remain;
//   • folders that only ever had the old `.webp` are left as-is.
// Idempotent and guarded by a settings flag, so it runs a single time.
export function migrateCacheToWebp(db) {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'cache_webp_migrated'")
      .get();
    if (row && row.value === '1') return { skipped: true };
  } catch {
    return { skipped: true }; // settings table not ready — try again next boot
  }

  let renamed = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.name.toLowerCase().endsWith('.jpg')) {
        const target = full.slice(0, -4) + '.webp';
        try {
          if (fs.existsSync(target)) fs.rmSync(target, { force: true });
          fs.renameSync(full, target);
          renamed++;
        } catch {
          /* skip this file */
        }
      }
    }
  };
  for (const root of ['movies', 'shows', 'collections']) {
    walk(path.join(CACHE_DIR, root));
  }

  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('cache_webp_migrated', '1')
     ON CONFLICT(key) DO UPDATE SET value = '1'`
  ).run();
  return { renamed };
}

// --- Cache deletion -------------------------------------------------------
export function clearItemCache(type, tmdbId) {
  const dir = itemDir(type, tmdbId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The user's own artwork lived in that directory, so the override flags would
  // now claim images that no longer exist.
  clearAllCustom(type, tmdbId);
  imageRamCache.invalidatePrefix(dir); // drop any RAM copies for this title
  invalidateMetaPrefix(dir); // …and its parsed meta
  invalidateStats();
}

export function clearAllCache() {
  for (const folder of ['movies', 'shows', 'collections']) {
    const dir = path.join(CACHE_DIR, folder);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  imageRamCache.clear(); // the whole image cache is gone from disk
  metaCache.clear(); // …and every parsed meta with it
  invalidateStats();
}

// --- Cache size stats (memoized 60s) --------------------------------------

let statsMemo = null; // { at: ms, value }

function invalidateStats() {
  statsMemo = null;
}

function scanDir(dir) {
  let bytes = 0;
  let files = 0;
  let oldest = null;
  if (!fs.existsSync(dir)) return { bytes, files, oldest };
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else {
        files += 1;
        try {
          const st = fs.statSync(full);
          bytes += st.size;
        } catch {
          /* ignore */
        }
        if (e.name === 'meta.json') {
          try {
            const m = JSON.parse(fs.readFileSync(full, 'utf-8'));
            if (m.cached_at) {
              if (!oldest || new Date(m.cached_at) < new Date(oldest)) {
                oldest = m.cached_at;
              }
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  return { bytes, files, oldest };
}

// On-demand full breakdown of data/cache: total size + file count, a per-
// subfolder breakdown (movies, shows, fanart, collections, …), and the oldest
// cached update. Computed fresh on every call (no memo) — it only runs when the
// user explicitly taps "Check cache".
export function getCacheBreakdown() {
  let entries = [];
  try {
    entries = fs.readdirSync(CACHE_DIR, { withFileTypes: true });
  } catch {
    /* cache dir missing → empty breakdown */
  }
  const folders = [];
  let total = 0;
  let totalFiles = 0;
  let oldest = null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const r = scanDir(path.join(CACHE_DIR, e.name));
    folders.push({ name: e.name, bytes: r.bytes, files: r.files });
    total += r.bytes;
    totalFiles += r.files;
    if (r.oldest && (!oldest || new Date(r.oldest) < new Date(oldest))) oldest = r.oldest;
  }
  folders.sort((a, b) => b.bytes - a.bytes);
  return { total_bytes: total, total_files: totalFiles, folders, oldest_cached_at: oldest };
}

export function getCacheStats() {
  if (statsMemo && Date.now() - statsMemo.at < 60000) {
    return statsMemo.value;
  }
  const movies = scanDir(path.join(CACHE_DIR, 'movies'));
  const shows = scanDir(path.join(CACHE_DIR, 'shows'));
  let oldest = null;
  for (const o of [movies.oldest, shows.oldest]) {
    if (o && (!oldest || new Date(o) < new Date(oldest))) oldest = o;
  }
  const value = {
    total_bytes: movies.bytes + shows.bytes,
    movies_bytes: movies.bytes,
    shows_bytes: shows.bytes,
    oldest_cached_at: oldest,
  };
  statsMemo = { at: Date.now(), value };
  return value;
}
