// Kodi library sync — discovers titles present in the active Kodi instance but
// not yet in shelfIt, and (silently) advances the watched status of titles that
// already exist. Additive only: nothing is ever deleted, no watched status is
// downgraded, and ratings / notes / rewatch counts / lists are never touched.
//
// New discoveries are NOT committed here — they are returned (manual sync) or
// stashed as "pending review" (scheduled sync) for the user to confirm in the
// review card. The commit step adds them with their reviewed statuses using the
// metadata already fetched during the sync.

import db from './db.js';
import { ensureCached, readMetaSync } from './cache.js';
import { resolveTmdb, advancedStatus } from './importKodi.js';
import { isEnabled, getActiveInstance, pingInstance, rpcActive } from './kodi.js';
import { scheduleStatsRecompute } from './stats.js';

const VALID_STATUS = ['watching', 'completed', 'paused', 'dropped', 'plan_to_watch'];

// The sync writes into ONE member's library: the sync owner (see syncOwnerId).
const findByTmdb = db.prepare(
  'SELECT id, type, status, tmdb_id FROM items WHERE user_id = ? AND type = ? AND tmdb_id = ?'
);
const findByTitle = db.prepare(
  'SELECT id, type, status, tmdb_id FROM items WHERE user_id = ? AND type = ? AND (title_it = ? OR title_orig = ?)'
);
// What Kodi last reported per title (a movie's play count, a series' watched
// episodes), so a sync acts on a new viewing only (migration 11).
const getMarkStmt = db.prepare('SELECT plays FROM kodi_marks WHERE item_id = ?');
const setMarkStmt = db.prepare(
  `INSERT INTO kodi_marks (item_id, plays) VALUES (?, ?)
   ON CONFLICT(item_id) DO UPDATE SET plays = excluded.plays`
);
// Whether Kodi saw something new for this title since the last sync. The first
// time a title is met there is nothing to compare with: then only a title still
// on the list moves on, and one you set back to Watching (a rewatch) is left be.
function newViewing(existing, plays) {
  const row = getMarkStmt.get(existing.id);
  setMarkStmt.run(existing.id, plays);
  return row ? plays > row.plays : existing.status === 'plan_to_watch';
}
const masterIdStmt = db.prepare("SELECT id FROM users WHERE role = 'master'");

// Kodi tracks "watched" per Kodi profile, not per person, so its library syncs
// into a single member's shelfIt library: the one the active instance names
// (Settings > Kodi), else the master. The review card for scheduled discoveries
// is theirs alone.
// A disabled member keeps the setting but not the sync: their review card could
// never be claimed, so titles fall back to the master until they are re-enabled.
const userExistsStmt = db.prepare('SELECT 1 FROM users WHERE id = ? AND disabled = 0');
export function syncOwnerId() {
  const inst = getActiveInstance();
  if (inst && inst.sync_user_id && userExistsStmt.get(inst.sync_user_id)) return inst.sync_user_id;
  const row = masterIdStmt.get();
  return row ? row.id : null;
}
const setStatus = db.prepare(
  "UPDATE items SET status = ?, updated_at = datetime('now') WHERE id = ?"
);
const insertItem = db.prepare(
  `INSERT INTO items (user_id, tmdb_id, type, title_it, title_orig, status)
   VALUES (?, ?, ?, ?, ?, ?)`
);

// --- Record shaping (Kodi JSON-RPC → resolver record) ---------------------
function movieRec(m) {
  const u = m.uniqueid || {};
  return {
    title: m.title || '',
    originaltitle: m.originaltitle || '',
    year: m.year || 0,
    playcount: m.playcount || 0,
    tmdb: u.tmdb || u.themoviedb || '',
    imdb: u.imdb || '',
  };
}
function showRec(s) {
  const u = s.uniqueid || {};
  return {
    title: s.title || '',
    originaltitle: s.originaltitle || '',
    year: s.year || 0,
    watchedepisodes: s.watchedepisodes || 0,
    episode: s.episode || 0,
    tmdb: u.tmdb || u.themoviedb || '',
    imdb: u.imdb || '',
  };
}
// Proposed status for a show from Kodi's watched-episode counts. Kodi only knows
// the episodes in its own library, so "all watched there" is not "finished": the
// series is shelved only when TMDB says it has ended and the watched count covers
// every episode it lists. Otherwise it is being watched.
const ENDED = new Set(['Ended', 'Canceled', 'Cancelled']);
function showTarget(rec, meta) {
  if (rec.watchedepisodes <= 0) return null;
  const total = meta && meta.number_of_episodes;
  if (meta && ENDED.has(meta.status) && total > 0 && rec.watchedepisodes >= total) return 'completed';
  return 'watching';
}

// Resolve a TMDB id (Kodi almost always carries one; fall back to IMDb/title
// search via the importer's resolver). Cached on the record for reuse.
async function resolve(kind, rec) {
  let tmdb = rec.tmdb;
  if (!tmdb) {
    try {
      tmdb = await resolveTmdb(kind, rec);
    } catch {
      tmdb = null;
    }
  }
  rec.resolvedTmdb = tmdb ? String(tmdb) : null;
  return rec.resolvedTmdb;
}

// Match against shelfIt: TMDB id, or the title when Kodi gave no id at all. A
// known id not in the library is a new title, never a same-named one (Kodi's
// Dune (2021) is not the Dune (1984) on your list).
function existingFor(kind, rec) {
  const owner = syncOwnerId();
  if (rec.resolvedTmdb) return findByTmdb.get(owner, kind, String(rec.resolvedTmdb)) || null;
  const rows = findByTitle.all(owner, kind, rec.title, rec.originaltitle || rec.title);
  return rows[0] || null;
}

// Fetch metadata for a new title (via the existing cache pipeline) and build the
// review payload. Returns null if metadata can't be fetched.
async function discover(kind, rec, proposed) {
  const tmdb = rec.resolvedTmdb;
  if (!tmdb || findByTmdb.get(syncOwnerId(), kind, String(tmdb))) return null;
  let meta;
  try {
    meta = readMetaSync(kind, tmdb) || (await ensureCached(kind, tmdb));
  } catch {
    return null;
  }
  if (!meta) return null;
  const folder = kind === 'movie' ? 'movies' : 'shows';
  return {
    tmdb_id: tmdb,
    type: kind,
    title: meta.title_it || meta.title_orig || rec.title || 'Untitled',
    title_orig: meta.title_orig || meta.title_it || rec.originaltitle || '',
    year: meta.year || (rec.year ? String(rec.year) : ''),
    poster_url: `/assets/${folder}/${tmdb}/poster.webp`,
    proposed_status: proposed,
  };
}

// --- The sync -------------------------------------------------------------
let syncing = false;
export function isSyncing() {
  return syncing;
}

export async function runKodiSync() {
  if (syncing) return { alreadyRunning: true };
  if (!isEnabled()) return { skipped: 'disabled' };
  if (!getActiveInstance()) return { skipped: 'no-active' };
  syncing = true;
  try {
    return await doSync();
  } catch (err) {
    // Kodi unreachable / RPC failure → degrade silently with a clean result.
    return { skipped: 'unreachable', error: err.message };
  } finally {
    syncing = false;
  }
}

async function doSync() {
  const moviesRes = await rpcActive('VideoLibrary.GetMovies', {
    properties: ['uniqueid', 'year', 'title', 'originaltitle', 'playcount'],
  });
  const showsRes = await rpcActive('VideoLibrary.GetTVShows', {
    properties: ['uniqueid', 'year', 'title', 'originaltitle', 'watchedepisodes', 'episode'],
  });
  const kodiMovies = (moviesRes && moviesRes.movies) || [];
  const kodiShows = (showsRes && showsRes.tvshows) || [];

  const discoveries = [];
  let updatedExisting = 0;

  for (const km of kodiMovies) {
    const rec = movieRec(km);
    await resolve('movie', rec);
    const watched = rec.playcount > 0;
    const existing = existingFor('movie', rec);
    if (existing) {
      if (existing.type === 'movie' && newViewing(existing, rec.playcount) && watched) {
        const next = advancedStatus(existing.status, 'completed');
        if (next) {
          setStatus.run(next, existing.id);
          updatedExisting++;
        }
      }
      continue;
    }
    const disc = await discover('movie', rec, watched ? 'completed' : 'plan_to_watch');
    if (disc) discoveries.push(disc);
  }

  for (const ks of kodiShows) {
    const rec = showRec(ks);
    await resolve('show', rec);
    const existing = existingFor('show', rec);
    if (existing) {
      const target = showTarget(rec, readMetaSync('show', existing.tmdb_id));
      if (existing.type === 'show' && newViewing(existing, rec.watchedepisodes) && target) {
        const next = advancedStatus(existing.status, target);
        if (next) {
          setStatus.run(next, existing.id);
          updatedExisting++;
        }
      }
      continue;
    }
    const target = showTarget(rec, rec.resolvedTmdb ? readMetaSync('show', rec.resolvedTmdb) : null);
    const disc = await discover('show', rec, target || 'plan_to_watch');
    if (disc) discoveries.push(disc);
  }

  if (updatedExisting) scheduleStatsRecompute(db);

  const movies_new = discoveries.filter((d) => d.type === 'movie').length;
  return {
    discoveries,
    updated_existing: updatedExisting,
    movies_new,
    shows_new: discoveries.length - movies_new,
  };
}

// Commit reviewed discoveries: add each new title with its reviewed status,
// using metadata already cached during the sync. Skips anything now present.
export async function commitKodiSync(items) {
  if (!Array.isArray(items)) return { added: 0 };
  const owner = syncOwnerId();
  let added = 0;
  for (const it of items || []) {
    const kind = it.type === 'movie' ? 'movie' : 'show';
    const tmdb = String(it.tmdb_id || '');
    if (!/^\d+$/.test(tmdb)) continue;
    const status = VALID_STATUS.includes(it.status) ? it.status : 'plan_to_watch';
    if (findByTmdb.get(owner, kind, tmdb)) continue; // added already / meanwhile
    let meta = readMetaSync(kind, tmdb);
    if (!meta) {
      try {
        meta = await ensureCached(kind, tmdb);
      } catch {
        continue;
      }
    }
    if (!meta) continue;
    insertItem.run(
      owner,
      tmdb,
      kind,
      meta.title_it || meta.title_orig || 'Untitled',
      meta.title_orig || meta.title_it || 'Untitled',
      status
    );
    added++;
  }
  if (added) scheduleStatsRecompute(db);
  return { added };
}

// --- Pending review store (scheduled sync → client poll) ------------------
let pending = null; // last scheduled sync result with discoveries
// Only the sync owner is offered the review card; for anyone else there is
// nothing pending and nothing to claim.
export function getPendingCount(userId) {
  return pending && userId === syncOwnerId() ? pending.discoveries.length : 0;
}
export function setPending(res) {
  pending = res && res.discoveries && res.discoveries.length ? res : null;
}
export function claimPending(userId) {
  if (userId !== syncOwnerId()) return null;
  const p = pending;
  pending = null;
  return p;
}

// --- Scheduled sync (server-side minute tick, no external scheduler) -------
let lastRunDay = null;
let schedulerTimer = null;
export function startKodiScheduler(log) {
  if (schedulerTimer) return; // idempotent — never stack a second minute tick
  schedulerTimer = setInterval(() => {
    tick(log).catch(() => {});
  }, 60_000);
  // Don't hold the event loop open on shutdown; the tick has nothing to finish.
  if (schedulerTimer.unref) schedulerTimer.unref();
}

async function tick(log) {
  const now = new Date();
  if (now.getHours() !== 22) return; // 22:00 server time (first tick in the hour)
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  if (lastRunDay === day) return;
  if (!isEnabled() || !getActiveInstance()) return;
  // Mark today's attempt now so an offline Kodi is not retried within the day.
  lastRunDay = day;
  const online = await pingInstance(getActiveInstance());
  if (!online) {
    if (log) log.info('Kodi scheduled sync skipped — instance offline');
    return;
  }
  try {
    const res = await runKodiSync();
    if (res && res.discoveries && res.discoveries.length) setPending(res);
    if (log) {
      log.info(
        `Kodi scheduled sync: ${res.discoveries ? res.discoveries.length : 0} new, ${res.updated_existing || 0} updated`
      );
    }
  } catch (err) {
    if (log) log.warn(`Kodi scheduled sync failed: ${err.message}`);
  }
}
