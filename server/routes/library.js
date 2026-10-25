// Library export / import — a full, portable backup of everything the user owns
// (statuses, ratings, play counts, ownership, notes, watch dates, per-episode
// progress, list memberships). Metadata (posters, descriptions, cast…) is NEVER
// exported: it is always re-fetched from TMDB on import. XML is built and parsed
// with the project's existing dependency-free approach (string building + scoped
// regexes, mirroring server/importKodi.js); SHA-256 uses Node's crypto.

import crypto from 'node:crypto';
import db from '../db.js';
import { ensureCached } from '../cache.js';
import { scheduleStatsRecompute } from '../stats.js';
import { TMDB_IMPORT_INTERVAL_MS } from '../config.js';

// v2 added the per-title fields introduced after the initial export shipped:
// favorite (movies + shows), the cinema screening fields watched_in_cinema /
// cinema_date / cinema_time / cinema_name (movies), and current_season (shows).
// v1 files still import cleanly — the new fields are simply absent and default
// to their empty/derived values, so the format stays additive and backward-
// compatible.
// v3 adds a per-movie <rewatches> block (one <rewatch date="…"/> per dated
// rewatch event). v1/v2 files still import cleanly — an absent block just means
// the movie keeps its play_count-derived rewatch count.
const EXPORT_VERSION = 3;
const SUPPORTED_VERSIONS = new Set([1, 2, 3]);

// DB status <-> XML status. The data value 'completed' surfaces as 'shelved'.
const STATUS_DB_TO_XML = {
  plan_to_watch: 'plan',
  watching: 'watching',
  completed: 'shelved',
  paused: 'paused',
  dropped: 'dropped',
};
const STATUS_XML_TO_DB = {
  plan: 'plan_to_watch',
  watching: 'watching',
  shelved: 'completed',
  paused: 'paused',
  dropped: 'dropped',
};
// "Advancement" order for the merge (higher wins): a shelved title beats a
// watching one, watching beats plan, etc.
const STATUS_RANK = { plan_to_watch: 0, dropped: 1, paused: 2, watching: 3, completed: 4 };

// --- Prepared statements (compiled once at module load, reused thereafter) ---
// A backup is one member's library: export reads the signed-in member's rows and
// lists, import merges into them. Progress and rewatch rows are reached through
// those items only.
// Export
const exportItemsStmt = db.prepare(
  'SELECT * FROM items WHERE user_id = ? ORDER BY type, CAST(tmdb_id AS INTEGER)'
);
const exportListsStmt = db.prepare(
  `SELECT l.name AS name, l.type AS type, li.tmdb_id AS tmdb_id
     FROM list_items li JOIN lists l ON l.id = li.list_id
    WHERE l.user_id = ?
    ORDER BY l.created_at`
);
const exportProgressStmt = db.prepare(
  'SELECT season, episode, watch_count, watched_at, notes FROM progress WHERE item_id = ? ORDER BY season, episode'
);
// Import
const findItemStmt = db.prepare('SELECT * FROM items WHERE user_id = ? AND type = ? AND tmdb_id = ?');
const findListStmt = db.prepare('SELECT id FROM lists WHERE user_id = ? AND name = ? AND type = ?');
const insertListStmt = db.prepare(
  'INSERT INTO lists (user_id, name, type, created_at) VALUES (?, ?, ?, ?)'
);
const addListItemStmt = db.prepare(
  'INSERT OR IGNORE INTO list_items (list_id, tmdb_id, added_at) VALUES (?, ?, ?)'
);
const findProgressStmt = db.prepare(
  'SELECT * FROM progress WHERE item_id = ? AND season = ? AND episode = ?'
);
const insertItemStmt = db.prepare(
  `INSERT INTO items
     (user_id, tmdb_id, type, title_it, title_orig, status, rating, notes, owned, rewatch_count,
      favorite, watched_in_cinema, cinema_date, cinema_time, cinema_name, current_season,
      watch_date, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
);
// Movie rewatch export + idempotent import (matched on item_id + date so a
// re-import never duplicates), plus the counter sync from the row count.
const exportRewatchesStmt = db.prepare(
  'SELECT watched_at FROM movie_rewatches WHERE item_id = ? ORDER BY watched_at, id'
);
const insertRewatchIgnoreStmt = db.prepare(
  `INSERT INTO movie_rewatches (item_id, watched_at, created_at)
   SELECT ?, ?, ?
   WHERE NOT EXISTS (SELECT 1 FROM movie_rewatches WHERE item_id = ? AND watched_at = ?)`
);
const countRewatchesStmt = db.prepare('SELECT COUNT(*) AS n FROM movie_rewatches WHERE item_id = ?');
const setRewatchCountStmt = db.prepare('UPDATE items SET rewatch_count = ? WHERE id = ?');
const insertProgressIgnoreStmt = db.prepare(
  `INSERT INTO progress (item_id, season, episode, watch_count, watched_at, notes)
   VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), ?)
   ON CONFLICT(item_id, season, episode) DO NOTHING`
);
const insertProgressStmt = db.prepare(
  `INSERT INTO progress (item_id, season, episode, watch_count, watched_at, notes)
   VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), ?)`
);
const updateItemMergeStmt = db.prepare(
  `UPDATE items SET status = ?, rating = ?, notes = ?, owned = ?, rewatch_count = ?,
     favorite = ?, watched_in_cinema = ?, cinema_date = ?, cinema_time = ?, cinema_name = ?,
     current_season = ?, watch_date = ?, updated_at = datetime('now') WHERE id = ?`
);
const updateProgressMergeStmt = db.prepare(
  'UPDATE progress SET watch_count = ?, notes = ? WHERE id = ?'
);
const backfillItemMetaStmt = db.prepare(
  'UPDATE items SET title_it = ?, title_orig = ?, year = ?, genres = ? WHERE id = ?'
);

// --- XML helpers -----------------------------------------------------------
function escXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function unescXml(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
function dateOnly(v) {
  if (!v) return '';
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}
function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// ======================= EXPORT =======================
function movieXml(it, lists, rewatchDates) {
  const status = STATUS_DB_TO_XML[it.status] || 'plan';
  const watched = it.status === 'completed';
  const playCount = (it.rewatch_count || 0) + (watched ? 1 : 0);
  // Prefer the explicit editable watch_date; fall back to date(updated_at) for
  // pre-feature rows (same value the receipt uses).
  const watchDate = it.watch_date ? dateOnly(it.watch_date) : watched ? dateOnly(it.updated_at) : '';
  let s = `    <movie tmdb_id="${escXml(it.tmdb_id)}">\n`;
  s += `      <title>${escXml(it.title_it || '')}</title>\n`;
  s += `      <status>${status}</status>\n`;
  if (it.rating) s += `      <rating>${it.rating}</rating>\n`;
  s += `      <play_count>${playCount}</play_count>\n`;
  s += `      <owned>${it.owned ? 'true' : 'false'}</owned>\n`;
  s += `      <favorite>${it.favorite ? 'true' : 'false'}</favorite>\n`;
  // Cinema screening (movies only). The flag is always emitted (like owned); the
  // optional date/time/name only when set, mirroring how notes/watch_date behave.
  s += `      <watched_in_cinema>${it.watched_in_cinema ? 'true' : 'false'}</watched_in_cinema>\n`;
  if (it.cinema_date) s += `      <cinema_date>${escXml(it.cinema_date)}</cinema_date>\n`;
  if (it.cinema_time) s += `      <cinema_time>${escXml(it.cinema_time)}</cinema_time>\n`;
  if (it.cinema_name && it.cinema_name.trim()) s += `      <cinema_name>${escXml(it.cinema_name)}</cinema_name>\n`;
  if (it.notes && it.notes.trim()) s += `      <notes>${escXml(it.notes)}</notes>\n`;
  if (watchDate) s += `      <watch_date>${watchDate}</watch_date>\n`;
  // Dated rewatch events (movies only). Omitted entirely when there are none.
  if (rewatchDates && rewatchDates.length) {
    s += `      <rewatches>\n`;
    for (const d of rewatchDates) s += `        <rewatch date="${escXml(d)}"/>\n`;
    s += `      </rewatches>\n`;
  }
  s += listsXml(lists);
  s += `    </movie>\n`;
  return s;
}

function showXml(it, lists, eps) {
  const status = STATUS_DB_TO_XML[it.status] || 'plan';
  let s = `    <show tmdb_id="${escXml(it.tmdb_id)}">\n`;
  s += `      <title>${escXml(it.title_it || '')}</title>\n`;
  s += `      <status>${status}</status>\n`;
  if (it.rating) s += `      <rating>${it.rating}</rating>\n`;
  s += `      <owned>${it.owned ? 'true' : 'false'}</owned>\n`;
  s += `      <favorite>${it.favorite ? 'true' : 'false'}</favorite>\n`;
  // The season the user is currently working through (shows only) — powers What's
  // Next rewatch resolution. Only emitted when set so v1-style rows stay clean.
  if (it.current_season != null) s += `      <current_season>${escXml(it.current_season)}</current_season>\n`;
  if (it.notes && it.notes.trim()) s += `      <notes>${escXml(it.notes)}</notes>\n`;
  if (eps.length) {
    const bySeason = new Map();
    for (const e of eps) {
      if (!bySeason.has(e.season)) bySeason.set(e.season, []);
      bySeason.get(e.season).push(e);
    }
    s += `      <seasons>\n`;
    for (const [num, list] of [...bySeason.entries()].sort((a, b) => a[0] - b[0])) {
      s += `        <season number="${num}">\n`;
      for (const e of list) {
        const attrs = [`number="${e.episode}"`, `watched="true"`, `play_count="${e.watch_count || 1}"`];
        const wd = dateOnly(e.watched_at);
        if (wd) attrs.push(`watch_date="${wd}"`);
        if (e.notes && e.notes.trim()) attrs.push(`notes="${escXml(e.notes)}"`);
        s += `          <episode ${attrs.join(' ')}/>\n`;
      }
      s += `        </season>\n`;
    }
    s += `      </seasons>\n`;
  }
  s += listsXml(lists);
  s += `    </show>\n`;
  return s;
}

function listsXml(lists) {
  if (!lists || !lists.length) return '';
  let s = `      <lists>\n`;
  for (const n of lists) s += `        <list>${escXml(n)}</list>\n`;
  s += `      </lists>\n`;
  return s;
}

// Build the raw string that goes between <library> and </library>, plus the
// entry count. The checksum is computed over exactly this string.
function buildLibrary(userId) {
  const items = exportItemsStmt.all(userId);

  const listRows = exportListsStmt.all(userId);
  const listMap = new Map(); // `${type}:${tmdb_id}` -> [names]
  for (const r of listRows) {
    const key = `${r.type}:${r.tmdb_id}`;
    if (!listMap.has(key)) listMap.set(key, []);
    listMap.get(key).push(r.name);
  }

  const progStmt = exportProgressStmt;

  let inner = '';
  let count = 0;
  for (const it of items) {
    count += 1;
    const lists = listMap.get(`${it.type}:${it.tmdb_id}`) || [];
    if (it.type === 'movie') {
      const rewatchDates = exportRewatchesStmt.all(it.id).map((r) => dateOnly(r.watched_at)).filter(Boolean);
      inner += movieXml(it, lists, rewatchDates);
    } else inner += showXml(it, lists, progStmt.all(it.id));
  }
  // The content between the tags (a leading newline + entries + closing indent).
  return { content: `\n${inner}  `, count };
}

export function buildExportXml(userId) {
  const { content, count } = buildLibrary(userId);
  const checksum = sha256(content);
  const exportedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<shelfit_library>\n` +
    `  <meta>\n` +
    `    <version>${EXPORT_VERSION}</version>\n` +
    `    <exported_at>${exportedAt}</exported_at>\n` +
    `    <checksum>${checksum}</checksum>\n` +
    `    <entry_count>${count}</entry_count>\n` +
    `  </meta>\n` +
    `  <library>${content}</library>\n` +
    `</shelfit_library>\n`
  );
}

// ======================= IMPORT =======================
function tagText(block, name) {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? unescXml(m[1].trim()) : '';
}
function attrOf(tagStr, name) {
  const m = tagStr.match(new RegExp(`${name}="([^"]*)"`));
  return m ? unescXml(m[1]) : '';
}
function parseListNames(block) {
  const wrap = block.match(/<lists>([\s\S]*?)<\/lists>/);
  if (!wrap) return [];
  const names = [];
  const re = /<list>([\s\S]*?)<\/list>/g;
  let m;
  while ((m = re.exec(wrap[1]))) {
    const n = unescXml(m[1].trim());
    if (n) names.push(n);
  }
  return names;
}

function parseEntries(libraryContent) {
  const entries = [];
  const movieRe = /<movie\s+tmdb_id="([^"]+)"\s*>([\s\S]*?)<\/movie>/g;
  let m;
  while ((m = movieRe.exec(libraryContent))) {
    const tmdbId = m[1];
    const b = m[2];
    entries.push({
      type: 'movie',
      tmdb_id: tmdbId,
      title: tagText(b, 'title'),
      status: STATUS_XML_TO_DB[tagText(b, 'status')] || 'plan_to_watch',
      rating: parseRating(tagText(b, 'rating')),
      play_count: parseInt(tagText(b, 'play_count'), 10) || 0,
      owned: tagText(b, 'owned') === 'true',
      favorite: tagText(b, 'favorite') === 'true',
      watched_in_cinema: tagText(b, 'watched_in_cinema') === 'true',
      cinema_date: tagText(b, 'cinema_date') || null,
      cinema_time: tagText(b, 'cinema_time') || null,
      cinema_name: tagText(b, 'cinema_name') || null,
      notes: tagText(b, 'notes'),
      watch_date: tagText(b, 'watch_date'),
      rewatches: parseRewatchDates(b),
      lists: parseListNames(b),
    });
  }
  const showRe = /<show\s+tmdb_id="([^"]+)"\s*>([\s\S]*?)<\/show>/g;
  while ((m = showRe.exec(libraryContent))) {
    const tmdbId = m[1];
    const b = m[2];
    const episodes = [];
    const seasonRe = /<season\s+number="(\d+)"\s*>([\s\S]*?)<\/season>/g;
    let sm;
    while ((sm = seasonRe.exec(b))) {
      const season = parseInt(sm[1], 10);
      const epRe = /<episode\s+([^>]*?)\/>/g;
      let em;
      while ((em = epRe.exec(sm[2]))) {
        const a = em[1];
        if (attrOf(a, 'watched') === 'false') continue; // only watched episodes carry state
        episodes.push({
          season,
          episode: parseInt(attrOf(a, 'number'), 10),
          play_count: parseInt(attrOf(a, 'play_count'), 10) || 1,
          watch_date: attrOf(a, 'watch_date'),
          notes: attrOf(a, 'notes'),
        });
      }
    }
    entries.push({
      type: 'show',
      tmdb_id: tmdbId,
      title: tagText(b, 'title'),
      status: STATUS_XML_TO_DB[tagText(b, 'status')] || 'plan_to_watch',
      rating: parseRating(tagText(b, 'rating')),
      owned: tagText(b, 'owned') === 'true',
      favorite: tagText(b, 'favorite') === 'true',
      current_season: parseSeason(tagText(b, 'current_season')),
      notes: tagText(b, 'notes'),
      episodes,
      lists: parseListNames(b),
    });
  }
  return entries;
}

function parseRating(v) {
  const n = parseInt(v, 10);
  return n >= 1 && n <= 5 ? n : null;
}

// Dated rewatch events from a movie block's <rewatches> — only well-formed
// 'YYYY-MM-DD' dates are kept.
function parseRewatchDates(block) {
  const wrap = block.match(/<rewatches>([\s\S]*?)<\/rewatches>/);
  if (!wrap) return [];
  const out = [];
  const re = /<rewatch\s+([^>]*?)\/>/g;
  let m;
  while ((m = re.exec(wrap[1]))) {
    const d = attrOf(m[1], 'date');
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out.push(d);
  }
  return out;
}

// current_season (shows). A non-negative integer, or null when absent/invalid.
function parseSeason(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// The season a show is "currently working through", derived the same way as the
// db.js migration backfill: the highest season number that carries at least one
// watched episode (season 0 = specials excluded). null when there are none.
function derivedCurrentSeason(episodes) {
  let max = null;
  for (const ep of episodes || []) {
    if (ep.season > 0 && (max === null || ep.season > max)) max = ep.season;
  }
  return max;
}

function mergeNotes(existing, imported) {
  const a = (existing || '').trim();
  const b = (imported || '').trim();
  if (!a) return b || null;
  if (!b) return a || null;
  if (a.includes(b)) return a; // idempotent re-import
  return `${a}\n\n(imported)\n${b}`;
}

// Validate the whole file WITHOUT touching the DB. Returns { ok, error?, entries?, version? }.
export function validateImport(xml) {
  if (typeof xml !== 'string' || !xml.trim()) {
    return { ok: false, error: 'The file is empty.' };
  }
  if (!/<shelfit_library[\s>]/.test(xml) || !xml.includes('</shelfit_library>')) {
    return { ok: false, error: 'Not a shelfIt library file (missing <shelfit_library> root).' };
  }
  const metaM = xml.match(/<meta>([\s\S]*?)<\/meta>/);
  if (!metaM) return { ok: false, error: 'The file is malformed (missing <meta> block).' };
  const meta = metaM[1];

  const version = parseInt(tagText(meta, 'version'), 10);
  if (!SUPPORTED_VERSIONS.has(version)) {
    return { ok: false, error: `Unsupported file version (${tagText(meta, 'version') || '?'}).` };
  }
  const checksum = tagText(meta, 'checksum');
  const declaredCount = parseInt(tagText(meta, 'entry_count'), 10);

  const libStart = xml.indexOf('<library>');
  const libEnd = xml.indexOf('</library>');
  if (libStart < 0 || libEnd < 0 || libEnd < libStart) {
    return { ok: false, error: 'The file is malformed (missing <library> block).' };
  }
  const content = xml.slice(libStart + '<library>'.length, libEnd);

  if (!checksum || sha256(content) !== checksum) {
    return { ok: false, error: 'Checksum mismatch: the file appears corrupted or edited.' };
  }

  const entries = parseEntries(content);
  if (!Number.isNaN(declaredCount) && declaredCount !== entries.length) {
    return {
      ok: false,
      error: `Entry count mismatch (header says ${declaredCount}, found ${entries.length}). The file may be truncated.`,
    };
  }
  return { ok: true, version, entries };
}

// Apply the parsed entries. Everything is one transaction; a per-entry failure is
// recorded and skipped (the rest still commit). Returns a summary + the list of
// newly-added items so metadata can be fetched in the background afterwards.
function applyImport(entries, userId) {
  const summary = { added: 0, merged: 0, unchanged: 0, failed: 0 };
  const failures = [];
  const newItems = []; // { id, type, tmdb_id }

  const findItem = findItemStmt;
  const findList = findListStmt;
  const insertList = insertListStmt;
  const addListItem = addListItemStmt;
  const findProgress = findProgressStmt;

  function ensureListMembership(entry, changedRef) {
    for (const name of entry.lists || []) {
      let list = findList.get(userId, name, entry.type);
      if (!list) {
        const info = insertList.run(userId, name, entry.type, Date.now());
        list = { id: info.lastInsertRowid };
        changedRef.v = true;
      }
      const res = addListItem.run(list.id, Number(entry.tmdb_id), Date.now());
      if (res.changes > 0) changedRef.v = true;
    }
  }

  const run = db.transaction(() => {
    for (const entry of entries) {
      try {
        if (!/^\d+$/.test(String(entry.tmdb_id))) {
          throw new Error('invalid tmdb_id');
        }
        const existing = findItem.get(userId, entry.type, String(entry.tmdb_id));

        if (!existing) {
          // --- New title: insert from the XML, queue a metadata fetch. ---
          const rewatch =
            entry.type === 'movie'
              ? Math.max(0, (entry.play_count || 0) - (entry.status === 'completed' ? 1 : 0))
              : 0;
          const updatedAt =
            entry.type === 'movie' && entry.watch_date ? entry.watch_date : null;
          const title = entry.title || 'Untitled';
          // Cinema fields are movie-only; current_season is show-only (falling back
          // to the value derived from the imported episodes so rewatch resolution
          // works immediately, exactly like the db.js backfill).
          const isMovie = entry.type === 'movie';
          const currentSeason =
            entry.type === 'show'
              ? entry.current_season != null
                ? entry.current_season
                : derivedCurrentSeason(entry.episodes)
              : null;
          const watchDateCol = isMovie && entry.watch_date ? entry.watch_date : null;
          const info = insertItemStmt.run(
            userId,
            String(entry.tmdb_id),
            entry.type,
            title,
            title,
            entry.status,
            entry.rating,
            entry.notes || null,
            entry.owned ? 1 : 0,
            rewatch,
            entry.favorite ? 1 : 0,
            isMovie && entry.watched_in_cinema ? 1 : 0,
            isMovie ? entry.cinema_date || null : null,
            isMovie ? entry.cinema_time || null : null,
            isMovie ? entry.cinema_name || null : null,
            currentSeason,
            watchDateCol,
            updatedAt
          );
          const itemId = info.lastInsertRowid;

          if (entry.type === 'show') {
            for (const ep of entry.episodes || []) {
              if (!Number.isInteger(ep.episode)) continue;
              insertProgressIgnoreStmt.run(itemId, ep.season, ep.episode, ep.play_count || 1, ep.watch_date || null, ep.notes || null);
            }
          }

          // Dated rewatch events (movies) → insert then set rewatch_count to the
          // authoritative row count (play_count = rewatch rows + 1).
          if (entry.type === 'movie' && entry.rewatches && entry.rewatches.length) {
            const now = Date.now();
            for (const d of entry.rewatches) insertRewatchIgnoreStmt.run(itemId, d, now, itemId, d);
            setRewatchCountStmt.run(countRewatchesStmt.get(itemId).n, itemId);
          }

          ensureListMembership(entry, { v: true });
          newItems.push({ id: itemId, type: entry.type, tmdb_id: String(entry.tmdb_id) });
          summary.added += 1;
        } else {
          // --- Existing title: additive, non-destructive merge. ---
          const changed = { v: false };

          // Status → keep the more advanced.
          const bestStatus =
            (STATUS_RANK[entry.status] || 0) > (STATUS_RANK[existing.status] || 0)
              ? entry.status
              : existing.status;
          // Rating → keep existing if set.
          const rating = existing.rating != null ? existing.rating : entry.rating;
          // Notes → append imported below existing (never overwrite).
          const notes = mergeNotes(existing.notes, entry.notes);
          // Owned → OR.
          const owned = existing.owned || entry.owned ? 1 : 0;
          const isMovie = entry.type === 'movie';
          // Favorite → OR (an import never un-favorites a title).
          const favorite = existing.favorite || entry.favorite ? 1 : 0;
          // Watched-in-cinema → OR (movies only).
          const watchedInCinema =
            existing.watched_in_cinema || (isMovie && entry.watched_in_cinema) ? 1 : 0;
          // Cinema date/time/name → keep the existing value when already set;
          // otherwise adopt the imported one (movies only). Non-destructive: an
          // import never clears screening details the user already has.
          const keepText = (ex, im) => (ex != null && String(ex).length ? ex : im || null);
          const cinemaDate = keepText(existing.cinema_date, isMovie ? entry.cinema_date : null);
          const cinemaTime = keepText(existing.cinema_time, isMovie ? entry.cinema_time : null);
          const cinemaName = keepText(existing.cinema_name, isMovie ? entry.cinema_name : null);
          // Watch date (movies) → keep existing when set; otherwise adopt the
          // imported one. Non-destructive: an import never clears an edited date.
          const watchDate = keepText(existing.watch_date, isMovie ? entry.watch_date : null);
          // current_season → keep existing when set (the app maintains it live);
          // otherwise adopt the imported value, or derive it from the imported
          // episodes (shows only), matching the db.js backfill.
          let currentSeason = existing.current_season;
          if (currentSeason == null && entry.type === 'show') {
            currentSeason =
              entry.current_season != null ? entry.current_season : derivedCurrentSeason(entry.episodes);
          }

          // Play count (movies) → take the higher, mapped back to rewatch_count.
          let rewatch = existing.rewatch_count || 0;
          if (entry.type === 'movie') {
            const existingPlays = (existing.rewatch_count || 0) + (existing.status === 'completed' ? 1 : 0);
            const mergedPlays = Math.max(existingPlays, entry.play_count || 0);
            rewatch = Math.max(0, mergedPlays - (bestStatus === 'completed' ? 1 : 0));
            // Dated rewatch events → merge idempotently (by item + date); the row
            // count then becomes authoritative for rewatch_count.
            if (entry.rewatches && entry.rewatches.length) {
              const now = Date.now();
              for (const d of entry.rewatches) insertRewatchIgnoreStmt.run(existing.id, d, now, existing.id, d);
              rewatch = countRewatchesStmt.get(existing.id).n;
            }
          }

          if (
            bestStatus !== existing.status ||
            rating !== existing.rating ||
            (notes || null) !== (existing.notes || null) ||
            owned !== (existing.owned ? 1 : 0) ||
            rewatch !== (existing.rewatch_count || 0) ||
            favorite !== (existing.favorite ? 1 : 0) ||
            watchedInCinema !== (existing.watched_in_cinema ? 1 : 0) ||
            cinemaDate !== (existing.cinema_date || null) ||
            cinemaTime !== (existing.cinema_time || null) ||
            cinemaName !== (existing.cinema_name || null) ||
            (watchDate || null) !== (existing.watch_date || null) ||
            (currentSeason ?? null) !== (existing.current_season ?? null)
          ) {
            updateItemMergeStmt.run(
              bestStatus,
              rating,
              notes,
              owned,
              rewatch,
              favorite,
              watchedInCinema,
              cinemaDate,
              cinemaTime,
              cinemaName,
              currentSeason ?? null,
              watchDate,
              existing.id
            );
            changed.v = true;
          }

          // Episodes → OR watched, higher play count, merged notes; never downgrade.
          if (entry.type === 'show') {
            for (const ep of entry.episodes || []) {
              if (!Number.isInteger(ep.episode)) continue;
              const prev = findProgress.get(existing.id, ep.season, ep.episode);
              if (!prev) {
                insertProgressStmt.run(existing.id, ep.season, ep.episode, ep.play_count || 1, ep.watch_date || null, ep.notes || null);
                changed.v = true;
              } else {
                const wc = Math.max(prev.watch_count || 1, ep.play_count || 1);
                const mNotes = mergeNotes(prev.notes, ep.notes);
                if (wc !== (prev.watch_count || 1) || (mNotes || null) !== (prev.notes || null)) {
                  updateProgressMergeStmt.run(wc, mNotes, prev.id);
                  changed.v = true;
                }
              }
            }
          }

          ensureListMembership(entry, changed);

          if (changed.v) summary.merged += 1;
          else summary.unchanged += 1;
        }
      } catch (err) {
        summary.failed += 1;
        failures.push({
          title: entry.title || `${entry.type} ${entry.tmdb_id}`,
          reason: err.message || 'unknown error',
        });
      }
    }
    scheduleStatsRecompute(db);
  });

  run();
  return { summary, failures, newItems };
}

// Fire-and-forget: fetch TMDB metadata for the newly added titles, throttled, and
// backfill their real (localized) title/year/genres. Never blocks the response.
function queueMetadataFetch(newItems, logger) {
  if (!newItems.length) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    for (const it of newItems) {
      try {
        const meta = await ensureCached(it.type, it.tmdb_id);
        backfillItemMetaStmt.run(
          meta.title_it || meta.title_orig || 'Untitled',
          meta.title_orig || meta.title_it || 'Untitled',
          meta.year || '',
          JSON.stringify(meta.genres || []),
          it.id
        );
      } catch (err) {
        if (logger) logger.warn(`library import: metadata fetch failed for ${it.type} ${it.tmdb_id}: ${err.message}`);
      }
      await sleep(TMDB_IMPORT_INTERVAL_MS);
    }
    scheduleStatsRecompute(db);
  })().catch(() => {});
}

// ======================= ROUTES =======================
export default async function libraryRoutes(fastify) {
  // GET /api/library/export → the whole library as a downloadable XML file.
  fastify.get('/api/library/export', async (request, reply) => {
    const xml = buildExportXml(request.user.id);
    const date = new Date().toISOString().slice(0, 10);
    reply
      .header('Content-Type', 'application/xml; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="shelfit_library-${date}.xml"`)
      .header('Cache-Control', 'no-store');
    return xml;
  });

  // POST /api/library/import  (body: raw XML string) → validate, merge, summarize.
  // Raise the body cap above the global 512 KB: a full library export is XML and
  // can legitimately reach a few MB. 10 MB is comfortably beyond any real library
  // while still bounding memory use on a corrupt/oversized upload (rejected 413).
  fastify.post('/api/library/import', { bodyLimit: 10 * 1024 * 1024 }, async (request, reply) => {
    const xml = typeof request.body === 'string' ? request.body : '';
    const check = validateImport(xml);
    if (!check.ok) {
      reply.code(400);
      return { error: check.error };
    }
    let result;
    try {
      result = applyImport(check.entries, request.user.id);
    } catch (err) {
      // A catastrophic DB error → the transaction rolled back; nothing was written.
      fastify.log.error(err);
      reply.code(500);
      return { error: 'Import failed and was rolled back: no changes were made.' };
    }
    queueMetadataFetch(result.newItems, fastify.log);
    return {
      ok: true,
      added: result.summary.added,
      merged: result.summary.merged,
      unchanged: result.summary.unchanged,
      fetches_queued: result.newItems.length,
      failed: result.summary.failed,
      failures: result.failures,
    };
  });
}
