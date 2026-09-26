import db from './db.js';
import { readMeta, readSeasonMeta } from './cache.js';

const DEFAULT_EPISODE_MINUTES = 30;

// Prepared once at module load, bound to the single shared connection. The
// functions below still accept a `db` argument for their existing call sites;
// it is always this same singleton, so the module-level statements are used.
const selItemsStmt = db.prepare(
  'SELECT id, tmdb_id, type, status, rewatch_count FROM items'
);
const selProgressStmt = db.prepare(
  'SELECT season, episode, watch_count FROM progress WHERE item_id = ? AND season > 0'
);
const upsertSummaryStmt = db.prepare(
  `INSERT INTO stats_cache (key, value, updated_at)
   VALUES ('summary', ?, datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
);
const selSummaryStmt = db.prepare("SELECT value FROM stats_cache WHERE key = 'summary'");

// Full recompute of the statistics summary from the database + cached meta.
// Writes the result into stats_cache under the single key 'summary' and
// returns it.
//
// ASYNC ON PURPOSE: this reads one meta file per item plus one per watched
// season (hundreds of files on a real library). Done synchronously it blocked the
// event loop for seconds after every write — long enough for the client's health
// probe to time out and declare the server offline. Awaiting each read yields
// between files, so every other request (the probe included) is still answered
// while this runs. Reads are served from cache.js's parsed-meta cache, so after
// the first pass it costs almost nothing.
export async function recomputeStats(db) {
  const items = selItemsStmt.all();

  let totalMinutesMovies = 0;
  let totalMoviesCompleted = 0;
  let totalMinutesShows = 0;
  let totalEpisodesWatched = 0;
  let isEstimated = false;

  const progressStmt = selProgressStmt;

  for (const item of items) {
    if (item.type === 'movie') {
      if (item.status === 'completed') {
        totalMoviesCompleted += 1;
        const meta = await readMeta('movie', item.tmdb_id);
        // Count rewatches too (watched N times = N × runtime), matching shows.
        if (meta && meta.runtime) {
          totalMinutesMovies += meta.runtime * (1 + (item.rewatch_count || 0));
        }
      }
      continue;
    }

    // Show: sum runtime across every watched episode (rewatches included).
    const showMeta = await readMeta('show', item.tmdb_id);
    const seriesRun =
      showMeta &&
      Array.isArray(showMeta.episode_run_time) &&
      showMeta.episode_run_time.length
        ? showMeta.episode_run_time[0]
        : null;

    const seasonRuntimeCache = {}; // season -> { episodeNumber: runtime }
    const rows = progressStmt.all(item.id);
    for (const row of rows) {
      totalEpisodesWatched += 1;

      if (!seasonRuntimeCache[row.season]) {
        const sm = await readSeasonMeta(item.tmdb_id, row.season);
        const map = {};
        if (sm) {
          for (const ep of sm.episodes) map[ep.episode_number] = ep.runtime;
        }
        seasonRuntimeCache[row.season] = map;
      }

      const epRun = seasonRuntimeCache[row.season][row.episode];
      let minutes;
      if (epRun) {
        minutes = epRun;
      } else if (seriesRun) {
        minutes = seriesRun;
      } else {
        minutes = DEFAULT_EPISODE_MINUTES;
        isEstimated = true;
      }
      totalMinutesShows += minutes * (row.watch_count || 1);
    }
  }

  const summary = {
    total_minutes_movies: totalMinutesMovies,
    total_minutes_shows: totalMinutesShows,
    total_movies_completed: totalMoviesCompleted,
    total_episodes_watched: totalEpisodesWatched,
    is_estimated: isEstimated,
    updated_at: new Date().toISOString(),
  };

  upsertSummaryStmt.run(JSON.stringify(summary));

  return summary;
}

// Coalesced, off-transaction recompute. Callers in request handlers use this
// instead of awaiting the full recompute, so a single mutation doesn't pay an
// O(library) scan. Multiple mutations in quick succession collapse into one.
// Fire-and-forget: the recompute now yields between files, so it no longer
// stalls the requests that follow the write.
let statsTimer = null;
let statsDb = null;
export function scheduleStatsRecompute(db) {
  statsDb = db;
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    // Never rejects into the timer (there is nothing to catch it there):
    // on failure keep the previous summary — the next mutation or getStats() retries.
    recomputeStats(statsDb).catch(() => {});
  }, 150);
  if (statsTimer.unref) statsTimer.unref();
}

// Read the cached summary; recompute once if it has never been built.
export async function getStats(db) {
  const row = selSummaryStmt.get();
  if (row) {
    try {
      return JSON.parse(row.value);
    } catch {
      /* fall through to recompute */
    }
  }
  return recomputeStats(db);
}
