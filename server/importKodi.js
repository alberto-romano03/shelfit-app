// Additive Kodi library import — merges data/import/videodb.xml into shelfIt.
//
// Rules (all enforced here):
//   • ADD titles present in Kodi but not in shelfIt (movies + shows).
//   • CONFIRM titles already in shelfIt without touching their rating/notes/etc.
//   • NEVER delete anything from shelfIt that Kodi lacks.
//   • WATCHED = OR of the two sources. A watched state is never overwritten with
//     an unwatched one; status only ever advances toward "watched", never back,
//     and deliberate user states (completed/paused/dropped) are left untouched.
//       - Movie watched  ⇢ status 'completed'.
//       - Show watched   ⇢ the set of watched episodes (progress rows), merged.
//   • REWATCH always trusts shelfIt: existing progress rows (and their
//     watch_count) are never modified, so Kodi's playcount never overwrites
//     shelfIt's rewatch history. Only *missing* watched episodes are added.
//   • Matching uses the common identifier: TMDB id (present on every record
//     here), falling back to IMDb id, then title+year.
//
// Safe to run repeatedly: item inserts are guarded by the tmdb_id UNIQUE key,
// episode inserts use ON CONFLICT DO NOTHING, and status only advances — so a
// re-run converges to the same state. Unresolved titles are logged and skipped.
//
// Run inside the app container (needs the TMDB key + image cache):
//   docker compose exec shelfit node server/importKodi.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { IMPORT_DIR, MAX_IMPORT_BYTES, TMDB_IMPORT_INTERVAL_MS } from './config.js';
import { ensureCached, readMetaSync } from './cache.js';
import { searchMovie, searchTv, findByImdb, setMinInterval } from './tmdb.js';
import { recomputeStats } from './stats.js';

const KODI_XML = path.join(IMPORT_DIR, 'videodb.xml');
const KODI_LOG = path.join(IMPORT_DIR, 'import_kodi.log');

function log(line) {
  fs.appendFileSync(KODI_LOG, line + '\n');
}

// --- Minimal, targeted XML reader ----------------------------------------
// The export is regular and well-formed; we only need a handful of fields, so a
// couple of scoped regexes are lighter (and dependency-free) than a full parser.
function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]).trim() : '';
}
function intTag(block, name) {
  const n = parseInt(tag(block, name), 10);
  return Number.isFinite(n) ? n : 0;
}
function uniqueId(block, type) {
  const m = block.match(
    new RegExp(`<uniqueid type="${type}"[^>]*>([^<]+)</uniqueid>`)
  );
  return m ? m[1].trim() : '';
}

export function parseMovies(xml) {
  const out = [];
  const re = /<movie>([\s\S]*?)<\/movie>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    out.push({
      title: tag(b, 'title'),
      originaltitle: tag(b, 'originaltitle'),
      year: intTag(b, 'year'),
      playcount: intTag(b, 'playcount'),
      lastplayed: tag(b, 'lastplayed'),
      tmdb: uniqueId(b, 'tmdb'),
      imdb: uniqueId(b, 'imdb'),
    });
  }
  return out;
}

export function parseShows(xml) {
  const out = [];
  const re = /<tvshow>([\s\S]*?)<\/tvshow>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    // Show-level fields live before the first (nested) episode.
    const headEnd = block.indexOf('<episodedetails>');
    const head = headEnd >= 0 ? block.slice(0, headEnd) : block;

    const episodes = [];
    const ere = /<episodedetails>([\s\S]*?)<\/episodedetails>/g;
    let e;
    while ((e = ere.exec(block))) {
      const eb = e[1];
      episodes.push({
        season: intTag(eb, 'season'),
        episode: intTag(eb, 'episode'),
        playcount: intTag(eb, 'playcount'),
        lastplayed: tag(eb, 'lastplayed'),
      });
    }

    out.push({
      title: tag(head, 'title'),
      originaltitle: tag(head, 'originaltitle'),
      year: intTag(head, 'year'),
      tmdb: uniqueId(head, 'tmdb'),
      imdb: uniqueId(head, 'imdb'),
      episodes,
    });
  }
  return out;
}

// --- Identifier resolution ------------------------------------------------
// TMDB id is present on every record in this export; IMDb / title+year are
// safety-net fallbacks (logged when used).
export async function resolveTmdb(kind, rec) {
  if (rec.tmdb) return rec.tmdb;
  if (rec.imdb) {
    try {
      const { movies, shows } = await findByImdb(rec.imdb);
      const r = (kind === 'movie' ? movies : shows)[0];
      if (r) {
        log(`[RESOLVE] "${rec.title}" via IMDb ${rec.imdb} → TMDB ${r.id}`);
        return String(r.id);
      }
    } catch {
      /* fall through */
    }
  }
  if (rec.title) {
    try {
      const results =
        kind === 'movie' ? await searchMovie(rec.title) : await searchTv(rec.title);
      let best = results[0];
      if (rec.year) {
        const y = String(rec.year);
        const yr = results.find((r) =>
          String(r.release_date || r.first_air_date || '').startsWith(y)
        );
        if (yr) best = yr;
      }
      if (best) {
        log(`[RESOLVE] "${rec.title}" (${rec.year}) via title → TMDB ${best.id}`);
        return String(best.id);
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

// --- Watched-status advancement -------------------------------------------
// Only these two states may be advanced (toward "watched"); completed / paused /
// dropped are deliberate user states and are never changed by the import.
const ADVANCE = { plan_to_watch: 0, watching: 1, completed: 2 };
export function advancedStatus(current, target) {
  if (!(current in ADVANCE) || !(target in ADVANCE)) return null; // leave as-is
  return ADVANCE[target] > ADVANCE[current] ? target : null;
}

const findItem = db.prepare('SELECT id, type, status FROM items WHERE tmdb_id = ?');
const setStatus = db.prepare(
  "UPDATE items SET status = ?, updated_at = datetime('now') WHERE id = ?"
);
const insertMovie = db.prepare(
  `INSERT INTO items (tmdb_id, type, title_it, title_orig, status)
   VALUES (?, 'movie', ?, ?, ?)`
);
const insertShow = db.prepare(
  `INSERT INTO items (tmdb_id, type, title_it, title_orig, status)
   VALUES (?, 'show', ?, ?, ?)`
);
const insertProgress = db.prepare(
  `INSERT INTO progress (item_id, season, episode, watch_count, watched_at)
   VALUES (?, ?, ?, 1, ?)
   ON CONFLICT(item_id, season, episode) DO NOTHING`
);
const countWatched = db.prepare(
  'SELECT COUNT(*) AS c FROM progress WHERE item_id = ? AND season > 0'
);

function totalRealEpisodes(tmdb) {
  const meta = readMetaSync('show', tmdb);
  if (!meta) return 0;
  return (meta.seasons || []).reduce((sum, s) => sum + (s.episode_count || 0), 0);
}

function showStatusFromProgress(itemId, tmdb) {
  const total = totalRealEpisodes(tmdb);
  const watched = countWatched.get(itemId).c;
  if (total > 0 && watched >= total) return 'completed';
  if (watched > 0) return 'watching';
  return 'plan_to_watch';
}

// --- Movies ---------------------------------------------------------------
async function importMovies(movies, summary) {
  for (const m of movies) {
    const tmdb = await resolveTmdb('movie', m);
    if (!tmdb) {
      log(`[MOVIE] unresolved "${m.title}" (${m.year})`);
      summary.unresolved += 1;
      continue;
    }
    const watched = m.playcount > 0;
    const existing = findItem.get(String(tmdb));

    if (existing) {
      if (existing.type !== 'movie') {
        log(`[MOVIE] TMDB ${tmdb} already exists as ${existing.type} — skipped`);
        summary.conflicts += 1;
        continue;
      }
      const next = watched ? advancedStatus(existing.status, 'completed') : null;
      if (next) {
        setStatus.run(next, existing.id);
        summary.movies_watched_upgraded += 1;
        log(`[MOVIE] "${m.title}" ${existing.status} → ${next} (watched in Kodi)`);
      } else {
        summary.movies_confirmed += 1;
      }
      continue;
    }

    let meta;
    try {
      meta = await ensureCached('movie', tmdb);
    } catch (err) {
      log(`[MOVIE] "${m.title}" (TMDB ${tmdb}) — metadata fetch failed: ${err.message}`);
      summary.unresolved += 1;
      continue;
    }
    const status = watched ? 'completed' : 'plan_to_watch';
    insertMovie.run(
      String(tmdb),
      meta.title_it || meta.title_orig || m.title || 'Untitled',
      meta.title_orig || meta.title_it || m.originaltitle || m.title || 'Untitled',
      status
    );
    summary.movies_added += 1;
    log(`[MOVIE] + "${m.title}" (TMDB ${tmdb}) as ${status}`);
  }
}

// --- Shows ----------------------------------------------------------------
async function importShows(shows, summary) {
  for (const sh of shows) {
    const tmdb = await resolveTmdb('show', sh);
    if (!tmdb) {
      log(`[SHOW] unresolved "${sh.title}" (${sh.year})`);
      summary.unresolved += 1;
      continue;
    }
    const watchedEps = sh.episodes.filter((e) => e.playcount > 0 && e.season >= 1);
    const existing = findItem.get(String(tmdb));

    let itemId;
    let currentStatus;
    if (existing) {
      if (existing.type !== 'show') {
        log(`[SHOW] TMDB ${tmdb} already exists as ${existing.type} — skipped`);
        summary.conflicts += 1;
        continue;
      }
      itemId = existing.id;
      currentStatus = existing.status;
      summary.shows_confirmed += 1;
    } else {
      let meta;
      try {
        meta = await ensureCached('show', tmdb);
      } catch (err) {
        log(`[SHOW] "${sh.title}" (TMDB ${tmdb}) — metadata fetch failed: ${err.message}`);
        summary.unresolved += 1;
        continue;
      }
      const info = insertShow.run(
        String(tmdb),
        meta.title_it || meta.title_orig || sh.title || 'Untitled',
        meta.title_orig || meta.title_it || sh.originaltitle || sh.title || 'Untitled',
        'plan_to_watch'
      );
      itemId = info.lastInsertRowid;
      currentStatus = 'plan_to_watch';
      summary.shows_added += 1;
      log(`[SHOW] + "${sh.title}" (TMDB ${tmdb}) with ${watchedEps.length} watched episode(s)`);
    }

    // Merge in Kodi's watched episodes (OR). Existing rows — and their rewatch
    // watch_count — are never touched, so shelfIt always wins on rewatch.
    let addedEps = 0;
    const tx = db.transaction(() => {
      for (const e of watchedEps) {
        const r = insertProgress.run(itemId, e.season, e.episode, e.lastplayed || null);
        if (r.changes) addedEps += 1;
      }
    });
    tx();
    summary.episodes_added += addedEps;

    // Advance the show's status toward watched only (never past a deliberate
    // completed/paused/dropped, never backward).
    const target = showStatusFromProgress(itemId, tmdb);
    const next = advancedStatus(currentStatus, target);
    if (next) {
      setStatus.run(next, itemId);
      if (existing) {
        summary.shows_status_upgraded += 1;
        log(`[SHOW] "${sh.title}" ${currentStatus} → ${next}`);
      }
    }
  }
}

// --- Entry point ----------------------------------------------------------
export async function runKodiImport() {
  if (!fs.existsSync(KODI_XML)) {
    throw new Error(`Kodi export not found at ${KODI_XML}`);
  }
  if (fs.statSync(KODI_XML).size > MAX_IMPORT_BYTES) {
    throw new Error('Kodi export file too large');
  }
  fs.writeFileSync(KODI_LOG, `Kodi import — ${new Date().toISOString()}\n`);
  setMinInterval(TMDB_IMPORT_INTERVAL_MS); // throttle TMDB calls for the duration of the run

  const xml = fs.readFileSync(KODI_XML, 'utf8');
  const movies = parseMovies(xml);
  const shows = parseShows(xml);

  const summary = {
    movies_total: movies.length,
    shows_total: shows.length,
    movies_added: 0,
    movies_watched_upgraded: 0,
    movies_confirmed: 0,
    shows_added: 0,
    shows_confirmed: 0,
    shows_status_upgraded: 0,
    episodes_added: 0,
    unresolved: 0,
    conflicts: 0,
  };

  await importMovies(movies, summary);
  await importShows(shows, summary);
  await recomputeStats(db);

  log(`SUMMARY ${JSON.stringify(summary)}`);
  return summary;
}

// Allow running directly: `node server/importKodi.js`
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runKodiImport()
    .then((s) => {
      console.log('Kodi import complete:');
      console.log(JSON.stringify(s, null, 2));
      console.log(`Details logged to ${KODI_LOG}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Kodi import failed:', err);
      process.exit(1);
    });
}
