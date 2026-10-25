// Core library endpoints under /api/media (plus /api/plan-to-watch, /api/unrated
// and /api/preview): lists the library with filters and sorting, serves a
// title's detail with lazy cache rebuild and per-season episode/watched state,
// and adds, updates (status/rating/notes/favorite/owned) and deletes titles.

import db from '../db.js';
import {
  ensureCached,
  readMetaSync,
  readSeasonMetaSync,
  isStale,
  refreshInBackground,
  ensureMovieCollectionField,
  clearItemCache,
  metaMissingBento,
  refreshMetaFields,
} from '../cache.js';
import { scheduleStatsRecompute } from '../stats.js';
import { clientAbortSignal } from '../http.js';
import { hasFanartDiscCached } from '../fanart.js';
import { imageVersion } from '../customImages.js';

const VALID_STATUS = [
  'watching',
  'completed',
  'paused',
  'dropped',
  'plan_to_watch',
];

function assetBase(type, tmdbId) {
  const folder = type === 'movie' ? 'movies' : 'shows';
  return `/assets/${folder}/${tmdbId}`;
}

// Poster and backdrop URLs for a row, carrying a version when the user has
// replaced that image. The file keeps its name, so without this the browser goes
// on showing the copy it already has (assets are served `immutable`).
function itemImageUrls(row) {
  const base = assetBase(row.type, row.tmdb_id);
  const pv = imageVersion(row.type, row.tmdb_id, 'poster');
  const bv = imageVersion(row.type, row.tmdb_id, 'backdrop');
  return {
    poster_url: `${base}/poster.webp${pv ? `?v=${pv}` : ''}`,
    backdrop_url: `${base}/backdrop.webp${bv ? `?v=${bv}` : ''}`,
  };
}

// Parse a query-string integer, clamped to [min, max], falling back to `def`
// when absent or malformed. Used for the additive episode pagination params.
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// --- Poster-grid section dividers (must mirror the client's groupKeyOf/
// groupLabelOf in views/grid.js so virtual layout and rendered labels agree).
// Alphabetical: first letter (non-letters bucket under '#'). Rating: the star
// value, 0 meaning unrated (which sorts last). Only the title/rating sorts group.
function gridGroupKey(item, sort) {
  if (sort === 'title') {
    const ch = (item.title_it || '').trim().charAt(0).toUpperCase();
    return /[A-Z]/.test(ch) ? ch : '#';
  }
  return item.rating ? item.rating : 0;
}
function gridGroupLabel(key, sort) {
  if (sort === 'title') return key;
  return key === 0 ? 'Unrated' : `${key} ★`;
}
// Contiguous divider runs over an ALREADY-sorted list: [{key,label,count}] in
// display order. The virtual grid uses these counts to size the full scroll
// height (dividers included) before any later page is fetched. Null for the
// non-grouped sorts (which render no dividers).
function gridGroups(list, sort) {
  if (sort !== 'title' && sort !== 'rating') return null;
  const groups = [];
  let prev = null;
  for (const it of list) {
    const key = gridGroupKey(it, sort);
    if (!groups.length || key !== prev) {
      groups.push({ key, label: gridGroupLabel(key, sort), count: 0 });
      prev = key;
    }
    groups[groups.length - 1].count += 1;
  }
  return groups;
}

// year + genres come from denormalized columns; if a row predates the columns
// (NULL), backfill them from meta.json once so subsequent reads never touch disk.
const backfillMetaStmt = db.prepare('UPDATE items SET year = ?, genres = ? WHERE id = ?');
// All rows of one type (any status) — used only to build the filter dropdown's
// distinct genre list, which must reflect the WHOLE type library regardless of
// the active status chip (matching the pre-pagination behaviour where the client
// derived genres from the full list it had loaded).
const typeItemsStmt = db.prepare('SELECT * FROM items WHERE type = ? AND user_id = ?');

// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
// The library list query (dynamic WHERE) and the PATCH update (dynamic SET) are
// built per request from a fixed whitelist of columns with bound values, so they
// stay inline; every fixed-shape query below is hoisted here.
//
// Every query is bound to the signed-in member (`user_id`). Lookups by item id
// check the owner too, so another member's id answers 404, exactly like an id that
// doesn't exist. Progress and rewatch rows are only reached through an item that
// has passed that check.
const getItemByIdStmt = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?');
const allLastWatchedStmt = db.prepare(
  `SELECT p.item_id, p.season, p.episode
     FROM progress p JOIN items i ON i.id = p.item_id
    WHERE i.user_id = ? AND p.season > 0
    ORDER BY p.item_id, p.season DESC, p.episode DESC`
);
const planToWatchStmt = db.prepare(
  "SELECT id, type, tmdb_id, title_it, rating FROM items WHERE user_id = ? AND status = 'plan_to_watch' ORDER BY added_at DESC, id DESC"
);
const unratedStmt = db.prepare(
  "SELECT * FROM items WHERE user_id = ? AND rating IS NULL AND status != 'plan_to_watch' ORDER BY RANDOM()"
);
const watchedSeasonsStmt = db.prepare(
  'SELECT season, episode FROM progress WHERE item_id = ? AND season > 0'
);
const seasonWatchedStmt = db.prepare(
  'SELECT episode, watch_count, watched_at, notes FROM progress WHERE item_id = ? AND season = ?'
);
const findByTypeTmdbStmt = db.prepare(
  'SELECT id, status FROM items WHERE user_id = ? AND type = ? AND tmdb_id = ?'
);
const insertItemStmt = db.prepare(
  `INSERT INTO items (user_id, tmdb_id, type, title_it, title_orig, status)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const deleteItemStmt = db.prepare('DELETE FROM items WHERE id = ? AND user_id = ?');
// Removing a title takes it out of the same member's lists of that type, nobody else's.
const deleteItemListRefsStmt = db.prepare(
  `DELETE FROM list_items
    WHERE tmdb_id = ? AND list_id IN (SELECT id FROM lists WHERE user_id = ? AND type = ?)`
);
// Whether any member still has this title (its cache folder is shared).
const titleHeldStmt = db.prepare('SELECT 1 FROM items WHERE type = ? AND tmdb_id = ? LIMIT 1');
// Movie rewatch events + the paired rewatch_count counter (always updated together
// in a single transaction so they can never diverge — see the endpoints below).
const insertRewatchStmt = db.prepare(
  'INSERT INTO movie_rewatches (item_id, watched_at, created_at) VALUES (?, ?, ?)'
);
const deleteRewatchStmt = db.prepare('DELETE FROM movie_rewatches WHERE id = ? AND item_id = ?');
const listRewatchesStmt = db.prepare(
  'SELECT id, watched_at FROM movie_rewatches WHERE item_id = ? ORDER BY watched_at DESC, id DESC'
);
const incRewatchCountStmt = db.prepare('UPDATE items SET rewatch_count = rewatch_count + 1 WHERE id = ?');
const decRewatchCountStmt = db.prepare(
  'UPDATE items SET rewatch_count = MAX(0, rewatch_count - 1) WHERE id = ?'
);
const setWatchDateStmt = db.prepare('UPDATE items SET watch_date = ? WHERE id = ?');

// A date-only 'YYYY-MM-DD' string (a real calendar date), else null.
function validDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : v;
}
function itemYearGenres(row) {
  if (row.year != null && row.genres != null) {
    let genres = [];
    try {
      genres = JSON.parse(row.genres);
    } catch {
      genres = [];
    }
    return { year: row.year, genres };
  }
  const meta = readMetaSync(row.type, row.tmdb_id);
  const year = meta && meta.year ? meta.year : '';
  const genres = meta && Array.isArray(meta.genres) ? meta.genres : [];
  backfillMetaStmt.run(year, JSON.stringify(genres), row.id);
  return { year, genres };
}

// Attach cached metadata (year, genres, poster/backdrop urls, last_watched) to a
// row. `lastWatched` is a Map(item_id -> {season,episode}) built once per request
// so the list doesn't issue a per-show query (avoids the N+1).
function enrichListItem(row, lastWatched) {
  const { year, genres } = itemYearGenres(row);
  const item = {
    id: row.id,
    tmdb_id: row.tmdb_id,
    type: row.type,
    title_it: row.title_it,
    title_orig: row.title_orig,
    status: row.status,
    rating: row.rating,
    favorite: !!row.favorite,
    notes: row.notes,
    rewatch_count: row.rewatch_count,
    added_at: row.added_at,
    updated_at: row.updated_at,
    year,
    genres,
    ...itemImageUrls(row),
    last_watched: null,
  };
  if (row.type === 'show') {
    const lw = lastWatched.get(row.id);
    if (lw) item.last_watched = { season: lw.season, episode: lw.episode };
  }
  return item;
}

// Distinct genres across an entire type library (all statuses), sorted — the
// source for the grid's genre <select>. Computed only on page 1 of a paginated
// request so it isn't repeated on every page.
function typeGenres(type, userId) {
  if (!type) return [];
  const set = new Set();
  for (const row of typeItemsStmt.all(type, userId)) {
    for (const g of itemYearGenres(row).genres || []) set.add(g);
  }
  return [...set].sort();
}

// Build the detailed show progress structure from cached season metadata.
function buildShowProgress(itemId, tmdbId, meta) {
  const seasons = [];
  let totalEpisodes = 0;
  let watchedEpisodes = 0;
  const watchedRows = watchedSeasonsStmt.all(itemId);
  const watchedBySeason = {};
  for (const r of watchedRows) {
    watchedBySeason[r.season] = (watchedBySeason[r.season] || 0) + 1;
  }

  for (const s of meta.seasons || []) {
    const sMeta = readSeasonMetaSync(tmdbId, s.season_number);
    const total = sMeta ? sMeta.episodes.length : s.episode_count || 0;
    const watched = watchedBySeason[s.season_number] || 0;
    totalEpisodes += total;
    watchedEpisodes += watched;
    seasons.push({
      season_number: s.season_number,
      name: s.name || `Season ${s.season_number}`,
      total,
      watched,
      poster_url: `${assetBase('show', tmdbId)}/seasons/s${s.season_number}/poster.webp`,
    });
  }

  // Current season = first partially-watched season (0 < watched < total).
  let currentSeason = null;
  let episodesLeft = 0;
  for (const s of seasons) {
    if (s.total > 0 && s.watched > 0 && s.watched < s.total) {
      currentSeason = s.season_number;
      episodesLeft = s.total - s.watched;
      break;
    }
  }

  return {
    total_episodes: totalEpisodes,
    watched_episodes: watchedEpisodes,
    percent: totalEpisodes ? Math.round((watchedEpisodes / totalEpisodes) * 100) : 0,
    seasons,
    current_season: currentSeason,
    episodes_left: episodesLeft,
  };
}

export default async function mediaRoutes(fastify) {
  // GET /api/media  (filters: status, type, genre, sort, owned)
  fastify.get('/api/media', async (request) => {
    const { status, type, genre, sort, owned } = request.query;
    const userId = request.user.id;
    const clauses = ['user_id = ?'];
    const params = [userId];
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (type) {
      clauses.push('type = ?');
      params.push(type);
    }
    // Owned-only filter (the "Owned" grid chip) — independent of status, so the
    // client sends `owned=1` with no status to list every owned title.
    if (owned === '1' || owned === 'true') {
      clauses.push('owned = 1');
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const rows = db
      .prepare(`SELECT * FROM items ${where}`)
      .all(...params);

    // Last-watched per show in ONE query (rows come highest-first, so the first
    // seen per item_id is its latest episode) — avoids a per-row query.
    const lastWatched = new Map();
    for (const p of allLastWatchedStmt.all(userId)) {
      if (!lastWatched.has(p.item_id)) {
        lastWatched.set(p.item_id, { season: p.season, episode: p.episode });
      }
    }

    let list = rows.map((row) => enrichListItem(row, lastWatched));

    if (genre) {
      list = list.filter((it) => (it.genres || []).includes(genre));
    }

    switch (sort) {
      case 'rating':
        list.sort((a, b) => (b.rating || 0) - (a.rating || 0));
        break;
      case 'title':
        list.sort((a, b) => a.title_it.localeCompare(b.title_it));
        break;
      case 'added_at':
      default:
        list.sort((a, b) => (a.added_at < b.added_at ? 1 : -1));
        break;
    }

    // Pagination is ADDITIVE and opt-in: only when the caller passes `page`
    // and/or `pageSize`. Without them the full filtered+sorted list is returned
    // exactly as before (backward-compatible for any non-paginated caller). The
    // slice is taken from the SAME fully-sorted list the group counts come from,
    // so page order and divider layout stay perfectly consistent.
    const q = request.query || {};
    if (q.page === undefined && q.pageSize === undefined) {
      return { items: list };
    }
    const total = list.length;
    const pageSize = clampInt(q.pageSize, 48, 1, 200);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = clampInt(q.page, 1, 1, totalPages);
    const startIdx = (page - 1) * pageSize;
    const resp = {
      items: list.slice(startIdx, startIdx + pageSize),
      total,
      page,
      pageSize,
      totalPages,
    };
    // Page 1 carries the layout metadata the virtual grid needs up front: the
    // section-divider groups for the active grouped sort (to size the full scroll
    // height, dividers included, before any later page loads) and the distinct
    // genres across the whole type library for the filter dropdown. Sent once.
    if (page === 1) {
      resp.groups = gridGroups(list, sort);
      resp.genres = typeGenres(type, userId);
    }
    return resp;
  });

  // GET /api/plan-to-watch  — compact list of the Plan-to-Watch shelf used to
  // render the Movies/Series "Plan to Watch" poster grid offline. Small by
  // design (no meta/genres), but includes each poster URL so the service worker
  // can warm the images and the grid can show real poster cards offline.
  // Newest-added first, matching the library's default order.
  fastify.get('/api/plan-to-watch', async (request) => {
    const rows = planToWatchStmt.all(request.user.id);
    return {
      titles: rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title_it,
        rating: r.rating,
        poster_url: `${assetBase(r.type, r.tmdb_id)}/poster.webp`,
      })),
    };
  });

  // GET /api/unrated — watched-but-unrated titles (movies + shows) for the
  // Rate-O-Matic swipe rater. "Watched" = any status except plan_to_watch, so
  // titles the user hasn't started never appear. Shuffled in SQL (ORDER BY
  // RANDOM()) so the order carries no alphabetical / date-added bias.
  fastify.get('/api/unrated', async (request) => {
    const rows = unratedStmt.all(request.user.id);
    return {
      titles: rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title_it,
        year: itemYearGenres(row).year || null,
        favorite: !!row.favorite,
        poster_url: `${assetBase(row.type, row.tmdb_id)}/poster.webp`,
      })),
    };
  });

  // GET /api/media/:id  (detail, with lazy rebuild + background refresh)
  fastify.get('/api/media/:id', async (request, reply) => {
    const row = getItemByIdStmt.get(request.params.id, request.user.id);
    if (!row) {
      reply.code(404);
      return { error: 'not found' };
    }

    const signal = clientAbortSignal(request, reply);

    // Lazy rebuild if the meta was cleared from disk.
    let meta = readMetaSync(row.type, row.tmdb_id);
    if (!meta) {
      try {
        meta = await ensureCached(row.type, row.tmdb_id, { signal });
      } catch (err) {
        if (err && err.name === 'AbortError') {
          reply.hijack(); // client gone — don't attempt a response
          return;
        }
        fastify.log.warn(`lazy rebuild failed: ${err.message}`);
      }
    }

    // Ongoing shows: refresh in the background if stale (non-blocking).
    if (meta && isStale(meta)) {
      refreshInBackground(row.type, row.tmdb_id, fastify.log);
    }

    // Backfill the newer "Details" metadata fields into caches created before
    // they existed. Movies never auto-refresh and some shows aren't ongoing, so
    // do a one-time lightweight meta refetch (no image/season re-download) on the
    // first open. Self-heals: once meta.json has the fields, this is skipped.
    if (meta && metaMissingBento(row.type, meta)) {
      try {
        meta = await refreshMetaFields(row.type, row.tmdb_id, { signal });
      } catch (err) {
        if (err && err.name === 'AbortError') {
          reply.hijack();
          return;
        }
        /* cap reached / TMDB error → leave old meta; Details stays hidden/sparse */
      }
    }

    // Backfill a movie's collection reference for caches created before the
    // field was stored (one-time TMDB call, then persisted into meta.json).
    if (row.type === 'movie' && meta && !('belongs_to_collection' in meta)) {
      try {
        meta.belongs_to_collection = await ensureMovieCollectionField(row.tmdb_id);
      } catch {
        /* leave undefined — the collection section is simply skipped */
      }
    }

    const result = {
      id: row.id,
      tmdb_id: row.tmdb_id,
      type: row.type,
      title_it: row.title_it,
      title_orig: row.title_orig,
      status: row.status,
      rating: row.rating,
      favorite: !!row.favorite,
      owned: !!row.owned,
      // Cinema fields (meaningful for movies; false/null for shows).
      watched_in_cinema: !!row.watched_in_cinema,
      cinema_date: row.cinema_date || null,
      cinema_time: row.cinema_time || null,
      cinema_name: row.cinema_name || null,
      notes: row.notes,
      rewatch_count: row.rewatch_count,
      // Editable first-watch date (movies); null → the client falls back to
      // date(updated_at), matching the receipt/export.
      watch_date: row.watch_date || null,
      added_at: row.added_at,
      updated_at: row.updated_at,
      ...itemImageUrls(row),
      // The disc art lives behind /api/fanart, served `immutable` too, so the
      // client appends this when the user has replaced it.
      fanart_v: imageVersion(row.type, row.tmdb_id, 'fanart'),
      // Whether a real Fanart disc is cached (movies only); else the client uses
      // the poster-based disc rendering. Never triggers a network fetch.
      disc_available: row.type === 'movie' && hasFanartDiscCached(row.tmdb_id),
      meta: meta || null,
      cached_at: meta ? meta.cached_at : null,
    };

    if (row.type === 'show' && meta) {
      result.progress = buildShowProgress(row.id, row.tmdb_id, meta);
    }

    return result;
  });

  // GET /api/preview/:type/:tmdbId
  // Full detail for a title that may NOT be in the library. Caches its meta +
  // images (no DB row is created — nothing is added), so the client can show the
  // normal detail view without adding it. If it already happens to be in the
  // library, the existing row's item_id/status is returned so the client can
  // redirect to the real detail instead.
  fastify.get('/api/preview/:type/:tmdbId', async (request, reply) => {
    const { type, tmdbId } = request.params;
    if ((type !== 'movie' && type !== 'show') || !/^\d+$/.test(tmdbId)) {
      reply.code(400);
      return { error: 'invalid preview request' };
    }
    const signal = clientAbortSignal(request, reply);

    let meta;
    try {
      meta = await ensureCached(type, tmdbId, { signal });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        reply.hijack(); // client navigated away
        return;
      }
      fastify.log.error(err); // full detail stays in the server log only
      reply.code(502);
      return { error: 'failed to fetch title' };
    }

    if (type === 'movie' && meta && !('belongs_to_collection' in meta)) {
      try {
        meta.belongs_to_collection = await ensureMovieCollectionField(tmdbId);
      } catch {
        /* collection section simply skipped */
      }
    }

    const existing = findByTypeTmdbStmt.get(request.user.id, type, tmdbId);

    const base = assetBase(type, tmdbId);
    return {
      tmdb_id: parseInt(tmdbId, 10),
      type,
      title_it: meta ? meta.title_it : '',
      title_orig: meta ? meta.title_orig : '',
      poster_url: `${base}/poster.webp`,
      backdrop_url: `${base}/backdrop.webp`,
      meta: meta || null,
      in_library: !!existing,
      item_id: existing ? existing.id : null,
      status: existing ? existing.status : null,
    };
  });

  // GET /api/media/:id/season/:n  → episodes merged with watched state.
  fastify.get('/api/media/:id/season/:n', async (request, reply) => {
    const row = getItemByIdStmt.get(request.params.id, request.user.id);
    if (!row || row.type !== 'show') {
      reply.code(404);
      return { error: 'not found' };
    }
    const seasonNumber = parseInt(request.params.n, 10);
    let sMeta = readSeasonMetaSync(row.tmdb_id, seasonNumber);
    if (!sMeta) {
      // Lazy rebuild the show to recover season metadata.
      try {
        await ensureCached('show', row.tmdb_id, {
          force: true,
          signal: clientAbortSignal(request, reply),
        });
        sMeta = readSeasonMetaSync(row.tmdb_id, seasonNumber);
      } catch (err) {
        if (err && err.name === 'AbortError') {
          reply.hijack(); // client gone — don't attempt a response
          return;
        }
        fastify.log.warn(`season rebuild failed: ${err.message}`);
      }
    }
    if (!sMeta) {
      reply.code(404);
      return { error: 'season not found' };
    }

    const watchedRows = seasonWatchedStmt.all(row.id, seasonNumber);
    const watchedMap = {};
    for (const r of watchedRows) watchedMap[r.episode] = r;

    const base = assetBase('show', row.tmdb_id);
    // Stable ordering — episode_number ascending, matching how episodes are
    // displayed — so the pagination slices below are consistent across pages.
    const allEpisodes = sMeta.episodes
      .slice()
      .sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0))
      .map((e) => {
        const w = watchedMap[e.episode_number];
        return {
          episode_number: e.episode_number,
          name: e.name,
          overview: e.overview,
          air_date: e.air_date,
          runtime: e.runtime,
          still_url: e.still_path
            ? `${base}/seasons/s${seasonNumber}/ep${e.episode_number}.webp`
            : null,
          watched: !!w,
          watch_count: w ? w.watch_count : 0,
          notes: w ? w.notes : null,
        };
      });

    // Absolute index (in the ordered list) of the episode to "jump to": the first
    // unwatched episode (where the viewer left off), or — when the whole season is
    // watched — the last episode. Computed from the full season's watched state, so
    // it's correct even though the client only fetches a page at a time.
    const firstUnwatched = allEpisodes.findIndex((e) => !e.watched);
    const nextIndex = firstUnwatched >= 0 ? firstUnwatched : Math.max(0, allEpisodes.length - 1);

    const baseResp = {
      item_id: row.id,
      // The series' title, for the season page's link back to the series.
      show_title: row.title_it || row.title_orig || null,
      season_number: seasonNumber,
      name: sMeta.name,
      overview: sMeta.overview,
      poster_url: `${base}/seasons/s${seasonNumber}/poster.webp`,
      next_index: nextIndex,
    };

    // Pagination is ADDITIVE and opt-in: only when the caller passes `page`
    // and/or `pageSize`. Without them, the full episode list is returned exactly
    // as before (backward-compatible for any non-paginated caller). `total`
    // counts every episode in the season; `totalPages` derives from the clamped
    // pageSize (default 50).
    const q = request.query || {};
    if (q.page === undefined && q.pageSize === undefined) {
      return { ...baseResp, episodes: allEpisodes };
    }
    const total = allEpisodes.length;
    const pageSize = clampInt(q.pageSize, 50, 1, 200);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = clampInt(q.page, 1, 1, totalPages);
    const startIdx = (page - 1) * pageSize;
    return {
      ...baseResp,
      episodes: allEpisodes.slice(startIdx, startIdx + pageSize),
      total,
      page,
      pageSize,
      totalPages,
    };
  });

  // POST /api/media  → add a new title (downloads TMDB cache first).
  fastify.post('/api/media', async (request, reply) => {
    const { tmdb_id, type, status } = request.body || {};
    if (!tmdb_id || (type !== 'movie' && type !== 'show')) {
      reply.code(400);
      return { error: 'tmdb_id and valid type are required' };
    }
    // TMDB ids are numeric; reject anything else so a crafted id can never reach
    // the filesystem cache path in ensureCached (consistent with the other id
    // endpoints: preview, admin cache, collections, fanart).
    if (!/^\d+$/.test(String(tmdb_id))) {
      reply.code(400);
      return { error: 'invalid tmdb_id' };
    }
    const initialStatus =
      status && VALID_STATUS.includes(status) ? status : 'plan_to_watch';

    const existing = findByTypeTmdbStmt.get(request.user.id, type, String(tmdb_id));
    if (existing) {
      reply.code(409);
      return { error: 'already_added', item_id: existing.id };
    }

    let meta;
    try {
      meta = await ensureCached(type, tmdb_id, {
        signal: clientAbortSignal(request, reply),
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        reply.hijack(); // client gone — don't attempt a response
        return;
      }
      fastify.log.error(err); // full detail stays in the server log only
      reply.code(502);
      return { error: 'failed to fetch from TMDB' };
    }

    const insert = db.transaction(() => {
      const info = insertItemStmt.run(
        request.user.id,
        String(tmdb_id),
        type,
        meta.title_it || meta.title_orig || 'Untitled',
        meta.title_orig || meta.title_it || 'Untitled',
        initialStatus
      );
      scheduleStatsRecompute(db);
      return info.lastInsertRowid;
    });
    const id = insert();

    reply.code(201);
    return { id };
  });

  // PATCH /api/media/:id  → update status, rating, notes.
  fastify.patch('/api/media/:id', async (request, reply) => {
    const row = getItemByIdStmt.get(request.params.id, request.user.id);
    if (!row) {
      reply.code(404);
      return { error: 'not found' };
    }
    const body = request.body || {};
    const fields = [];
    const params = [];

    if (body.status !== undefined) {
      if (!VALID_STATUS.includes(body.status)) {
        reply.code(400);
        return { error: 'invalid status' };
      }
      fields.push('status = ?');
      params.push(body.status);
    }
    if (body.rating !== undefined) {
      let rating = body.rating;
      if (rating === 0 || rating === null || rating === '') rating = null;
      if (rating !== null && (rating < 1 || rating > 5)) {
        reply.code(400);
        return { error: 'rating must be 1-5 or null' };
      }
      fields.push('rating = ?');
      params.push(rating);
    }
    if (body.notes !== undefined) {
      fields.push('notes = ?');
      params.push(body.notes);
    }
    if (body.favorite !== undefined) {
      fields.push('favorite = ?');
      params.push(body.favorite ? 1 : 0);
    }
    if (body.owned !== undefined) {
      fields.push('owned = ?');
      params.push(body.owned ? 1 : 0);
    }
    // Watched-in-cinema flag (movies only) — same toggle pattern as `owned`.
    if (body.watched_in_cinema !== undefined) {
      fields.push('watched_in_cinema = ?');
      params.push(body.watched_in_cinema ? 1 : 0);
    }
    if (body.rewatch_count !== undefined) {
      let rc = parseInt(body.rewatch_count, 10);
      if (!Number.isFinite(rc) || rc < 0) rc = 0;
      fields.push('rewatch_count = ?');
      params.push(rc);
    }

    if (!fields.length) return { ok: true };

    // Bump updated_at only for changes that reflect activity — a favourite
    // toggle must not move a movie's "watched on" date.
    if (body.status !== undefined || body.rating !== undefined || body.notes !== undefined) {
      fields.push("updated_at = datetime('now')");
    }

    const apply = db.transaction(() => {
      db.prepare(`UPDATE items SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(
        ...params,
        row.id,
        row.user_id
      );
      // Movie completion state / rewatch count affect the stats cache.
      if (row.type === 'movie' && (body.status !== undefined || body.rewatch_count !== undefined)) {
        scheduleStatsRecompute(db);
      }
    });
    apply();

    return { ok: true };
  });

  // PATCH /api/media/:id/watch-date  { date: 'YYYY-MM-DD' }  (movies only)
  // Edits the first-watch date retroactively so the title lands in the right
  // monthly receipt. Stored in items.watch_date, independent of updated_at.
  fastify.patch('/api/media/:id/watch-date', async (request, reply) => {
    const row = getItemByIdStmt.get(request.params.id, request.user.id);
    if (!row || row.type !== 'movie') {
      reply.code(404);
      return { error: 'not found' };
    }
    const date = validDate((request.body || {}).date);
    if (!date) {
      reply.code(400);
      return { error: 'date must be YYYY-MM-DD' };
    }
    setWatchDateStmt.run(date, row.id);
    scheduleStatsRecompute(db);
    return { ok: true, watch_date: date };
  });

  // POST /api/media/:id/rewatch  { date: 'YYYY-MM-DD' }  (movies only)
  // Adds one rewatch event AND increments rewatch_count in a single transaction
  // so the counter and the dated rows never diverge. Returns the new count.
  fastify.post('/api/media/:id/rewatch', async (request, reply) => {
    const row = getItemByIdStmt.get(request.params.id, request.user.id);
    if (!row || row.type !== 'movie') {
      reply.code(404);
      return { error: 'not found' };
    }
    const date = validDate((request.body || {}).date);
    if (!date) {
      reply.code(400);
      return { error: 'date must be YYYY-MM-DD' };
    }
    const add = db.transaction(() => {
      const info = insertRewatchStmt.run(row.id, date, Date.now());
      incRewatchCountStmt.run(row.id);
      scheduleStatsRecompute(db);
      return info.lastInsertRowid;
    });
    const rewatchId = add();
    const updated = getItemByIdStmt.get(row.id, row.user_id);
    reply.code(201);
    return { rewatch_id: rewatchId, rewatch_count: updated.rewatch_count };
  });

  // DELETE /api/media/:id/rewatch/:rewatchId  (movies only)
  // Removes one rewatch event AND decrements rewatch_count in the same
  // transaction. Returns the new count.
  fastify.delete('/api/media/:id/rewatch/:rewatchId', async (request, reply) => {
    const row = getItemByIdStmt.get(request.params.id, request.user.id);
    if (!row || row.type !== 'movie') {
      reply.code(404);
      return { error: 'not found' };
    }
    const remove = db.transaction(() => {
      const res = deleteRewatchStmt.run(request.params.rewatchId, row.id);
      if (res.changes) {
        decRewatchCountStmt.run(row.id);
        scheduleStatsRecompute(db);
      }
      return res.changes;
    });
    const changed = remove();
    const updated = getItemByIdStmt.get(row.id, row.user_id);
    return { ok: changed > 0, rewatch_count: updated.rewatch_count };
  });

  // GET /api/media/:id/rewatches  → dated rewatch events, newest first.
  fastify.get('/api/media/:id/rewatches', async (request, reply) => {
    const row = getItemByIdStmt.get(request.params.id, request.user.id);
    if (!row) {
      reply.code(404);
      return { error: 'not found' };
    }
    return {
      rewatches: listRewatchesStmt.all(row.id).map((r) => ({ id: r.id, date: r.watched_at })),
    };
  });

  // DELETE /api/media/:id  → remove item + progress, prune it from the member's
  // lists, and reclaim its on-disk cache once no member has the title any more.
  fastify.delete('/api/media/:id', async (request, reply) => {
    const row = getItemByIdStmt.get(request.params.id, request.user.id);
    if (!row) {
      reply.code(404);
      return { error: 'not found' };
    }
    const stillHeld = db.transaction(() => {
      deleteItemStmt.run(row.id, row.user_id); // progress cascades
      deleteItemListRefsStmt.run(Number(row.tmdb_id), row.user_id, row.type);
      scheduleStatsRecompute(db);
      return !!titleHeldStmt.get(row.type, row.tmdb_id);
    })();
    if (stillHeld) return { ok: true };
    // Filesystem cleanup outside the transaction (fs is not transactional).
    try {
      clearItemCache(row.type, row.tmdb_id);
    } catch (err) {
      fastify.log.warn(`cache cleanup failed for ${row.type} ${row.tmdb_id}: ${err.message}`);
    }
    return { ok: true };
  });
}
