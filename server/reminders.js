// Occasional reminders, sent through Web Push alongside the new-episode alerts:
//   • dusty    : a series being watched, left untouched for a month while its
//                next episode is out. Weekend evenings only, at most one a week,
//                never twice in a month for the same series, and given up on a
//                series after two that changed nothing.
//   • cinema   : a movie on the Plan to Watch list opening in cinemas in the
//                member's country (the metadata language's region), once.
//   • comeback : a finished series starting a new season within the week, once
//                per season.
// Each member turns them on or off in Settings (push.js getReminderPrefs), and
// each device reads them in its own UI language. Everything sent is logged in
// push_nudges, which keeps once-only events once and the budget honest; every
// run is safe to repeat.

import db from './db.js';
import { readMetaSync, readSeasonMetaSync, isStale } from './cache.js';
import { enqueueMeta } from './metaBackfill.js';
import { tmdbGet } from './tmdb.js';
import { allowed } from './usage.js';
import { getTmdbLanguage } from './language.js';
import { subscribedUsers, sendToUser, getReminderPrefs, logNudge } from './push.js';

const DAY = 24 * 60 * 60 * 1000;

export const DUSTY_AFTER_DAYS = 30; // untouched this long before a reminder
const DUSTY_EVERY_DAYS = 7; // at most one dusty reminder in this many days
const DUSTY_SAME_TITLE_DAYS = 30; // and never the same series twice within this
const DUSTY_MAX_UNANSWERED = 2; // reminders that changed nothing, then it stops
const CINEMA_WINDOW = [-2, 3]; // days around the opening when it is announced
const COMEBACK_WINDOW = [-2, 7]; // days around the premiere when it is announced
const CINEMA_FETCH_CAP = 30; // release-date lookups per morning run, at most

// --- Prepared statements ----------------------------------------------------
const watchingShowsStmt = db.prepare(
  "SELECT id, tmdb_id, title_it, title_orig FROM items WHERE user_id = ? AND type = 'show' AND status = 'watching'"
);
const completedShowsStmt = db.prepare(
  "SELECT id, tmdb_id, title_it, title_orig FROM items WHERE user_id = ? AND type = 'show' AND status = 'completed'"
);
const plannedMoviesStmt = db.prepare(
  `SELECT id, tmdb_id, title_it, title_orig FROM items
    WHERE user_id = ? AND type = 'movie' AND status = 'plan_to_watch' AND watched_in_cinema = 0`
);
const progressStmt = db.prepare(
  'SELECT season, episode, watched_at FROM progress WHERE item_id = ? AND season > 0'
);
const lastStopStmt = db.prepare('SELECT MAX(updated_at) AS t FROM episode_stops WHERE item_id = ?');
const maxSeasonStmt = db.prepare('SELECT MAX(season) AS s FROM progress WHERE item_id = ? AND season > 0');
const seenSinceStmt = db.prepare('SELECT 1 FROM sessions WHERE user_id = ? AND last_seen_at >= ? LIMIT 1');
const sentSinceStmt = db.prepare('SELECT 1 FROM push_nudges WHERE user_id = ? AND sent_at >= ? LIMIT 1');
const kindSinceStmt = db.prepare(
  'SELECT 1 FROM push_nudges WHERE user_id = ? AND kind = ? AND sent_at >= ? LIMIT 1'
);
const sentKeyStmt = db.prepare('SELECT 1 FROM push_nudges WHERE user_id = ? AND kind = ? AND key = ?');
const dustyOfItemStmt = db.prepare(
  "SELECT sent_at FROM push_nudges WHERE user_id = ? AND kind = 'dusty' AND item_id = ? ORDER BY sent_at DESC"
);

// --- Dates --------------------------------------------------------------------
// Local calendar dates as YYYY-MM-DD, the same shape as TMDB air dates.
function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function dayStr(offset = 0, from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + offset);
  return ymd(d);
}
function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
// progress.watched_at is SQLite's UTC "YYYY-MM-DD HH:MM:SS"; imports may carry
// an ISO string instead. Returns ms, or 0 when unreadable.
export function parseWatchedAt(v) {
  if (!v) return 0;
  const s = String(v).trim().replace(' ', 'T');
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) || s.length <= 10 ? s : `${s}Z`);
  return Number.isFinite(t) ? t : 0;
}
// Whole days from `today` to `date` (both YYYY-MM-DD).
function daysBetween(today, date) {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
}
function inWindow(date, today, [from, to]) {
  if (!date) return false;
  const n = daysBetween(today, date);
  return n >= from && n <= to;
}

// --- Pure decisions (exported for the tests) ------------------------------------

// The episode after the furthest one watched that has already aired, or null
// when the series is caught up. `seasons`: [{ season_number, episodes: [{
// episode_number, air_date }] }]; `watched`: Set of "season:episode".
export function nextAiredEpisode(seasons, watched, today) {
  const eps = [];
  for (const s of [...seasons].sort((a, b) => a.season_number - b.season_number)) {
    if (s.season_number < 1) continue;
    for (const e of [...(s.episodes || [])].sort((a, b) => a.episode_number - b.episode_number)) {
      eps.push({ season: s.season_number, episode: e.episode_number, air_date: e.air_date });
    }
  }
  let frontier = -1;
  eps.forEach((e, i) => {
    if (watched.has(`${e.season}:${e.episode}`)) frontier = i;
  });
  if (frontier < 0) return null;
  for (let i = frontier + 1; i < eps.length; i++) {
    const e = eps[i];
    if (watched.has(`${e.season}:${e.episode}`)) continue;
    return e.air_date && e.air_date <= today ? e : null;
  }
  return null;
}

// Of the series left untouched long enough, the one to mention: none reminded
// about in the last month, none already reminded twice without effect, and of
// the rest the one watched most recently (the likeliest to be picked up again).
// `candidates`: [{ id, last (ms) }]; `sentOf(id)`: that series' reminder times.
export function pickDusty(candidates, sentOf, now) {
  const ok = candidates.filter((c) => {
    if (now - c.last < DUSTY_AFTER_DAYS * DAY) return false;
    const sent = sentOf(c.id);
    if (sent.some((t) => now - t < DUSTY_SAME_TITLE_DAYS * DAY)) return false;
    return sent.filter((t) => t > c.last).length < DUSTY_MAX_UNANSWERED;
  });
  ok.sort((a, b) => b.last - a.last);
  return ok[0] || null;
}

// A movie's cinema opening in `region` from TMDB's release_dates: the earliest
// theatrical date (type 3), else the earliest limited one (type 2). YYYY-MM-DD.
export function theatricalDate(results, region) {
  const entry = (results || []).find((r) => r.iso_3166_1 === region);
  if (!entry) return null;
  for (const type of [3, 2]) {
    const dates = (entry.release_dates || [])
      .filter((d) => d.type === type && d.release_date)
      .map((d) => String(d.release_date).slice(0, 10))
      .sort();
    if (dates.length) return dates[0];
  }
  return null;
}

// The first season after the last one watched whose premiere falls between
// `from` and `to` (YYYY-MM-DD), or null.
export function comebackSeason(seasons, lastWatchedSeason, from, to) {
  return (
    [...(seasons || [])]
      .sort((a, b) => a.season_number - b.season_number)
      .find(
        (s) =>
          s.season_number > lastWatchedSeason && s.air_date && s.air_date >= from && s.air_date <= to
      ) || null
  );
}

// --- Words ----------------------------------------------------------------------
const LOCALE = { it: 'it-IT', en: 'en-GB' };
function dayName(date, lang) {
  return new Intl.DateTimeFormat(LOCALE[lang], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}
function epCode(season, episode) {
  const p = (n) => String(n).padStart(2, '0');
  return `S${p(season)} E${p(episode)}`;
}
function joinNames(names, lang) {
  const and = lang === 'it' ? 'e' : 'and';
  if (names.length > 3) {
    const rest = names.length - 3;
    return `${names.slice(0, 3).join(', ')} ${lang === 'it' ? `e altri ${rest}` : `and ${rest} more`}`;
  }
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}`;
}
const titleOf = (row) => row.title_it || row.title_orig || '';

export function dustyText(lang, show, ep, days) {
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const code = epCode(ep.season, ep.episode);
  if (lang === 'it') {
    const span = days < 60 ? `${weeks} settimane` : months === 1 ? 'un mese' : `${months} mesi`;
    return { title: `Ti ricordi di ${show}? 📺`, body: `${code} ti aspetta da ${span}.` };
  }
  const span = days < 60 ? `${weeks} weeks` : `${months} months`;
  return { title: `Remember ${show}? 📺`, body: `${code} has been waiting for you for ${span}.` };
}

export function cinemaText(lang, hits, today) {
  if (hits.length === 1) {
    const { title, date } = hits[0];
    const n = daysBetween(today, date);
    const day = dayName(date, lang);
    if (lang === 'it') {
      const body =
        n === 0 ? `${title} è al cinema da oggi.` : n < 0 ? `${title} è al cinema da ${day}.` : `${title} esce ${day}.`;
      return { title: 'Al cinema questa settimana 🎟️', body };
    }
    const body =
      n === 0 ? `${title} is in cinemas from today.` : n < 0 ? `${title} is in cinemas since ${day}.` : `${title} opens on ${day}.`;
    return { title: 'In cinemas this week 🎟️', body };
  }
  const list = joinNames(hits.map((h) => h.title), lang);
  return lang === 'it'
    ? { title: 'Al cinema questa settimana 🎟️', body: `Dalla tua lista, ${list} escono al cinema.` }
    : { title: 'In cinemas this week 🎟️', body: `${list} from your list are out in cinemas.` };
}

export function comebackText(lang, hits, today) {
  if (hits.length === 1) {
    const { title, season, date } = hits[0];
    const n = daysBetween(today, date);
    const day = dayName(date, lang);
    if (lang === 'it') {
      const body =
        n === 0
          ? `La stagione ${season} esce oggi.`
          : n < 0
            ? `La stagione ${season} è uscita ${day}.`
            : `La stagione ${season} inizia ${day}.`;
      return { title: `Torna ${title} 🎬`, body };
    }
    const body =
      n === 0
        ? `Season ${season} is out today.`
        : n < 0
          ? `Season ${season} started on ${day}.`
          : `Season ${season} starts on ${day}.`;
    return { title: `${title} is back 🎬`, body };
  }
  const list = joinNames(hits.map((h) => h.title), lang);
  return lang === 'it'
    ? { title: 'Tornano serie che hai finito 🎬', body: `Nuove stagioni di ${list}.` }
    : { title: 'Series you finished are back 🎬', body: `New seasons of ${list}.` };
}

// --- Runs -----------------------------------------------------------------------

// A series' episodes from the local cache, for nextAiredEpisode.
function cachedSeasons(tmdbId) {
  const meta = readMetaSync('show', tmdbId);
  if (!meta) return [];
  return (meta.seasons || []).map((s) => {
    const sm = readSeasonMetaSync(tmdbId, s.season_number);
    return { season_number: s.season_number, episodes: (sm && sm.episodes) || [] };
  });
}

async function runDusty(userId, now, logger) {
  const todayStart = startOfDay(now);
  // Already in the app today, or something else already arrived: not today.
  if (seenSinceStmt.get(userId, todayStart)) return;
  if (sentSinceStmt.get(userId, todayStart)) return;
  if (kindSinceStmt.get(userId, 'dusty', now - DUSTY_EVERY_DAYS * DAY)) return;

  const today = ymd(new Date(now));
  const candidates = [];
  for (const show of watchingShowsStmt.all(userId)) {
    const rows = progressStmt.all(show.id);
    if (!rows.length) continue; // never started: not left, just planned
    const watched = new Set();
    let last = 0;
    for (const r of rows) {
      watched.add(`${r.season}:${r.episode}`);
      last = Math.max(last, parseWatchedAt(r.watched_at));
    }
    const stop = lastStopStmt.get(show.id);
    if (stop && stop.t) last = Math.max(last, stop.t);
    if (!last || now - last < DUSTY_AFTER_DAYS * DAY) continue;
    const next = nextAiredEpisode(cachedSeasons(show.tmdb_id), watched, today);
    if (next) candidates.push({ id: show.id, last, show, next });
  }

  const pick = pickDusty(candidates, (id) => dustyOfItemStmt.all(userId, id).map((r) => r.sent_at), now);
  if (!pick) return;
  const days = Math.floor((now - pick.last) / DAY);
  const delivered = await sendToUser(
    userId,
    (lang) => ({
      ...dustyText(lang, titleOf(pick.show), pick.next, days),
      url: `/detail/${pick.show.id}`,
      tag: `dusty-${pick.show.id}`,
    }),
    logger
  );
  if (delivered) logNudge(userId, 'dusty', pick.show.id, `${pick.show.id}:${today}`);
}

async function runCinema(userId, today, lookup, logger) {
  const hits = [];
  for (const m of plannedMoviesStmt.all(userId)) {
    if (sentKeyStmt.get(userId, 'cinema', m.tmdb_id)) continue;
    // The worldwide first release bounds the local one: only titles around it
    // are looked up, the rest of the list costs nothing.
    const meta = readMetaSync('movie', m.tmdb_id);
    if (!meta || !inWindow(meta.release_date, today, [-120, CINEMA_WINDOW[1]])) continue;
    const date = await lookup(m.tmdb_id);
    if (date && inWindow(date, today, CINEMA_WINDOW)) hits.push({ item: m, title: titleOf(m), date });
  }
  if (!hits.length) return;
  hits.sort((a, b) => a.date.localeCompare(b.date));
  const delivered = await sendToUser(
    userId,
    (lang) => ({
      ...cinemaText(lang, hits, today),
      url: hits.length === 1 ? `/detail/${hits[0].item.id}` : '/',
      tag: 'cinema',
    }),
    logger
  );
  if (delivered) for (const h of hits) logNudge(userId, 'cinema', h.item.id, h.item.tmdb_id);
}

async function runComeback(userId, today, logger) {
  const from = dayStr(COMEBACK_WINDOW[0]);
  const to = dayStr(COMEBACK_WINDOW[1]);
  const hits = [];
  for (const show of completedShowsStmt.all(userId)) {
    const meta = readMetaSync('show', show.tmdb_id);
    if (!meta) continue;
    // A finished series still airing is refreshed in the background, so a new
    // season shows up in its data before the next run.
    if (isStale(meta)) enqueueMeta('show', show.tmdb_id, { refresh: true });
    const last = (maxSeasonStmt.get(show.id) || {}).s || 0;
    const season = comebackSeason(meta.seasons, last, from, to);
    if (!season) continue;
    const key = `${show.tmdb_id}:${season.season_number}`;
    if (sentKeyStmt.get(userId, 'comeback', key)) continue;
    hits.push({ item: show, title: titleOf(show), season: season.season_number, date: season.air_date, key });
  }
  if (!hits.length) return;
  hits.sort((a, b) => a.date.localeCompare(b.date));
  const delivered = await sendToUser(
    userId,
    (lang) => ({
      ...comebackText(lang, hits, today),
      url: hits.length === 1 ? `/detail/${hits[0].item.id}` : '/upcoming',
      tag: 'comeback',
    }),
    logger
  );
  if (delivered) for (const h of hits) logNudge(userId, 'comeback', h.item.id, h.key);
}

// Mornings: the news (cinema openings, returning series), for every member.
export async function runMorningReminders(logger) {
  const today = dayStr(0);
  const region = (getTmdbLanguage().split('-')[1] || 'US').toUpperCase();
  // One lookup per movie per run, shared by the household, within a budget.
  const memo = new Map();
  let fetched = 0;
  const lookup = async (tmdbId) => {
    if (memo.has(tmdbId)) return memo.get(tmdbId);
    let date = null;
    if (fetched < CINEMA_FETCH_CAP && allowed('tmdb')) {
      fetched += 1;
      try {
        const data = await tmdbGet(`/movie/${tmdbId}/release_dates`);
        date = theatricalDate(data && data.results, region);
      } catch (err) {
        if (logger) logger.warn(`reminders: release dates for movie ${tmdbId} failed: ${err.message}`);
      }
    }
    memo.set(tmdbId, date);
    return date;
  };
  for (const userId of subscribedUsers()) {
    const prefs = getReminderPrefs(userId);
    try {
      if (prefs.cinema) await runCinema(userId, today, lookup, logger);
      if (prefs.comeback) await runComeback(userId, today, logger);
    } catch (err) {
      if (logger) logger.warn(`reminders: morning run failed for user ${userId}: ${err.message}`);
    }
  }
}

// Weekend evenings: the gentle nudge about a series left behind.
export async function runEveningReminders(logger, now = Date.now()) {
  for (const userId of subscribedUsers()) {
    if (!getReminderPrefs(userId).dusty) continue;
    try {
      await runDusty(userId, now, logger);
    } catch (err) {
      if (logger) logger.warn(`reminders: evening run failed for user ${userId}: ${err.message}`);
    }
  }
}

// --- Scheduler (server time) ----------------------------------------------------
// Mornings from 09:00 for the news; Friday to Sunday from 18:00 to 21:59 for the
// series reminder, so a restart late at night sends nothing.
export function startReminderScheduler(logger) {
  let morningDay = null;
  let eveningDay = null;
  const tick = async () => {
    try {
      const now = new Date();
      const day = ymd(now);
      const h = now.getHours();
      if (h >= 9 && h < 22 && morningDay !== day) {
        morningDay = day;
        await runMorningReminders(logger);
      }
      const weekend = [5, 6, 0].includes(now.getDay());
      if (weekend && h >= 18 && h < 22 && eveningDay !== day) {
        eveningDay = day;
        await runEveningReminders(logger);
      }
    } catch (err) {
      if (logger) logger.warn(`reminder scheduler tick failed: ${err.message}`);
    }
  };
  const timer = setInterval(tick, 30 * 60 * 1000);
  if (timer.unref) timer.unref();
  // A little after boot, so the day's new-episode check goes first.
  const first = setTimeout(tick, 2 * 60 * 1000);
  if (first.unref) first.unref();
}
