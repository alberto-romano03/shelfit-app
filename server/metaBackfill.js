// Metadata backfill: titles in anyone's library whose cached TMDB data is missing
// (a backup restored from another instance, an import cut short by a restart) or,
// for a series, whose season files are incomplete. They are fetched in the
// background one at a time, spaced like an import, and the stored title, year and
// genres of every matching row are refreshed. What's Next reads only the cache,
// so a series without its season files would otherwise stay invisible there.
//
// A one-shot in-memory queue used to do this right after an import; a restart
// mid-way lost the rest for good. Now the boot scan finds whatever is still
// missing, and callers (library import, What's Next) enqueue titles on demand.

import db from './db.js';
import { ensureCached, readMetaSync, readSeasonMetaSync } from './cache.js';
import { scheduleStatsRecompute } from './stats.js';
import { TMDB_API_KEY, TMDB_IMPORT_INTERVAL_MS } from './config.js';

// A title that failed (TMDB down, a removed id) is not retried before this.
const RETRY_MS = 6 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 15 * 1000; // let the server settle before scanning

const queue = []; // [{ type, tmdbId }]
const queued = new Set(); // `${type}:${tmdbId}` waiting or in flight
const lastTry = new Map(); // `${type}:${tmdbId}` -> ms of the last attempt
let draining = false;
let log = null;

const distinctTitlesStmt = db.prepare('SELECT DISTINCT type, tmdb_id FROM items');
const refreshTitlesStmt = db.prepare(
  'UPDATE items SET title_it = ?, title_orig = ?, year = ?, genres = ? WHERE type = ? AND tmdb_id = ?'
);

// 'missing' (no meta at all), 'partial' (a series with a season not cached), or
// null when everything What's Next and the detail pages need is on disk.
export function metaState(type, tmdbId) {
  const meta = readMetaSync(type, String(tmdbId));
  if (!meta) return 'missing';
  if (type === 'show') {
    for (const s of meta.seasons || []) {
      if ((s.episode_count || 0) > 0 && !readSeasonMetaSync(String(tmdbId), s.season_number)) {
        return 'partial';
      }
    }
  }
  return null;
}

export function enqueueMeta(type, tmdbId) {
  if (!TMDB_API_KEY) return; // nothing could be fetched (tests, unconfigured install)
  const id = String(tmdbId);
  const key = `${type}:${id}`;
  if (queued.has(key)) return;
  const tried = lastTry.get(key);
  if (tried && Date.now() - tried < RETRY_MS) return;
  queued.add(key);
  queue.push({ type, tmdbId: id });
  drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  let fetched = 0;
  try {
    while (queue.length) {
      const { type, tmdbId } = queue.shift();
      const key = `${type}:${tmdbId}`;
      lastTry.set(key, Date.now());
      try {
        const state = metaState(type, tmdbId);
        if (state) {
          // force: a partial series already has its meta.json, which would
          // otherwise make cacheShow return early without the missing seasons.
          const meta = await ensureCached(type, tmdbId, { force: state === 'partial' });
          if (meta) {
            refreshTitlesStmt.run(
              meta.title_it || meta.title_orig || 'Untitled',
              meta.title_orig || meta.title_it || 'Untitled',
              meta.year || '',
              JSON.stringify(meta.genres || []),
              type,
              tmdbId
            );
            fetched += 1;
          }
          await new Promise((r) => setTimeout(r, TMDB_IMPORT_INTERVAL_MS));
        }
      } catch (err) {
        if (log) log.warn(`metadata backfill: ${key} failed: ${err.message}`);
      } finally {
        queued.delete(key);
      }
    }
  } finally {
    draining = false;
    if (fetched) scheduleStatsRecompute(db);
  }
}

// Boot: queue every library title whose cache is missing or incomplete.
export function startMetaBackfill(logger) {
  log = logger || null;
  if (!TMDB_API_KEY) return;
  const timer = setTimeout(() => {
    let n = 0;
    for (const row of distinctTitlesStmt.all()) {
      if (metaState(row.type, row.tmdb_id)) {
        enqueueMeta(row.type, row.tmdb_id);
        n += 1;
      }
    }
    if (n && log) log.info(`metadata backfill: ${n} title(s) queued`);
  }, BOOT_DELAY_MS);
  timer.unref();
}
