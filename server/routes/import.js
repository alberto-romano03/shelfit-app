// TV Time import under /api/import/: parses the exported CSV files in
// data/import/ and rebuilds the library (series with per-episode progress plus
// completed / rewatched / plan-to-watch movies), matching each against TMDB.
// Endpoints run the background import + "extras" jobs and serve their logs.

import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { IMPORT_DIR, MAX_IMPORT_BYTES, TMDB_IMPORT_INTERVAL_MS } from '../config.js';
import { parseCsv } from '../csv.js';
import { ensureCached, readMetaSync, readSeasonMetaSync } from '../cache.js';
import { searchMovie, searchTv, setMinInterval } from '../tmdb.js';
import { recomputeStats } from '../stats.js';
import { runExtrasImport } from '../importExtras.js';

const NOT_FOUND_PATH = path.join(IMPORT_DIR, 'not_found.log');

// Which member an import fills: `user_id` from the request (the master picks it
// in Settings), else the caller. A member who hasn't joined yet is a valid
// target, so a library can be ready before its owner first signs in.
const userExistsStmt = db.prepare('SELECT id FROM users WHERE id = ?');
function importTarget(request) {
  const raw = (request.body || {}).user_id;
  if (raw === undefined || raw === null || raw === '') return request.user.id;
  const row = userExistsStmt.get(Number(raw));
  return row ? row.id : null;
}

// --- Prepared statements (compiled once at module load, reused thereafter) ---
// An import fills the library of the member who started it (`userId`).
const findLocalItemStmt = db.prepare('SELECT * FROM items WHERE user_id = ? AND type = ? AND tmdb_id = ?');
const insertShowStmt = db.prepare(
  `INSERT INTO items (user_id, tmdb_id, type, title_it, title_orig, status)
   VALUES (?, ?, 'show', ?, ?, 'watching')`
);
const insertProgressStmt = db.prepare(
  `INSERT INTO progress (item_id, season, episode, watch_count, watched_at)
   VALUES (?, ?, ?, 1, ?)
   ON CONFLICT(item_id, season, episode) DO NOTHING`
);
const countWatchedStmt = db.prepare(
  'SELECT COUNT(*) AS c FROM progress WHERE item_id = ? AND season > 0'
);
const setStatusStmt = db.prepare('UPDATE items SET status = ? WHERE id = ?');
const insertWatchedMovieStmt = db.prepare(
  `INSERT INTO items (user_id, tmdb_id, type, title_it, title_orig, status, updated_at)
   VALUES (?, ?, 'movie', ?, ?, 'completed', COALESCE(?, datetime('now')))`
);
const insertRewatchMovieStmt = db.prepare(
  `INSERT INTO items (user_id, tmdb_id, type, title_it, title_orig, status, rewatch_count, updated_at)
   VALUES (?, ?, 'movie', ?, ?, 'completed', 1, COALESCE(?, datetime('now')))`
);
const incrementRewatchStmt = db.prepare(
  'UPDATE items SET rewatch_count = rewatch_count + 1 WHERE id = ?'
);
const insertPlanMovieStmt = db.prepare(
  `INSERT INTO items (user_id, tmdb_id, type, title_it, title_orig, status)
   VALUES (?, ?, 'movie', ?, ?, 'plan_to_watch')`
);

// The "actions" file (mixed watch/movie/series rows) and the "episodes" file
// (per-episode detail) come under different names depending on the export:
//   - generic TV Time backup: tvtime_actions.csv / tvtime_episodes.csv
//   - TV Time GDPR export:     tracking-prod-records.csv / tracking-prod-records-v2.csv
// Both share the same relevant column names, so we just resolve whichever
// filename is present (generic name preferred).
const ACTIONS_CANDIDATES = ['tvtime_actions.csv', 'tracking-prod-records.csv'];
const EPISODES_CANDIDATES = [
  'tvtime_episodes.csv',
  'tracking-prod-records-v2.csv',
];

function resolveFile(candidates) {
  for (const name of candidates) {
    const p = path.join(IMPORT_DIR, name);
    if (fs.existsSync(p)) return { path: p, name };
  }
  return { path: null, name: null };
}

// Read a whole import file, refusing anything over the size cap so a giant or
// corrupt export can't exhaust memory, and rejecting anything that isn't valid
// UTF-8 text so a binary file dropped into data/import/ fails cleanly instead of
// being fed to the CSV parser as mojibake. Thrown before any DB writes, so it
// fails the import without touching existing data.
function readImportText(p) {
  const { size } = fs.statSync(p);
  if (size > MAX_IMPORT_BYTES) {
    throw new Error(`import file too large: ${size} bytes (max ${MAX_IMPORT_BYTES})`);
  }
  const buf = fs.readFileSync(p);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new Error('import file is not valid UTF-8 text');
  }
}

// In-memory job state (single-user, one-shot import).
const job = {
  running: false,
  finished: false,
  job_id: null,
  total: 0,
  processed: 0,
  imported_shows: 0,
  imported_movies: 0,
  skipped: 0,
  not_found: 0,
  current_title: null,
};

function resetJob(jobId) {
  job.running = true;
  job.finished = false;
  job.job_id = jobId;
  job.total = 0;
  job.processed = 0;
  job.imported_shows = 0;
  job.imported_movies = 0;
  job.skipped = 0;
  job.not_found = 0;
  job.current_title = null;
}

function snapshot() {
  return {
    running: job.running,
    finished: job.finished,
    job_id: job.job_id,
    total: job.total,
    processed: job.processed,
    imported_shows: job.imported_shows,
    imported_movies: job.imported_movies,
    skipped: job.skipped,
    not_found: job.not_found,
    current_title: job.current_title,
  };
}

function logNotFound(line) {
  fs.appendFileSync(NOT_FOUND_PATH, `${line}\n`);
  job.not_found += 1;
}

function findLocalItem(userId, type, tmdbId) {
  return findLocalItemStmt.get(userId, type, String(tmdbId));
}

// --- Movie helpers --------------------------------------------------------

const movieSearchCache = new Map(); // name -> tmdbId | null

async function resolveMovie(name) {
  if (movieSearchCache.has(name)) return movieSearchCache.get(name);
  let id = null;
  try {
    const results = await searchMovie(name);
    if (results.length) id = String(results[0].id);
  } catch {
    id = null;
  }
  movieSearchCache.set(name, id);
  return id;
}

// --- Series helpers -------------------------------------------------------

const seriesSearchCache = new Map();

async function resolveSeriesByName(name) {
  if (seriesSearchCache.has(name)) return seriesSearchCache.get(name);
  let id = null;
  try {
    const results = await searchTv(name);
    if (results.length) id = String(results[0].id);
  } catch {
    id = null;
  }
  seriesSearchCache.set(name, id);
  return id;
}

// Total real (non-special) episodes from cached meta.
function totalRealEpisodes(tmdbId) {
  const meta = readMetaSync('show', tmdbId);
  if (!meta) return 0;
  return (meta.seasons || []).reduce((sum, s) => sum + (s.episode_count || 0), 0);
}

// --- Main import routine --------------------------------------------------

async function runImport(userId) {
  // Space every TMDB call for the duration of the job to stay under the API limit.
  setMinInterval(TMDB_IMPORT_INTERVAL_MS);

  // Start from a clean slate so a re-run doesn't serve stale name→id resolutions.
  movieSearchCache.clear();
  seriesSearchCache.clear();

  // Fresh not_found log.
  try {
    fs.writeFileSync(NOT_FOUND_PATH, '');
  } catch {
    /* ignore */
  }

  const actionsFile = resolveFile(ACTIONS_CANDIDATES);
  const episodesFile = resolveFile(EPISODES_CANDIDATES);

  const actionsText = readImportText(actionsFile.path);
  const actions = parseCsv(actionsText);

  // Phase 0: episode pre-processing (if the episodes file exists).
  const episodeDict = {}; // s_id -> [{ season_number, ep_no, episode_id, created_at }]
  const episodeSeriesName = {}; // s_id -> series_name (from the episodes file)
  if (episodesFile.path) {
    const epRows = parseCsv(readImportText(episodesFile.path));
    for (const row of epRows) {
      if (String(row.is_special) === '1') continue; // specials excluded
      if ((row.key || '').includes('rewatch-episode')) continue; // rewatches out
      const sid = row.s_id;
      if (!sid) continue;
      const seasonNumber = parseInt(row.season_number, 10);
      const epNo = parseInt(row.ep_no, 10);
      if (!Number.isFinite(seasonNumber) || !Number.isFinite(epNo)) continue;
      if (seasonNumber < 1) continue;
      if (!episodeDict[sid]) episodeDict[sid] = [];
      episodeDict[sid].push({
        season_number: seasonNumber,
        ep_no: epNo,
        episode_id: row.episode_id || null,
        created_at: row.created_at || null,
      });
      if (row.series_name && !episodeSeriesName[sid]) {
        episodeSeriesName[sid] = row.series_name;
      }
    }
  }

  // In the GDPR export `type=watch` is overloaded: it marks both movie watches
  // (entity_type='movie') AND episode watches (entity_type='episode'). Only the
  // movie ones are relevant here — episodes come from the episodes file. The
  // generic backup has no entity_type column, so treat a missing value as movie.
  const isMovieRow = (r) => {
    const ent = r.entity_type;
    return (ent === undefined || ent === '' || ent === 'movie') && !!r.movie_name;
  };

  // Split actions by type.
  const seriesRowsRaw = [];
  const watchRows = [];
  const rewatchRows = [];
  const towatchRows = [];
  for (const r of actions) {
    switch (r.type) {
      case 'count-watch-episode-series':
        seriesRowsRaw.push(r);
        break;
      case 'watch':
        if (isMovieRow(r)) watchRows.push(r);
        break;
      case 'rewatch':
        if (isMovieRow(r)) rewatchRows.push(r);
        break;
      case 'towatch':
        if (isMovieRow(r)) towatchRows.push(r);
        break;
      default:
        break; // silently ignore all other types
    }
  }

  // Deduplicate series by series_id, keeping the most recent updated_at.
  const seriesById = new Map();
  for (const r of seriesRowsRaw) {
    const id = r.series_id;
    if (!id) continue;
    const prev = seriesById.get(id);
    if (!prev || (r.updated_at || '') > (prev.updated_at || '')) {
      seriesById.set(id, r);
    }
  }

  // Also import every series that has watched episodes in the episodes file but
  // no count-watch-episode-series row (TV Time only keeps those counts for
  // still-followed shows, yet the episode history covers many more). These use
  // precise reconstruction from the grouped episodes, so no watch_count needed.
  for (const sid of Object.keys(episodeDict)) {
    if (seriesById.has(sid)) continue;
    if (!episodeSeriesName[sid]) continue;
    seriesById.set(sid, {
      series_id: sid,
      series_name: episodeSeriesName[sid],
      watch_count: '',
      updated_at: '',
    });
  }
  const seriesRows = [...seriesById.values()];

  job.total =
    seriesRows.length +
    watchRows.length +
    rewatchRows.length +
    towatchRows.length;

  // --- Series import ------------------------------------------------------
  for (const row of seriesRows) {
    job.current_title = row.series_name;
    const tvTimeId = row.series_id;
    const group = episodeDict[tvTimeId];

    // Match to TMDB by name search. (The export's episode_id is not a TMDB
    // episode id, so an id-based lookup would be unreliable — name search on
    // the series_name is the dependable path here.)
    const tmdbId = await resolveSeriesByName(row.series_name);

    if (!tmdbId) {
      logNotFound(`[SERIES] ${row.series_name} (TV Time ID: ${tvTimeId})`);
      job.processed += 1;
      continue;
    }

    if (findLocalItem(userId, 'show', tmdbId)) {
      job.skipped += 1;
      job.processed += 1;
      continue;
    }

    // Add series (download cache).
    let meta;
    try {
      meta = await ensureCached('show', tmdbId);
    } catch {
      logNotFound(`[SERIES] ${row.series_name} (TV Time ID: ${tvTimeId})`);
      job.processed += 1;
      continue;
    }

    // Everything after ensureCached is synchronous (DB writes + cached meta
    // reads), so commit the item insert, its progress rows, and the final status
    // as ONE transaction. Otherwise a crash between them leaves a `watching` show
    // with no/partial progress — and because a re-run skips items that already
    // exist (findLocalItem above), that half-import would never self-heal.
    const importOne = db.transaction(() => {
      const info = insertShowStmt.run(
        userId,
        String(tmdbId),
        meta.title_it || meta.title_orig || row.series_name,
        meta.title_orig || meta.title_it || row.series_name
      );
      const itemId = info.lastInsertRowid;

      let watchedCount = 0;
      if (group && group.length) {
        // Precise reconstruction.
        for (const e of group) {
          insertProgressStmt.run(itemId, e.season_number, e.ep_no, e.created_at || null);
        }
        watchedCount = countWatchedStmt.get(itemId).c;
      } else {
        // Fallback: sequential reconstruction from watch_count.
        const target = parseInt(row.watch_count, 10) || 0;
        const ordered = [];
        for (const s of meta.seasons || []) {
          const sMeta = readSeasonMetaSync(tmdbId, s.season_number);
          if (!sMeta) continue;
          for (const ep of sMeta.episodes) {
            ordered.push({ season: s.season_number, episode: ep.episode_number });
          }
        }
        for (let k = 0; k < Math.min(target, ordered.length); k++) {
          insertProgressStmt.run(
            itemId,
            ordered[k].season,
            ordered[k].episode,
            row.updated_at || null
          );
        }
        watchedCount = Math.min(target, ordered.length);
      }

      // Determine completion status.
      const totalReal = totalRealEpisodes(tmdbId);
      const status =
        totalReal > 0 && watchedCount >= totalReal ? 'completed' : 'watching';
      setStatusStmt.run(status, itemId);
    });
    importOne();

    job.imported_shows += 1;
    job.processed += 1;
  }

  // --- Movie import: watch (completed) ------------------------------------
  for (const row of watchRows) {
    const name = row.movie_name;
    job.current_title = name;
    const tmdbId = await resolveMovie(name);
    if (!tmdbId) {
      logNotFound(`[MOVIE] ${name}`);
      job.processed += 1;
      continue;
    }
    if (findLocalItem(userId, 'movie', tmdbId)) {
      job.skipped += 1;
      job.processed += 1;
      continue;
    }
    let meta;
    try {
      meta = await ensureCached('movie', tmdbId);
    } catch {
      logNotFound(`[MOVIE] ${name}`);
      job.processed += 1;
      continue;
    }
    const watchDate = row.watch_date || row.created_at || null;
    insertWatchedMovieStmt.run(
      userId,
      String(tmdbId),
      meta.title_it || meta.title_orig || name,
      meta.title_orig || meta.title_it || name,
      watchDate
    );
    job.imported_movies += 1;
    job.processed += 1;
  }

  // --- Movie import: rewatch (increment rewatch_count) --------------------
  for (const row of rewatchRows) {
    const name = row.movie_name;
    job.current_title = name;
    const tmdbId = await resolveMovie(name);
    if (!tmdbId) {
      logNotFound(`[MOVIE] ${name}`);
      job.processed += 1;
      continue;
    }
    let item = findLocalItem(userId, 'movie', tmdbId);
    if (!item) {
      // Not previously watched in the export — add it as completed first.
      let meta;
      try {
        meta = await ensureCached('movie', tmdbId);
      } catch {
        logNotFound(`[MOVIE] ${name}`);
        job.processed += 1;
        continue;
      }
      insertRewatchMovieStmt.run(
        userId,
        String(tmdbId),
        meta.title_it || meta.title_orig || name,
        meta.title_orig || meta.title_it || name,
        row.watch_date || row.created_at || null
      );
      job.imported_movies += 1;
    } else {
      incrementRewatchStmt.run(item.id);
    }
    job.processed += 1;
  }

  // --- Movie import: towatch (plan_to_watch) ------------------------------
  for (const row of towatchRows) {
    const name = row.movie_name;
    job.current_title = name;
    const tmdbId = await resolveMovie(name);
    if (!tmdbId) {
      logNotFound(`[MOVIE] ${name}`);
      job.processed += 1;
      continue;
    }
    if (findLocalItem(userId, 'movie', tmdbId)) {
      job.skipped += 1;
      job.processed += 1;
      continue;
    }
    let meta;
    try {
      meta = await ensureCached('movie', tmdbId);
    } catch {
      logNotFound(`[MOVIE] ${name}`);
      job.processed += 1;
      continue;
    }
    insertPlanMovieStmt.run(
      userId,
      String(tmdbId),
      meta.title_it || meta.title_orig || name,
      meta.title_orig || meta.title_it || name
    );
    job.imported_movies += 1;
    job.processed += 1;
  }

  // Update stats once at the end.
  await recomputeStats(db, userId);

  setMinInterval(0);
  job.current_title = null;
  job.running = false;
  job.finished = true;
}

export default async function importRoutes(fastify) {
  // Import file status for the Settings UI.
  // GET /api/import/files — ON-DEMAND scan of data/import/ (the client calls it
  // only when the user taps "Check import files"). Reports presence, size, row
  // count and whether the expected column headers are present.
  fastify.get('/api/import/files', async () => {
    // The columns the importer actually reads; a file missing them is unusable.
    const ACTIONS_REQUIRED = ['type'];
    const EPISODES_REQUIRED = ['s_id', 'season_number', 'ep_no'];

    function headerLine(text) {
      const first = (text.split(/\r?\n/, 1)[0] || '').replace(/^﻿/, '');
      return first.split(',').map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
    }

    function check(file, required) {
      if (!file.path) return { found: false, size: 0, name: null, rows: 0, valid: false };
      let st;
      try {
        st = fs.statSync(file.path);
      } catch {
        return { found: false, size: 0, name: null, rows: 0, valid: false };
      }
      if (st.size > MAX_IMPORT_BYTES) {
        return { found: true, name: file.name, size: st.size, rows: 0, valid: false, issue: 'File is too large to import.' };
      }
      let text;
      try {
        text = fs.readFileSync(file.path, 'utf-8');
      } catch {
        return { found: true, name: file.name, size: st.size, rows: 0, valid: false, issue: 'File could not be read.' };
      }
      const headers = new Set(headerLine(text));
      const missing = required.filter((c) => !headers.has(c));
      let rows = 0;
      try {
        rows = parseCsv(text).length;
      } catch {
        rows = 0;
      }
      const valid = missing.length === 0 && rows > 0;
      let issue = null;
      if (missing.length) issue = `Missing expected column(s): ${missing.join(', ')}.`;
      else if (rows === 0) issue = 'No data rows found.';
      return { found: true, name: file.name, size: st.size, rows, valid, issue };
    }

    return {
      actions: check(resolveFile(ACTIONS_CANDIDATES), ACTIONS_REQUIRED),
      episodes: check(resolveFile(EPISODES_CANDIDATES), EPISODES_REQUIRED),
    };
  });

  // POST /api/import/tvtime → start the background import.
  fastify.post('/api/import/tvtime', async (request, reply) => {
    if (job.running) {
      reply.code(409);
      return { error: 'import already running', job_id: job.job_id };
    }
    if (!resolveFile(ACTIONS_CANDIDATES).path) {
      reply.code(400);
      return {
        error:
          'Actions file not found in data/import/ (expected tvtime_actions.csv or tracking-prod-records.csv)',
      };
    }
    const target = importTarget(request);
    if (!target) {
      reply.code(404);
      return { error: 'member not found' };
    }
    const jobId = `import_${Date.now()}`;
    resetJob(jobId);
    // Run in the background; never let a failure crash the process.
    runImport(target).catch((err) => {
      fastify.log.error(`import failed: ${err.message}`);
      setMinInterval(0);
      job.running = false;
      job.finished = true;
    });
    return { job_id: jobId };
  });

  // GET /api/import/status → current job progress.
  fastify.get('/api/import/status', async () => snapshot());

  // --- Supplemental "extras" import (favourites, lists, rewatch counts,
  // watchlist). Runs in-process so it shares the DB connection (no locking). ---
  const extrasJob = { running: false, finished: false, summary: null, started_at: null };

  // POST /api/import/extras → start the background extras import.
  fastify.post('/api/import/extras', async (request, reply) => {
    if (extrasJob.running) {
      reply.code(409);
      return { error: 'extras import already running' };
    }
    const target = importTarget(request);
    if (!target) {
      reply.code(404);
      return { error: 'member not found' };
    }
    extrasJob.running = true;
    extrasJob.finished = false;
    extrasJob.summary = null;
    extrasJob.started_at = Date.now();
    runExtrasImport(target)
      .then((s) => {
        extrasJob.summary = s;
      })
      .catch((err) => {
        fastify.log.error(`extras import failed: ${err.message}`);
        extrasJob.summary = { error: err.message };
        setMinInterval(0);
      })
      .finally(() => {
        extrasJob.running = false;
        extrasJob.finished = true;
      });
    return { started: true };
  });

  // GET /api/import/extras/status → progress + final summary.
  fastify.get('/api/import/extras/status', async () => ({ ...extrasJob }));

  // GET /api/import/extras/log → contents of import_extras.log.
  fastify.get('/api/import/extras/log', async () => {
    let content = '';
    try {
      content = fs.readFileSync(path.join(IMPORT_DIR, 'import_extras.log'), 'utf-8');
    } catch {
      content = '';
    }
    return { log: content };
  });

  // GET /api/import/log → contents of not_found.log.
  fastify.get('/api/import/log', async () => {
    let content = '';
    try {
      content = fs.readFileSync(NOT_FOUND_PATH, 'utf-8');
    } catch {
      content = '';
    }
    return { log: content };
  });
}
