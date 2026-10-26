// Monthly "rental receipt" endpoint: GET /api/receipt builds the current month's
// summary — movies completed and series episodes watched this month, with runtime
// totals, top genre, and a deterministic membership number — styled as a
// video-store receipt. Posters are served only from the local cache.

import db from '../db.js';
import { readMetaSync, readSeasonMetaSync } from '../cache.js';
import { getStats } from '../stats.js';

const DEFAULT_EPISODE_MINUTES = 30;

// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
// First watches this month. The "watched on" date is the editable watch_date,
// falling back to updated_at when it was never set (pre-feature rows).
const monthMoviesStmt = db.prepare(
  `SELECT id, tmdb_id, type, title_it, genres
     FROM items
    WHERE user_id = ? AND type = 'movie' AND status = 'completed'
      AND substr(COALESCE(watch_date, updated_at), 1, 7) = ?
    ORDER BY COALESCE(watch_date, updated_at) DESC`
);
// Rewatch events this month — one dated row per rewatch, each its own line item.
const monthRewatchesStmt = db.prepare(
  `SELECT r.id, r.watched_at, i.tmdb_id, i.title_it, i.genres, i.type
     FROM movie_rewatches r JOIN items i ON i.id = r.item_id
    WHERE i.user_id = ? AND i.type = 'movie' AND substr(r.watched_at, 1, 7) = ?
    ORDER BY r.watched_at DESC, r.id DESC`
);
const monthEpisodesStmt = db.prepare(
  `SELECT p.item_id, p.season, p.episode, p.watch_count,
          i.tmdb_id, i.title_it, i.genres, i.type
     FROM progress p
     JOIN items i ON i.id = p.item_id
    WHERE i.user_id = ? AND i.type = 'show' AND p.season > 0 AND substr(p.watched_at, 1, 7) = ?`
);
const displayNameStmt = db.prepare('SELECT display_name FROM users WHERE id = ?');

const MONTHS = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
];

// Rotating closing lines — stable within a month so the receipt doesn't change
// between views.
const CLOSINGS = [
  'THANK YOU FOR YOUR RENTAL',
  'PLEASE REWIND BEFORE RETURNING',
  'BE KIND, PLEASE REWIND',
  'DROP IN THE NIGHT SLOT AFTER HOURS',
  'NO LATE FEES THIS MONTH. ENJOY!',
  'SEE YOU NEXT FRIDAY NIGHT',
];

// Current local month as YYYY-MM; watched_at / updated_at are compared by this
// 7-char prefix so both date-only and datetime values match without TZ math.
function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Validate/normalise a requested 'YYYY-MM'. Returns { key, year, monthIndex } or
// null when malformed, out of range, or in the future (a receipt only exists for
// a month that has already started). Zero-padded keys compare correctly as
// strings, so the future check needs no date math.
function parseMonthKey(value) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  if (year < 1900 || year > 2999) return null;
  const key = `${m[1]}-${m[2]}`;
  if (key > monthKey()) return null; // future month
  return { key, year, monthIndex };
}

// Primary genre name for an item: the denormalized items.genres column first
// (JSON array of names), falling back to the cached meta.
function primaryGenre(row) {
  let genres = [];
  if (row.genres) {
    try {
      genres = JSON.parse(row.genres);
    } catch {
      genres = [];
    }
  }
  if (!genres || !genres.length) {
    const meta = readMetaSync(row.type, row.tmdb_id);
    genres = (meta && meta.genres) || [];
  }
  return genres && genres.length ? genres[0] : null;
}

// Minutes for a single watched episode, mirroring stats.js: episode runtime →
// series average → a 30-minute default.
function episodeMinutes(tmdbId, season, episode, seriesRun, seasonCache) {
  if (!seasonCache[season]) {
    const sm = readSeasonMetaSync(tmdbId, season);
    const map = {};
    if (sm) for (const ep of sm.episodes) map[ep.episode_number] = ep.runtime;
    seasonCache[season] = map;
  }
  const epRun = seasonCache[season][episode];
  if (epRun) return epRun;
  if (seriesRun) return seriesRun;
  return DEFAULT_EPISODE_MINUTES;
}

// Build the whole monthly summary (this is the receipt's data model). Each title
// carries its cached poster so the card's background picker can offer exactly
// the titles shown on the receipt.
// `month` is a parseMonthKey() result; defaults to the current month. Every
// query below is driven by `key`, and the labels/closing line by year+monthIndex,
// so a past month builds exactly the receipt that month would have produced.
// `userId` is the signed-in member: the receipt lists their titles only, and
// their name gives the membership initials.
async function buildReceipt(month = parseMonthKey(monthKey()), userId) {
  const { key, year, monthIndex } = month;

  // Map a movie row (first watch or rewatch) to a receipt line item.
  const movieLine = (r, rewatch) => {
    const meta = readMetaSync('movie', r.tmdb_id);
    const minutes = meta && meta.runtime ? meta.runtime : 0;
    return {
      title: r.title_it,
      tmdb_id: r.tmdb_id,
      poster_url: `/assets/movies/${r.tmdb_id}/poster.webp`,
      genre: primaryGenre(r),
      minutes,
      rewatch,
      times: 1,
    };
  };

  // --- Movies this month: first watches + each dated rewatch as its own line ---
  const firstWatches = monthMoviesStmt.all(userId, key).map((r) => movieLine(r, false));
  const rewatches = monthRewatchesStmt.all(userId, key).map((r) => movieLine(r, true));
  const movies = [...firstWatches, ...rewatches];

  // --- Shows: episodes watched this month, grouped by series ---
  const epRows = monthEpisodesStmt.all(userId, key);

  const showMap = new Map();
  for (const r of epRows) {
    let s = showMap.get(r.item_id);
    if (!s) {
      const meta = readMetaSync('show', r.tmdb_id);
      const seriesRun =
        meta && Array.isArray(meta.episode_run_time) && meta.episode_run_time.length
          ? meta.episode_run_time[0]
          : null;
      s = {
        title: r.title_it,
        tmdb_id: r.tmdb_id,
        genre: primaryGenre(r),
        episodes: 0,
        minutes: 0,
        maxWatch: 1,
        seriesRun,
        seasonCache: {},
      };
      showMap.set(r.item_id, s);
    }
    s.episodes += 1;
    s.minutes += episodeMinutes(r.tmdb_id, r.season, r.episode, s.seriesRun, s.seasonCache);
    if ((r.watch_count || 1) > s.maxWatch) s.maxWatch = r.watch_count;
  }

  const shows = [...showMap.values()]
    .sort((a, b) => b.episodes - a.episodes)
    .map((s) => ({
      title: s.title,
      tmdb_id: s.tmdb_id,
      poster_url: `/assets/shows/${s.tmdb_id}/poster.webp`,
      genre: s.genre,
      episodes: s.episodes,
      minutes: s.minutes,
      rewatch: s.maxWatch > 1,
      times: s.maxWatch,
    }));

  // --- Totals ---
  const totalTitles = movies.length + shows.length;
  const totalMinutes =
    movies.reduce((n, m) => n + m.minutes, 0) + shows.reduce((n, s) => n + s.minutes, 0);
  const totalHours = Math.floor(totalMinutes / 60);

  const genreTally = new Map();
  for (const item of [...movies, ...shows]) {
    if (!item.genre) continue;
    genreTally.set(item.genre, (genreTally.get(item.genre) || 0) + 1);
  }
  let topGenre = null;
  let topCount = 0;
  for (const [g, c] of genreTally) {
    if (c > topCount) {
      topGenre = g;
      topCount = c;
    }
  }

  // Deterministic "membership number" from lifetime stats + display name, so it
  // feels personal and stays stable between views.
  const stats = await getStats(db, userId);
  const nameRow = displayNameStmt.get(userId);
  const initials =
    ((nameRow && nameRow.display_name) || 'SH')
      .replace(/[^A-Za-z]/g, '')
      .slice(0, 2)
      .toUpperCase() || 'SH';
  const base =
    (stats.total_episodes_watched || 0) * 31 +
    (stats.total_movies_completed || 0) * 137 +
    7;
  const memberNum = (base % 90000) + 10000; // always 5 digits
  const membership = `${initials.padEnd(2, 'X')}-${memberNum}`;

  return {
    store_name: 'shelfit',
    month_name: MONTHS[monthIndex],
    year,
    month_label: `*** ${MONTHS[monthIndex]} ${year} ***`,
    movies,
    shows,
    totals: {
      total_titles: totalTitles,
      total_minutes: totalMinutes,
      total_hours: totalHours,
      hours_label: `${String(totalHours).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')} HRS`,
      top_genre: topGenre ? topGenre.toUpperCase() : null,
      membership,
      // Whose receipt it is, printed on it: in a household several members share
      // the store. Capped so a long name can't break the receipt's line.
      member: ((nameRow && nameRow.display_name) || '').toUpperCase().slice(0, 18) || null,
      closing: CLOSINGS[monthIndex % CLOSINGS.length],
    },
  };
}

export default async function receiptRoutes(fastify) {
  // GET /api/receipt → a rental-receipt summary. Defaults to the current month;
  // `?month=YYYY-MM` builds that (past) month's receipt instead — 400 on a
  // malformed, out-of-range, or future month. Background poster choices are the
  // titles on the receipt itself (each carries its poster_url, served only from
  // the local cache).
  fastify.get('/api/receipt', async (request, reply) => {
    const requested = request.query.month;
    if (requested === undefined || requested === '') return buildReceipt(undefined, request.user.id);
    const month = parseMonthKey(requested);
    if (!month) {
      return reply.code(400).send({ error: 'Invalid month: expected a past YYYY-MM' });
    }
    return buildReceipt(month, request.user.id);
  });
}
