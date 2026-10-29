// Library export / import: a full, portable backup of everything a member did
// in their library (statuses, ratings, play counts, ownership, notes, watch and
// added dates, rewatches, cinema tickets, per-episode progress, lists, The Wall).
// Imported into an empty library it restores the previous state exactly; into a
// populated one it merges and never deletes. Metadata (posters, descriptions, cast…) is NEVER
// exported: it is always re-fetched from TMDB on import. XML is built and parsed
// with the project's existing dependency-free approach (string building + scoped
// regexes, mirroring server/importKodi.js); SHA-256 uses Node's crypto.

import crypto from 'node:crypto';
import db from '../db.js';
import { readMetaSync } from '../cache.js';
import { scheduleStatsRecompute } from '../stats.js';
import { enqueueMeta, metaState } from '../metaBackfill.js';

// v2 added the per-title fields introduced after the initial export shipped:
// favorite (movies + shows), the cinema screening fields watched_in_cinema /
// cinema_date / cinema_time / cinema_name (movies), and current_season (shows).
// v1 files still import cleanly — the new fields are simply absent and default
// to their empty/derived values, so the format stays additive and backward-
// compatible.
// v3 adds a per-movie <rewatches> block (one <rewatch date="…"/> per dated
// rewatch event). v1/v2 files still import cleanly — an absent block just means
// the movie keeps its play_count-derived rewatch count.
// v4 makes a restore onto an empty library an exact copy of the previous state:
//   • <added_at> per title (the "Recently added" order and the home's order),
//   • watched_at="…" per episode with the time of day (who you left off most
//     recently, in What's Next), next to the date-only watch_date older readers use,
//   • a <custom_lists> block with EVERY list, empty ones included, its creation
//     time and each title's added time (v1-v3 carried only per-title memberships),
//   • a <wall movie="…" show="…" person="…"/> element for The Wall.
// Deliberately left out: profile photo, cover and badge (the account's look, not
// the library), custom artwork (shared by the household), pending loans.
const EXPORT_VERSION = 4;
const SUPPORTED_VERSIONS = new Set([1, 2, 3, 4]);

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
const exportCustomListsStmt = db.prepare(
  'SELECT id, name, type, created_at FROM lists WHERE user_id = ? ORDER BY created_at, id'
);
const exportListItemsStmt = db.prepare(
  'SELECT tmdb_id, added_at FROM list_items WHERE list_id = ? ORDER BY added_at, id'
);
const exportWallStmt = db.prepare(
  `SELECT (SELECT tmdb_id FROM items WHERE id = f.movie_item_id AND user_id = f.user_id) AS movie,
          (SELECT tmdb_id FROM items WHERE id = f.show_item_id AND user_id = f.user_id) AS show,
          f.person_tmdb_id AS person
     FROM favorites f WHERE f.user_id = ?`
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
// The Wall: slots are filled only when empty, like every other merge here.
const getWallStmt = db.prepare('SELECT * FROM favorites WHERE user_id = ?');
const ensureWallStmt = db.prepare('INSERT OR IGNORE INTO favorites (user_id) VALUES (?)');
const setWallStmt = db.prepare(
  'UPDATE favorites SET movie_item_id = ?, show_item_id = ?, person_tmdb_id = ? WHERE user_id = ?'
);
const setAddedAtStmt = db.prepare('UPDATE items SET added_at = ? WHERE id = ?');
const findProgressStmt = db.prepare(
  'SELECT * FROM progress WHERE item_id = ? AND season = ? AND episode = ?'
);
const insertItemStmt = db.prepare(
  `INSERT INTO items
     (user_id, tmdb_id, type, title_it, title_orig, status, rating, notes, owned, rewatch_count,
      favorite, watched_in_cinema, cinema_date, cinema_time, cinema_name, current_season,
      watch_date, updated_at, added_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`
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
// A stored SQLite timestamp ('YYYY-MM-DD HH:MM:SS', or an ISO string, or a bare
// date). Anything else read from a file is dropped rather than written to the DB.
const STAMP_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z?)?$/;
function stampOrNull(v) {
  const s = String(v == null ? '' : v).trim();
  return STAMP_RE.test(s) ? s : null;
}
// Lists and list items store creation times as epoch milliseconds.
function msOrNull(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\d{1,15}$/.test(s) ? Number(s) : null;
}
function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// ======================= EXPORT =======================
function movieXml(it, rewatchDates) {
  const status = STATUS_DB_TO_XML[it.status] || 'plan';
  const watched = it.status === 'completed';
  const playCount = (it.rewatch_count || 0) + (watched ? 1 : 0);
  // Prefer the explicit editable watch_date; fall back to date(updated_at) for
  // pre-feature rows (same value the receipt uses).
  const watchDate = it.watch_date ? dateOnly(it.watch_date) : watched ? dateOnly(it.updated_at) : '';
  let s = `    <movie tmdb_id="${escXml(it.tmdb_id)}">\n`;
  s += `      <title>${escXml(it.title_it || '')}</title>\n`;
  s += `      <status>${status}</status>\n`;
  if (it.added_at) s += `      <added_at>${escXml(it.added_at)}</added_at>\n`;
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
  s += `    </movie>\n`;
  return s;
}

function showXml(it, eps) {
  const status = STATUS_DB_TO_XML[it.status] || 'plan';
  let s = `    <show tmdb_id="${escXml(it.tmdb_id)}">\n`;
  s += `      <title>${escXml(it.title_it || '')}</title>\n`;
  s += `      <status>${status}</status>\n`;
  if (it.added_at) s += `      <added_at>${escXml(it.added_at)}</added_at>\n`;
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
        // The full moment too (v4): What's Next orders series by it.
        if (e.watched_at && String(e.watched_at) !== wd) attrs.push(`watched_at="${escXml(e.watched_at)}"`);
        if (e.notes && e.notes.trim()) attrs.push(`notes="${escXml(e.notes)}"`);
        s += `          <episode ${attrs.join(' ')}/>\n`;
      }
      s += `        </season>\n`;
    }
    s += `      </seasons>\n`;
  }
  s += `    </show>\n`;
  return s;
}

// Every list (empty ones too) with its creation time and each title's added
// time, so a restore rebuilds them in the same order. Titles are referenced by
// TMDB id, like list_items itself.
function customListsXml(userId) {
  const lists = exportCustomListsStmt.all(userId);
  if (!lists.length) return '';
  let s = `    <custom_lists>\n`;
  for (const l of lists) {
    const items = exportListItemsStmt.all(l.id);
    const head = `<list name="${escXml(l.name)}" type="${escXml(l.type)}" created_at="${escXml(l.created_at)}"`;
    if (!items.length) {
      s += `      ${head}/>\n`;
      continue;
    }
    s += `      ${head}>\n`;
    for (const li of items) {
      s += `        <item tmdb_id="${escXml(li.tmdb_id)}" added_at="${escXml(li.added_at)}"/>\n`;
    }
    s += `      </list>\n`;
  }
  s += `    </custom_lists>\n`;
  return s;
}

function wallXml(userId) {
  const w = exportWallStmt.get(userId);
  if (!w || (!w.movie && !w.show && !w.person)) return '';
  const attrs = [];
  if (w.movie) attrs.push(`movie="${escXml(w.movie)}"`);
  if (w.show) attrs.push(`show="${escXml(w.show)}"`);
  if (w.person) attrs.push(`person="${escXml(w.person)}"`);
  return `    <wall ${attrs.join(' ')}/>\n`;
}

// Build the raw string that goes between <library> and </library>, plus the
// entry count (titles only). The checksum is computed over exactly this string.
function buildLibrary(userId) {
  const items = exportItemsStmt.all(userId);

  let inner = '';
  let count = 0;
  for (const it of items) {
    count += 1;
    if (it.type === 'movie') {
      const rewatchDates = exportRewatchesStmt.all(it.id).map((r) => dateOnly(r.watched_at)).filter(Boolean);
      inner += movieXml(it, rewatchDates);
    } else inner += showXml(it, exportProgressStmt.all(it.id));
  }
  inner += customListsXml(userId);
  inner += wallXml(userId);
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
      added_at: stampOrNull(tagText(b, 'added_at')),
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
          // v4 carries the full moment; older files only the date.
          watch_date: stampOrNull(attrOf(a, 'watched_at')) || attrOf(a, 'watch_date'),
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
      added_at: stampOrNull(tagText(b, 'added_at')),
      episodes,
      lists: parseListNames(b),
    });
  }
  return entries;
}

// v4 <custom_lists>: [{ name, type, created_at, items: [{ tmdb_id, added_at }] }].
function parseCustomLists(libraryContent) {
  const wrap = libraryContent.match(/<custom_lists>([\s\S]*?)<\/custom_lists>/);
  if (!wrap) return [];
  const out = [];
  const re = /<list\s+([^>]*?)(\/>|>([\s\S]*?)<\/list>)/g;
  let m;
  while ((m = re.exec(wrap[1]))) {
    const name = attrOf(m[1], 'name').trim();
    const type = attrOf(m[1], 'type');
    if (!name || (type !== 'movie' && type !== 'show')) continue;
    const items = [];
    const itemRe = /<item\s+([^>]*?)\/>/g;
    let im;
    while ((im = itemRe.exec(m[3] || ''))) {
      const tmdbId = attrOf(im[1], 'tmdb_id');
      if (/^\d+$/.test(tmdbId)) items.push({ tmdb_id: tmdbId, added_at: msOrNull(attrOf(im[1], 'added_at')) });
    }
    out.push({ name, type, created_at: msOrNull(attrOf(m[1], 'created_at')), items });
  }
  return out;
}

// v4 <wall movie="…" show="…" person="…"/> → TMDB ids (or null).
function parseWall(libraryContent) {
  const m = libraryContent.match(/<wall\s+([^>]*?)\/>/);
  if (!m) return null;
  const id = (name) => {
    const v = attrOf(m[1], name);
    return /^\d+$/.test(v) ? v : null;
  };
  return { movie: id('movie'), show: id('show'), person: id('person') };
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
  return {
    ok: true,
    version,
    entries,
    customLists: version >= 4 ? parseCustomLists(content) : [],
    wall: version >= 4 ? parseWall(content) : null,
  };
}

// Apply the parsed entries. Everything is one transaction; a per-entry failure is
// recorded and skipped (the rest still commit). Returns a summary + the list of
// newly-added items so metadata can be fetched in the background afterwards.
function applyImport(entries, userId, { customLists = [], wall = null } = {}) {
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
            updatedAt,
            entry.added_at || null
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
          // Added date → the earlier of the two: the title has been in the
          // library at least since then.
          if (entry.added_at && (!existing.added_at || entry.added_at < existing.added_at)) {
            setAddedAtStmt.run(entry.added_at, existing.id);
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

    // v4 lists: every list, empty ones too, with the original creation and
    // added times. An existing list of the same name and type is reused, and a
    // title already in it keeps its own added time (INSERT OR IGNORE).
    for (const l of customLists) {
      let list = findList.get(userId, l.name, l.type);
      if (!list) {
        const info = insertList.run(userId, l.name, l.type, l.created_at ?? Date.now());
        list = { id: info.lastInsertRowid };
      }
      for (const it of l.items) addListItem.run(list.id, Number(it.tmdb_id), it.added_at ?? Date.now());
    }

    // v4 The Wall: each slot is filled only when it is empty, and only with a
    // title that is now in this member's library (the slots point at items).
    if (wall && (wall.movie || wall.show || wall.person)) {
      ensureWallStmt.run(userId);
      const cur = getWallStmt.get(userId);
      const itemId = (type, tmdbId) => {
        if (!tmdbId) return null;
        const row = findItem.get(userId, type, String(tmdbId));
        return row ? row.id : null;
      };
      setWallStmt.run(
        cur.movie_item_id ?? itemId('movie', wall.movie),
        cur.show_item_id ?? itemId('show', wall.show),
        cur.person_tmdb_id ?? (wall.person ? Number(wall.person) : null),
        userId
      );
    }

    scheduleStatsRecompute(db);
  });

  run();
  return { summary, failures, newItems };
}

// The newly added titles get their real (localized) title, year and genres:
// straight from the shared cache when another member already has the title,
// otherwise through the metadata backfill, which downloads it in the background
// and survives a restart (see metaBackfill.js). Returns how many were queued.
const backfillItemMetaStmt = db.prepare(
  'UPDATE items SET title_it = ?, title_orig = ?, year = ?, genres = ? WHERE id = ?'
);
function fillNewItemsMeta(newItems) {
  let queued = 0;
  for (const it of newItems) {
    const meta = readMetaSync(it.type, it.tmdb_id);
    if (meta) {
      backfillItemMetaStmt.run(
        meta.title_it || meta.title_orig || 'Untitled',
        meta.title_orig || meta.title_it || 'Untitled',
        meta.year || '',
        JSON.stringify(meta.genres || []),
        it.id
      );
    }
    if (metaState(it.type, it.tmdb_id)) {
      enqueueMeta(it.type, it.tmdb_id);
      queued += 1;
    }
  }
  scheduleStatsRecompute(db);
  return queued;
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
      result = applyImport(check.entries, request.user.id, {
        customLists: check.customLists,
        wall: check.wall,
      });
    } catch (err) {
      // A catastrophic DB error → the transaction rolled back; nothing was written.
      fastify.log.error(err);
      reply.code(500);
      return { error: 'Import failed and was rolled back: no changes were made.' };
    }
    const queued = fillNewItemsMeta(result.newItems);
    return {
      ok: true,
      added: result.summary.added,
      merged: result.summary.merged,
      unchanged: result.summary.unchanged,
      fetches_queued: queued,
      failed: result.summary.failed,
      failures: result.failures,
    };
  });
}
