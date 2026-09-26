// Supplemental TV Time GDPR import — the data the main pipeline leaves behind.
// Runs against an already-imported library and is idempotent (safe to re-run).
//
// Imports, per the user's chosen options:
//   1. Favourites  — favorite-movies / favorite-series lists → items.favorite=1
//                    (titles not yet in the library are added as Completed + ♥).
//   2. Custom list — "My Must Watch" → a shelfIt list + list_items (name+items
//                    only; the TV Time description is intentionally not stored).
//   3. Rewatches   — rewatched_episode.cpt → progress.watch_count (= cpt total).
//   4. Watchlist   — followed shows with 0 episodes seen → items 'plan_to_watch'.
//
// ID resolution (TV Time uses its own UUIDs / TheTVDB ids, not TMDB):
//   • movies : list UUID → movie_name (from the ratings/comments/emotions files)
//              → TMDB name search.
//   • series : TheTVDB id → TMDB (/find), falling back to name search.
// Anything unresolved is logged to data/import/import_extras.log and skipped.

import fs from 'node:fs';
import path from 'node:path';
import db from './db.js';
import { IMPORT_DIR, MAX_IMPORT_BYTES, TMDB_IMPORT_INTERVAL_MS } from './config.js';
import { parseCsv } from './csv.js';
import { ensureCached, readMetaSync } from './cache.js';
import {
  searchMovie,
  searchTv,
  findShowByTvdb,
  setMinInterval,
} from './tmdb.js';
import { recomputeStats } from './stats.js';

const EXTRAS_LOG = path.join(IMPORT_DIR, 'import_extras.log');

function readCsv(name) {
  const p = path.join(IMPORT_DIR, name);
  if (!fs.existsSync(p)) return null;
  try {
    if (fs.statSync(p).size > MAX_IMPORT_BYTES) return null; // too large — skip
    return parseCsv(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function log(line) {
  try {
    fs.appendFileSync(EXTRAS_LOG, `${line}\n`);
  } catch {
    /* ignore */
  }
}

const dedupe = (arr) => [...new Set(arr)];
// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
const findLocal = db.prepare('SELECT * FROM items WHERE tmdb_id = ?');
const insertItemStmt = db.prepare(
  `INSERT INTO items (tmdb_id, type, title_it, title_orig, status, favorite)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const setFavoriteStmt = db.prepare('UPDATE items SET favorite = 1 WHERE id = ?');
const findListStmt = db.prepare('SELECT * FROM lists WHERE name = ? AND type = ?');
const insertListStmt = db.prepare('INSERT INTO lists (name, type, created_at) VALUES (?, ?, ?)');
const insertListItemStmt = db.prepare(
  'INSERT OR IGNORE INTO list_items (list_id, tmdb_id, added_at) VALUES (?, ?, ?)'
);

// --- TMDB resolvers (memoized) --------------------------------------------
const movieByName = new Map();
async function resolveMovie(name) {
  if (!name) return null;
  if (movieByName.has(name)) return movieByName.get(name);
  let id = null;
  try {
    const r = await searchMovie(name);
    if (r.length) id = String(r[0].id);
  } catch {
    id = null;
  }
  movieByName.set(name, id);
  return id;
}

const showByName = new Map();
async function resolveShowByName(name) {
  if (!name) return null;
  if (showByName.has(name)) return showByName.get(name);
  let id = null;
  try {
    const r = await searchTv(name);
    if (r.length) id = String(r[0].id);
  } catch {
    id = null;
  }
  showByName.set(name, id);
  return id;
}

const showByTvdb = new Map();
async function resolveShowByTvdb(tvdbId) {
  if (!tvdbId) return null;
  if (showByTvdb.has(tvdbId)) return showByTvdb.get(tvdbId);
  let id = null;
  try {
    id = await findShowByTvdb(tvdbId);
  } catch {
    id = null;
  }
  showByTvdb.set(tvdbId, id);
  return id;
}

// Ensure a title exists in the library, creating it (with the given status /
// favourite flag) if missing. Returns the row, or null if the TMDB cache failed.
async function ensureItem(type, tmdbId, { status, favorite }) {
  const existing = findLocal.get(String(tmdbId));
  if (existing) return existing;
  let meta;
  try {
    meta = await ensureCached(type, tmdbId);
  } catch {
    return null;
  }
  insertItemStmt.run(
    String(tmdbId),
    type,
    meta.title_it || meta.title_orig || '',
    meta.title_orig || meta.title_it || '',
    status,
    favorite ? 1 : 0
  );
  return findLocal.get(String(tmdbId));
}

// --- Lists file parsing (Go `map[...]` fmt, no JSON) -----------------------
// Item maps ("map[created_at:… type:movie uuid:…]" / "… id:250487 type:series]")
// contain no nested brackets, so a simple scan is safe.
function parseMapItems(objectsStr) {
  const items = [];
  if (!objectsStr) return items;
  const re = /map\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(objectsStr))) {
    const inner = m[1];
    const type = (inner.match(/type:(\w+)/) || [])[1] || null;
    const uuid = (inner.match(/uuid:([0-9a-fA-F-]{36})/) || [])[1] || null;
    const id = (inner.match(/\bid:(\d+)/) || [])[1] || null;
    items.push({ type, uuid, id });
  }
  return items;
}

// The "collection" row maps each list's s_key → its display name. Each map lays
// out "… name:<name> order:… s_key:<key> …", so pair name→next s_key.
function parseSkeyNames(metaStr) {
  const map = {};
  if (!metaStr) return map;
  const re = /name:(.+?) order:[\s\S]*?s_key:(\S+)/g;
  let m;
  while ((m = re.exec(metaStr))) {
    map[m[2]] = m[1].trim();
  }
  return map;
}

// UUID → movie_name, harvested from every file that pairs the two.
function buildUuidNameMap() {
  const map = new Map();
  const add = (uuid, name) => {
    if (uuid && name && !map.has(uuid)) map.set(uuid, name);
  };
  for (const r of readCsv('ratings-live-votes.csv') || []) add(r.uuid, r.movie_name);
  for (const r of readCsv('emotions-live-votes.csv') || []) add(r.uuid, r.movie_name);
  for (const r of readCsv('comments-prod-comments.csv') || [])
    add(r.entity_uuid, r.movie_name);
  return map;
}

// --- Main routine ----------------------------------------------------------
export async function runExtrasImport() {
  try {
    fs.writeFileSync(EXTRAS_LOG, '');
  } catch {
    /* ignore */
  }
  setMinInterval(TMDB_IMPORT_INTERVAL_MS); // stay under TMDB's rate limit for the whole run

  // Reset resolver caches so a re-run doesn't reuse stale name/tvdb→TMDB results.
  movieByName.clear();
  showByName.clear();
  showByTvdb.clear();

  const summary = {
    favorites_movies_flagged: 0,
    favorites_movies_added: 0,
    favorites_series_flagged: 0,
    favorites_series_added: 0,
    lists_created: 0,
    list_items_added: 0,
    rewatch_shows_matched: 0,
    rewatch_episodes_updated: 0,
    plan_added: 0,
    plan_skipped_existing: 0,
    unresolved: 0,
  };

  const uuidName = buildUuidNameMap();
  const listRows = readCsv('lists-prod-lists.csv') || [];

  // Classify the list rows.
  const favMovieUuids = [];
  const favSeriesTvdb = [];
  const customLists = [];
  let skeyNames = {};
  for (const row of listRows) {
    // The collection-descriptor row carries the s_key→name map in its `lists`
    // column; it identifies itself by s_key='collection' (its `type` is blank).
    if (row.s_key === 'collection' || (row.lists && row.lists.trim())) {
      skeyNames = { ...skeyNames, ...parseSkeyNames(row.lists) };
      continue;
    }
    if (row.type !== 'list') continue;
    const skey = row.s_key || '';
    const items = parseMapItems(row.objects);
    if (skey === 'favorite-movies') {
      favMovieUuids.push(...items.filter((i) => i.type === 'movie' && i.uuid).map((i) => i.uuid));
    } else if (skey === 'favorite-series') {
      favSeriesTvdb.push(...items.filter((i) => i.type === 'series' && i.id).map((i) => i.id));
    } else {
      customLists.push({ skey, items });
    }
  }

  // ---- 1) Favourites: movies ----
  for (const uuid of dedupe(favMovieUuids)) {
    const name = uuidName.get(uuid);
    if (!name) {
      log(`[FAV-MOVIE] unresolved uuid ${uuid} (no name in export)`);
      summary.unresolved += 1;
      continue;
    }
    const tmdb = await resolveMovie(name);
    if (!tmdb) {
      log(`[FAV-MOVIE] "${name}" — no TMDB match`);
      summary.unresolved += 1;
      continue;
    }
    const existing = findLocal.get(String(tmdb));
    if (existing) {
      setFavoriteStmt.run(existing.id);
      summary.favorites_movies_flagged += 1;
    } else {
      const item = await ensureItem('movie', tmdb, { status: 'completed', favorite: 1 });
      if (item) summary.favorites_movies_added += 1;
      else {
        log(`[FAV-MOVIE] "${name}" (TMDB ${tmdb}) — cache failed`);
        summary.unresolved += 1;
      }
    }
  }

  // ---- 1) Favourites: series (TheTVDB → TMDB) ----
  for (const tvdb of dedupe(favSeriesTvdb)) {
    const tmdb = await resolveShowByTvdb(tvdb);
    if (!tmdb) {
      log(`[FAV-SERIES] TheTVDB ${tvdb} — no TMDB match`);
      summary.unresolved += 1;
      continue;
    }
    const existing = findLocal.get(String(tmdb));
    if (existing) {
      setFavoriteStmt.run(existing.id);
      summary.favorites_series_flagged += 1;
    } else {
      const item = await ensureItem('show', tmdb, { status: 'completed', favorite: 1 });
      if (item) summary.favorites_series_added += 1;
      else {
        log(`[FAV-SERIES] TheTVDB ${tvdb} (TMDB ${tmdb}) — cache failed`);
        summary.unresolved += 1;
      }
    }
  }

  // ---- 2) Custom lists (e.g. "My Must Watch") ----
  for (const cl of customLists) {
    const name = skeyNames[cl.skey] || 'Imported list';
    const uuids = dedupe(cl.items.filter((i) => i.type === 'movie' && i.uuid).map((i) => i.uuid));
    const tmdbIds = [];
    for (const uuid of uuids) {
      const nm = uuidName.get(uuid);
      if (!nm) {
        log(`[LIST ${name}] unresolved uuid ${uuid} (no name)`);
        summary.unresolved += 1;
        continue;
      }
      const tmdb = await resolveMovie(nm);
      if (!tmdb) {
        log(`[LIST ${name}] "${nm}" — no TMDB match`);
        summary.unresolved += 1;
        continue;
      }
      tmdbIds.push(Number(tmdb));
    }
    if (!tmdbIds.length) continue;

    let list = findListStmt.get(name, 'movie');
    if (!list) {
      const info = insertListStmt.run(name, 'movie', Date.now());
      list = { id: info.lastInsertRowid };
      summary.lists_created += 1;
    }
    for (const t of dedupe(tmdbIds)) {
      const res = insertListItemStmt.run(list.id, t, Date.now());
      if (res.changes) summary.list_items_added += 1;
      // Warm the cache so the list collage can render this movie's poster.
      if (!readMetaSync('movie', String(t))) {
        try {
          await ensureCached('movie', t);
        } catch {
          /* poster just won't show — the item is still listed */
        }
      }
    }
  }

  // ---- 3) Episode rewatch counts → progress.watch_count (= cpt total) ----
  const rw = readCsv('rewatched_episode.csv') || [];
  const byShow = new Map();
  for (const r of rw) {
    const nm = r.tv_show_name;
    const season = parseInt(r.episode_season_number, 10);
    const ep = parseInt(r.episode_number, 10);
    const cpt = parseInt(r.cpt, 10);
    if (!nm || !Number.isFinite(season) || !Number.isFinite(ep) || !Number.isFinite(cpt)) continue;
    if (!byShow.has(nm)) byShow.set(nm, []);
    byShow.get(nm).push({ season, ep, cpt });
  }
  const updProg = db.prepare(
    'UPDATE progress SET watch_count = ? WHERE item_id = ? AND season = ? AND episode = ?'
  );
  for (const [nm, eps] of byShow) {
    const tmdb = await resolveShowByName(nm);
    if (!tmdb) {
      log(`[REWATCH] "${nm}" — no TMDB match`);
      summary.unresolved += 1;
      continue;
    }
    const item = findLocal.get(String(tmdb));
    if (!item) {
      log(`[REWATCH] "${nm}" — not in library, skipped`);
      continue;
    }
    summary.rewatch_shows_matched += 1;
    const tx = db.transaction(() => {
      for (const e of eps) {
        const res = updProg.run(e.cpt, item.id, e.season, e.ep);
        if (res.changes) summary.rewatch_episodes_updated += 1;
        else log(`[REWATCH] "${nm}" S${e.season}E${e.ep} — no watched episode to update`);
      }
    });
    tx();
  }

  // ---- 4) Watchlist: followed shows with 0 episodes seen → plan_to_watch ----
  const utd = readCsv('user_tv_show_data.csv') || [];
  for (const r of utd) {
    if (String(r.is_followed) !== '1') continue;
    if (parseInt(r.nb_episodes_seen, 10) !== 0) continue;
    const name = r.tv_show_name;
    let tmdb = await resolveShowByTvdb(r.tv_show_id);
    if (!tmdb) tmdb = await resolveShowByName(name);
    if (!tmdb) {
      log(`[PLAN] "${name}" (TheTVDB ${r.tv_show_id}) — no TMDB match`);
      summary.unresolved += 1;
      continue;
    }
    if (findLocal.get(String(tmdb))) {
      summary.plan_skipped_existing += 1;
      continue;
    }
    const item = await ensureItem('show', tmdb, { status: 'plan_to_watch', favorite: 0 });
    if (item) summary.plan_added += 1;
    else {
      log(`[PLAN] "${name}" (TMDB ${tmdb}) — cache failed`);
      summary.unresolved += 1;
    }
  }

  await recomputeStats(db);
  setMinInterval(0);
  log('--- SUMMARY ---');
  log(JSON.stringify(summary, null, 2));
  return summary;
}
