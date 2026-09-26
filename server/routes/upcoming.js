// Upcoming timeline: GET /api/upcoming returns a merged feed for watching series
// — Watch Next (each series' next aired-but-unwatched episode), Coming Soon
// (episodes airing in the next 7 days), and On the Horizon (next episode to
// air). The season-file scan is memoized; the progress overlay is per-request.

import db from '../db.js';
import { readMetaSync, readSeasonMetaSync } from '../cache.js';

// Return YYYY-MM-DD for `offset` days from today (local date).
function dayStr(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

// The next episode to propose when a series has no unwatched aired episodes but is
// still being watched/rewatched. Scoped by the series' `current_season` (updated on
// every mark/rewatch). Within that season the rewatch position is the frontier by
// watch_count — the LAST episode (highest episode number) at the season's maximum
// watch_count, i.e. the episode the user most recently (re)watched — and we return
// the one immediately following it in broadcast order (next episode in the same
// season, or episode 1 of the next season). So rewatching S11E1 of a fully-watched
// S11 (its count → 2) proposes S11E2, not S12E1. Returns null when current_season
// is unset, has no watched episode, or there's no following episode in local data.
function currentSeasonNext(orderedEps, counts, currentSeason) {
  if (currentSeason == null) return null;
  let maxCount = 0;
  for (const e of orderedEps) {
    if (e.season !== currentSeason) continue;
    const c = counts.get(`${e.season}:${e.episode}`) || 0;
    if (c > maxCount) maxCount = c;
  }
  if (maxCount <= 0) return null; // nothing watched in that season
  let frontierIdx = -1; // index of the last episode at maxCount within the season
  for (let i = 0; i < orderedEps.length; i++) {
    const e = orderedEps[i];
    if (e.season === currentSeason && (counts.get(`${e.season}:${e.episode}`) || 0) === maxCount) {
      frontierIdx = i;
    }
  }
  if (frontierIdx < 0 || frontierIdx + 1 >= orderedEps.length) return null; // last in local data
  return orderedEps[frontierIdx + 1];
}

// Short-lived memo of the EXPENSIVE part: walking every watching show's cached
// season files (O(shows×seasons×episodes) synchronous disk reads). Air dates and
// library membership change slowly, so brief staleness is fine. The cheap,
// progress-dependent part (Watch Next / suppression) is recomputed on every
// request from the DB so it always reflects the latest watched state.
const MEMO_TTL_MS = 5 * 60 * 1000;
let memo = null; // { day, at, upcoming, shows: [{ id, tmdb_id, title, orderedEps }] }

// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
const watchingShowsStmt = db.prepare(
  "SELECT * FROM items WHERE type = 'show' AND status = 'watching'"
);
const watchingShowIdsStmt = db.prepare(
  "SELECT id, current_season FROM items WHERE type = 'show' AND status = 'watching'"
);
const progressOverlayStmt = db.prepare(
  'SELECT item_id, season, episode, watched_at, watch_count FROM progress WHERE season > 0'
);

// One pass over the cached season files producing (a) the coming-soon air-date
// window — logic UNCHANGED from the original endpoint — and (b) per-show ordered
// episode lists that the fresh progress overlay turns into Watch Next entries.
function buildScan(today, end) {
  const shows = watchingShowsStmt.all();

  const upcoming = [];
  const scanned = [];
  for (const show of shows) {
    const meta = readMetaSync('show', show.tmdb_id);
    if (!meta) continue;
    const orderedEps = [];
    for (const s of meta.seasons || []) {
      const sMeta = readSeasonMetaSync(show.tmdb_id, s.season_number);
      if (!sMeta) continue; // future season not cached → skip
      for (const ep of sMeta.episodes) {
        // --- Coming Soon: episodes airing within the next 7 days (unchanged) ---
        if (ep.air_date && ep.air_date >= today && ep.air_date <= end) {
          upcoming.push({
            item_id: show.id,
            tmdb_id: show.tmdb_id,
            series_title: show.title_it,
            season: s.season_number,
            episode: ep.episode_number,
            episode_title: ep.name,
            air_date: ep.air_date,
            poster_url: `/assets/shows/${show.tmdb_id}/poster.webp`,
            backdrop_url: `/assets/shows/${show.tmdb_id}/backdrop.webp`,
          });
        }
        // --- Watch Next source: real seasons (skip specials, season 0) ---
        if (s.season_number >= 1) {
          orderedEps.push({
            season: s.season_number,
            episode: ep.episode_number,
            air_date: ep.air_date || null,
            name: ep.name || '',
            still_path: ep.still_path || null,
          });
        }
      }
    }
    orderedEps.sort((a, b) =>
      a.season !== b.season ? a.season - b.season : a.episode - b.episode
    );
    scanned.push({
      id: show.id,
      tmdb_id: show.tmdb_id,
      title: show.title_it,
      orderedEps,
    });
  }

  upcoming.sort((a, b) => {
    if (a.air_date !== b.air_date) return a.air_date < b.air_date ? -1 : 1;
    if (a.season !== b.season) return a.season - b.season;
    return a.episode - b.episode;
  });

  return { upcoming, shows: scanned };
}

export default async function upcomingRoutes(fastify) {
  // GET /api/upcoming → a merged feed for the Upcoming timeline:
  //   • watch_next : the next unwatched, already-aired episode of each started
  //                  series, ordered by how recently the user last watched it.
  //   • upcoming   : episodes airing in the next 7 days (Coming Soon), with any
  //                  series that already has a Watch Next entry suppressed.
  fastify.get('/api/upcoming', async () => {
    const today = dayStr(0);
    const end = dayStr(7);

    if (!memo || memo.day !== today || Date.now() - memo.at >= MEMO_TTL_MS) {
      memo = { day: today, at: Date.now(), ...buildScan(today, end) };
    }

    // Fresh progress overlay (cheap, single indexed query): per show, the set of
    // watched episodes and the most recent watched_at (the "left off" moment).
    const rows = progressOverlayStmt.all();
    const byItem = new Map();
    for (const r of rows) {
      let e = byItem.get(r.item_id);
      if (!e) {
        e = { watched: new Set(), last: null, counts: new Map() };
        byItem.set(r.item_id, e);
      }
      e.watched.add(`${r.season}:${r.episode}`);
      // Per-episode watch_count locates the rewatch frontier within current_season.
      e.counts.set(`${r.season}:${r.episode}`, r.watch_count || 1);
      if (r.watched_at && (!e.last || r.watched_at > e.last)) e.last = r.watched_at;
    }

    // Current watching membership + each show's current_season (fresh, cheap): the
    // memo above is cached for a few minutes, so a series just moved OUT of
    // 'watching' — or whose current_season just changed on a mark — would otherwise
    // be stale until it expires. Reading these live keeps both immediate.
    const watchingRows = watchingShowIdsStmt.all();
    const watchingIds = new Set(watchingRows.map((r) => r.id));
    const currentSeasonById = new Map(watchingRows.map((r) => [r.id, r.current_season]));

    const watch_next = [];
    for (const show of memo.shows) {
      if (!watchingIds.has(show.id)) continue; // no longer watching → drop instantly
      const prog = byItem.get(show.id);
      if (!prog || prog.watched.size === 0) continue; // not started → skip

      // Case 1 (unchanged): the earliest unwatched episode that has already aired.
      let next = null;
      for (const ep of show.orderedEps) {
        if (prog.watched.has(`${ep.season}:${ep.episode}`)) continue;
        if (!ep.air_date || ep.air_date > today) continue; // not yet available
        next = ep;
        break;
      }

      // Case 2 (rewatch): no unwatched aired episode remains, but the series is
      // still 'watching'. Resolve from current_season — the most recently watched
      // episode within that season, then the one immediately following it — so a
      // series the user is rewatching stays visible instead of vanishing.
      // Case 3 (edge): currentSeasonNext returns null when there's no following
      // episode in the local data — fall through to the drop below.
      if (!next) {
        const cand = currentSeasonNext(show.orderedEps, prog.counts, currentSeasonById.get(show.id));
        // Keep Watch Next to episodes you can actually watch now: a rewatch target
        // (already watched → definitely aired) or any episode that has aired. A
        // future successor (a caught-up series awaiting its next season) is left to
        // On the Horizon rather than proposed here.
        if (cand) {
          const alreadyWatched = prog.watched.has(`${cand.season}:${cand.episode}`);
          const aired = cand.air_date && cand.air_date <= today;
          if (alreadyWatched || aired) next = cand;
        }
      }

      if (!next) continue; // nothing to watch or rewatch next → drop the series

      // Progress through the current (next episode's) season.
      const seasonEps = show.orderedEps.filter((e) => e.season === next.season);
      const season_total = seasonEps.length;
      const season_watched = seasonEps.reduce(
        (n, e) => n + (prog.watched.has(`${e.season}:${e.episode}`) ? 1 : 0),
        0
      );

      watch_next.push({
        item_id: show.id,
        tmdb_id: show.tmdb_id,
        series_title: show.title,
        season: next.season,
        episode: next.episode,
        episode_title: next.name || null,
        still_url: next.still_path
          ? `/assets/shows/${show.tmdb_id}/seasons/s${next.season}/ep${next.episode}.webp`
          : null,
        poster_url: `/assets/shows/${show.tmdb_id}/poster.webp`,
        backdrop_url: `/assets/shows/${show.tmdb_id}/backdrop.webp`,
        last_watched_at: prog.last,
        season_watched,
        season_total,
      });
    }

    // Left off most recently → top.
    watch_next.sort((a, b) =>
      (b.last_watched_at || '').localeCompare(a.last_watched_at || '')
    );

    // Suppress Coming Soon for any series already surfaced as Watch Next, and for
    // any series no longer watching (same live-membership check as above).
    const nextIds = new Set(watch_next.map((w) => w.item_id));
    const upcoming = memo.upcoming.filter(
      (e) => !nextIds.has(e.item_id) && watchingIds.has(e.item_id)
    );

    // "On the Horizon" railway: each watching series' NEXT episode to air (the
    // earliest episode with a FUTURE air date), derived entirely from the cached
    // season data — no new TMDB calls. Ordered soonest-first. Series with no known
    // future episode (ended, or next season not cached yet) are simply omitted.
    const horizon = [];
    for (const show of memo.shows) {
      if (!watchingIds.has(show.id)) continue;
      let air = null;
      for (const ep of show.orderedEps) {
        // orderedEps is in season/episode order, i.e. broadcast order, so the
        // first one dated in the future is the next episode to air.
        if (ep.air_date && ep.air_date > today) {
          air = ep;
          break;
        }
      }
      if (!air) continue;
      horizon.push({
        item_id: show.id,
        tmdb_id: show.tmdb_id,
        series_title: show.title,
        season: air.season,
        episode: air.episode,
        air_date: air.air_date,
        poster_url: `/assets/shows/${show.tmdb_id}/poster.webp`,
      });
    }
    horizon.sort((a, b) => (a.air_date < b.air_date ? -1 : a.air_date > b.air_date ? 1 : 0));

    return { upcoming, watch_next, horizon };
  });
}
