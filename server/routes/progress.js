// Episode-progress endpoints under /api/progress (plus /api/media/:id/progress):
// mark episodes and whole seasons watched, catch up skipped episodes, record
// rewatches, edit per-episode notes, and unwatch. Responses flag skipped-episode
// gaps and whether a show is now fully caught up (for the client's confetti).

import db from '../db.js';
import { readMetaSync, readSeasonMetaSync } from '../cache.js';
import { scheduleStatsRecompute } from '../stats.js';

// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
// Bound to the signed-in member: every handler loads the series through this
// first, so progress rows are only ever touched for a series the caller owns.
const getItemStmt = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?');
const watchedKeysStmt = db.prepare(
  'SELECT season, episode FROM progress WHERE item_id = ? AND season > 0'
);
const listProgressStmt = db.prepare(
  'SELECT season, episode, watch_count, watched_at, notes FROM progress WHERE item_id = ? AND season > 0 ORDER BY season, episode'
);
const insertWatchedStmt = db.prepare(
  `INSERT INTO progress (item_id, season, episode, watch_count, notes)
   VALUES (?, ?, ?, 1, ?)
   ON CONFLICT(item_id, season, episode) DO NOTHING`
);
const insertWatchedNoNotesStmt = db.prepare(
  `INSERT INTO progress (item_id, season, episode, watch_count)
   VALUES (?, ?, ?, 1)
   ON CONFLICT(item_id, season, episode) DO NOTHING`
);
const getWatchCountStmt = db.prepare(
  'SELECT watch_count FROM progress WHERE item_id = ? AND season = ? AND episode = ?'
);
// A rewatch re-dates the row: watched_at is the episode's latest viewing, which the
// monthly receipt and Up Next's "left off" ordering both read.
const incrementWatchCountStmt = db.prepare(
  `UPDATE progress SET watch_count = watch_count + 1, watched_at = datetime('now')
    WHERE item_id = ? AND season = ? AND episode = ?`
);
// Raising the count is a rewatch (re-dated); lowering it only corrects the count
// and keeps the original date.
const setWatchCountStmt = db.prepare(
  `UPDATE progress
      SET watched_at = CASE WHEN ? > watch_count THEN datetime('now') ELSE watched_at END,
          watch_count = ?
    WHERE item_id = ? AND season = ? AND episode = ?`
);
const insertWatchCountStmt = db.prepare(
  `INSERT INTO progress (item_id, season, episode, watch_count)
   VALUES (?, ?, ?, ?)`
);
const insertRewatchStmt = db.prepare(
  `INSERT INTO progress (item_id, season, episode, watch_count)
   VALUES (?, ?, ?, 1)`
);
const deleteEpisodeStmt = db.prepare(
  'DELETE FROM progress WHERE item_id = ? AND season = ? AND episode = ?'
);
const getProgressIdStmt = db.prepare(
  'SELECT id FROM progress WHERE item_id = ? AND season = ? AND episode = ?'
);
const insertNoteRowStmt = db.prepare(
  `INSERT INTO progress (item_id, season, episode, watch_count, notes)
   VALUES (?, ?, ?, 1, ?)`
);
const updateNoteStmt = db.prepare(
  'UPDATE progress SET notes = ? WHERE item_id = ? AND season = ? AND episode = ?'
);
const deleteSeasonStmt = db.prepare(
  'DELETE FROM progress WHERE item_id = ? AND season = ?'
);
// Track the season the user is currently working through, updated on every mark /
// rewatch. What's Next uses it to resolve the next episode (see upcoming.js).
const setCurrentSeasonStmt = db.prepare(
  'UPDATE items SET current_season = ? WHERE id = ?'
);

function getItem(id, userId) {
  return getItemStmt.get(id, userId);
}

// Per-request memo for the cached-meta disk reads. isCaughtUp() and
// previousGap()/orderedEpisodes() each walk every season's cached meta from
// disk; without memoization a single write reads the same JSON files two or
// more times on the event loop before the response is sent. One cache per
// request collapses those to a single read each — the main synchronous cost on
// the write path. Pass the SAME cache to every helper a handler calls.
function makeMetaCache() {
  const shows = new Map(); // tmdb_id -> meta|null
  const seasons = new Map(); // `${tmdb_id}:${season}` -> meta|null
  return {
    show(tmdbId) {
      if (!shows.has(tmdbId)) shows.set(tmdbId, readMetaSync('show', tmdbId));
      return shows.get(tmdbId);
    },
    season(tmdbId, s) {
      const key = `${tmdbId}:${s}`;
      if (!seasons.has(key)) seasons.set(key, readSeasonMetaSync(tmdbId, s));
      return seasons.get(key);
    },
  };
}

// True when a show is fully "caught up": it has at least one aired episode
// (air_date on or before today, season >= 1) and every aired episode is watched.
// Reuses the locally-cached TMDB air dates. The client uses this to fire the
// completion confetti only when the LAST available episode was just marked.
function isCaughtUp(item, cache = makeMetaCache()) {
  if (!item || item.type !== 'show') return false;
  const meta = cache.show(item.tmdb_id);
  if (!meta) return false;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD → lexical compare
  const aired = [];
  for (const s of meta.seasons || []) {
    if (s.season_number < 1) continue;
    const sMeta = cache.season(item.tmdb_id, s.season_number);
    if (!sMeta) continue;
    for (const ep of sMeta.episodes) {
      if (ep.air_date && ep.air_date <= today) {
        aired.push(`${s.season_number}:${ep.episode_number}`);
      }
    }
  }
  if (!aired.length) return false;
  const watched = new Set(
    watchedKeysStmt.all(item.id).map((r) => `${r.season}:${r.episode}`)
  );
  return aired.every((k) => watched.has(k));
}

// Terminal TMDB series statuses: the show will get no further episodes, so
// having watched every aired one means the series is finished for good. A
// returning series you have merely caught up on is NOT ended.
const ENDED_STATUSES = new Set(['Ended', 'Canceled', 'Cancelled']);
function finishInfo(item, cache) {
  const meta = cache.show(item.tmdb_id);
  return {
    series_ended: !!(meta && ENDED_STATUSES.has(meta.status)),
    item_status: item.status,
    title: item.title_it || item.title_orig || '',
  };
}

// Ordered list of a show's real episodes (season ≥ 1) across all seasons.
function orderedEpisodes(item, cache = makeMetaCache()) {
  const meta = cache.show(item.tmdb_id);
  if (!meta) return [];
  const seasons = (meta.seasons || [])
    .filter((s) => s.season_number >= 1)
    .sort((a, b) => a.season_number - b.season_number);
  const list = [];
  for (const s of seasons) {
    const sMeta = cache.season(item.tmdb_id, s.season_number);
    const nums = sMeta
      ? sMeta.episodes.map((e) => e.episode_number)
      : Array.from({ length: s.episode_count || 0 }, (_, i) => i + 1);
    nums.sort((a, b) => a - b);
    for (const ep of nums) list.push({ season: s.season_number, episode: ep });
  }
  return list;
}

// The "gap": unseen episodes airing before (season, episode) but after the most
// recently watched episode before it — i.e. what the user skipped to reach this
// one. Empty when watching in order, or when this is the first episode.
function previousGap(item, season, episode, cache = makeMetaCache()) {
  const ordered = orderedEpisodes(item, cache);
  const idx = ordered.findIndex((e) => e.season === season && e.episode === episode);
  if (idx <= 0) return [];
  const watched = new Set(
    watchedKeysStmt.all(item.id).map((r) => `${r.season}:${r.episode}`)
  );
  let lastSeen = -1;
  for (let i = idx - 1; i >= 0; i--) {
    if (watched.has(`${ordered[i].season}:${ordered[i].episode}`)) {
      lastSeen = i;
      break;
    }
  }
  const gap = [];
  for (let i = lastSeen + 1; i < idx; i++) {
    const e = ordered[i];
    if (!watched.has(`${e.season}:${e.episode}`)) gap.push(e);
  }
  return gap;
}

export default async function progressRoutes(fastify) {
  // GET /api/media/:id/progress → all watched episodes with watch_count.
  fastify.get('/api/media/:id/progress', async (request, reply) => {
    const item = getItem(request.params.id, request.user.id);
    if (!item) {
      reply.code(404);
      return { error: 'not found' };
    }
    const rows = listProgressStmt.all(item.id);
    return { progress: rows };
  });

  // POST /api/progress → mark an episode watched (first view, watch_count=1).
  fastify.post('/api/progress', async (request, reply) => {
    const { item_id, season, episode, notes } = request.body || {};
    if (!item_id || season == null || episode == null) {
      reply.code(400);
      return { error: 'item_id, season, episode are required' };
    }
    if (season < 1) {
      reply.code(400);
      return { error: 'specials (season 0) are not tracked' };
    }
    const item = getItem(item_id, request.user.id);
    if (!item) {
      reply.code(404);
      return { error: 'item not found' };
    }
    const apply = db.transaction(() => {
      insertWatchedStmt.run(item_id, season, episode, notes ?? null);
      setCurrentSeasonStmt.run(season, item_id);
      scheduleStatsRecompute(db);
    });
    apply();
    const rowNow = getWatchCountStmt.get(item_id, season, episode);
    // Report any earlier unseen episodes the user skipped, so the client can
    // offer to mark them watched too. previousGap + isCaughtUp both scan the
    // series' cached season meta from disk — share one memo so each file is read
    // once, not twice, per request.
    const metaCache = makeMetaCache();
    let previous_unseen = [];
    try {
      previous_unseen = previousGap(item, Number(season), Number(episode), metaCache);
    } catch {
      /* non-fatal — just skip the catch-up prompt */
    }
    return {
      ok: true,
      watch_count: rowNow ? rowNow.watch_count : 1,
      previous_unseen,
      caught_up: isCaughtUp(item, metaCache), // → client confetti when the last aired ep lands
      ...finishInfo(item, metaCache),
    };
  });

  // POST /api/progress/catchup → mark every unseen episode airing before
  // (season, episode) up to the previously-watched one. Server-computed and
  // idempotent (ON CONFLICT DO NOTHING), so it's safe to call repeatedly.
  fastify.post('/api/progress/catchup', async (request, reply) => {
    const { item_id, season, episode } = request.body || {};
    if (!item_id || season == null || episode == null) {
      reply.code(400);
      return { error: 'item_id, season, episode are required' };
    }
    const item = getItem(item_id, request.user.id);
    if (!item || item.type !== 'show') {
      reply.code(404);
      return { error: 'show not found' };
    }
    const metaCache = makeMetaCache();
    const gap = previousGap(item, Number(season), Number(episode), metaCache);
    const apply = db.transaction(() => {
      for (const e of gap) insertWatchedNoNotesStmt.run(item_id, e.season, e.episode);
      setCurrentSeasonStmt.run(Number(season), item_id);
      scheduleStatsRecompute(db);
    });
    apply();
    // `marked_episodes` lets the client update just those rows in place instead
    // of re-fetching the whole season (purely additive to the response).
    return {
      ok: true,
      marked: gap.length,
      marked_episodes: gap,
      caught_up: isCaughtUp(item, metaCache),
      ...finishInfo(item, metaCache),
    };
  });

  // POST /api/progress/rewatch → increment watch_count for an episode.
  fastify.post('/api/progress/rewatch', async (request, reply) => {
    const { item_id, season, episode } = request.body || {};
    if (!item_id || season == null || episode == null) {
      reply.code(400);
      return { error: 'item_id, season, episode are required' };
    }
    const item = getItem(item_id, request.user.id);
    if (!item) {
      reply.code(404);
      return { error: 'item not found' };
    }
    const apply = db.transaction(() => {
      const existing = getWatchCountStmt.get(item_id, season, episode);
      if (existing) {
        incrementWatchCountStmt.run(item_id, season, episode);
      } else {
        insertRewatchStmt.run(item_id, season, episode);
      }
      setCurrentSeasonStmt.run(season, item_id);
      scheduleStatsRecompute(db);
    });
    apply();
    const rowNow = getWatchCountStmt.get(item_id, season, episode);
    return { ok: true, watch_count: rowNow ? rowNow.watch_count : 1 };
  });

  // POST /api/progress/set-count → set an episode's watch_count to an absolute
  // value in one call (the episode-count stepper commits its final number here).
  // A count of 0 (or less) removes the episode entirely (fully unwatched). Returns
  // the resulting watch_count (0 = removed) so the client can update the row.
  fastify.post('/api/progress/set-count', async (request, reply) => {
    const { item_id, season, episode, watch_count } = request.body || {};
    if (!item_id || season == null || episode == null || watch_count == null) {
      reply.code(400);
      return { error: 'item_id, season, episode, watch_count are required' };
    }
    const n = parseInt(watch_count, 10);
    if (!Number.isInteger(n) || n < 0) {
      reply.code(400);
      return { error: 'watch_count must be a non-negative integer' };
    }
    const item = getItem(item_id, request.user.id);
    if (!item) {
      reply.code(404);
      return { error: 'item not found' };
    }
    let result = 0;
    const apply = db.transaction(() => {
      if (n <= 0) {
        deleteEpisodeStmt.run(item_id, season, episode); // count 0 → fully unwatch
        result = 0;
      } else if (getWatchCountStmt.get(item_id, season, episode)) {
        setWatchCountStmt.run(n, n, item_id, season, episode);
        result = n;
      } else {
        insertWatchCountStmt.run(item_id, season, episode, n);
        result = n;
      }
      if (n > 0) setCurrentSeasonStmt.run(season, item_id); // watched/rewatched
      scheduleStatsRecompute(db);
    });
    apply();
    return { ok: true, watch_count: result };
  });

  // DELETE /api/progress/:item_id/:season/:episode → fully unwatch.
  fastify.delete(
    '/api/progress/:item_id/:season/:episode',
    async (request, reply) => {
      const { item_id, season, episode } = request.params;
      if (!getItem(item_id, request.user.id)) {
        reply.code(404);
        return { error: 'item not found' };
      }
      const apply = db.transaction(() => {
        deleteEpisodeStmt.run(item_id, season, episode);
        scheduleStatsRecompute(db);
      });
      apply();
      return { ok: true };
    }
  );

  // PATCH /api/progress/:item_id/:season/:episode → update episode notes.
  fastify.patch(
    '/api/progress/:item_id/:season/:episode',
    async (request, reply) => {
      const { item_id, season, episode } = request.params;
      const { notes } = request.body || {};
      if (!getItem(item_id, request.user.id)) {
        reply.code(404);
        return { error: 'item not found' };
      }
      const existing = getProgressIdStmt.get(item_id, season, episode);
      if (!existing) {
        // Allow attaching a note by creating the watched record.
        insertNoteRowStmt.run(item_id, season, episode, notes ?? null);
        return { ok: true, created: true };
      }
      updateNoteStmt.run(notes ?? null, item_id, season, episode);
      return { ok: true };
    }
  );

  // POST /api/progress/season → mark an entire season watched (only the
  // episodes not already watched; existing watch_counts are left untouched).
  fastify.post('/api/progress/season', async (request, reply) => {
    const { item_id, season } = request.body || {};
    if (!item_id || season == null) {
      reply.code(400);
      return { error: 'item_id and season are required' };
    }
    // Coerce + range-check before it reaches readSeasonMetaSync, which builds a
    // filesystem path (`.../seasons/s<season>`); a non-numeric season would be a
    // path-traversal primitive otherwise.
    const seasonNum = parseInt(season, 10);
    if (!Number.isInteger(seasonNum) || seasonNum < 1) {
      reply.code(400);
      return { error: 'invalid season' };
    }
    const item = getItem(item_id, request.user.id);
    if (!item) {
      reply.code(404);
      return { error: 'item not found' };
    }
    const metaCache = makeMetaCache();
    const sMeta = metaCache.season(item.tmdb_id, seasonNum);
    if (!sMeta) {
      reply.code(404);
      return { error: 'season metadata not cached' };
    }
    const apply = db.transaction(() => {
      for (const ep of sMeta.episodes) {
        insertWatchedNoNotesStmt.run(item_id, seasonNum, ep.episode_number);
      }
      setCurrentSeasonStmt.run(seasonNum, item_id);
      scheduleStatsRecompute(db);
    });
    apply();
    // isCaughtUp reuses the season meta already read above via the shared cache.
    return { ok: true, caught_up: isCaughtUp(item, metaCache), ...finishInfo(item, metaCache) };
  });

  // DELETE /api/progress/season → remove an entire season from watched.
  fastify.delete('/api/progress/season', async (request, reply) => {
    const { item_id, season } = request.body || {};
    if (!item_id || season == null) {
      reply.code(400);
      return { error: 'item_id and season are required' };
    }
    if (!getItem(item_id, request.user.id)) {
      reply.code(404);
      return { error: 'item not found' };
    }
    const apply = db.transaction(() => {
      deleteSeasonStmt.run(item_id, season);
      scheduleStatsRecompute(db);
    });
    apply();
    return { ok: true };
  });
}
