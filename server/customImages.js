// User-chosen artwork. A title's poster, backdrop and disc art normally come
// from TMDB / Fanart.tv and are replaced whenever the cache is rebuilt. When the
// user picks an image themselves (Detail options, "Change images"), that slot is
// flagged here and every later refresh leaves its file alone.
//
// The flag is one nullable TEXT column per slot on `items`, holding the ISO
// timestamp it was set (NULL = no override). Three columns rather than one JSON
// blob so the refresh guard in cache.js stays a plain lookup, matching how
// `favorite`, `owned` and the cinema fields are stored.
//
// The image itself is written to the slot's normal cache path, so nothing
// downstream changes: same URL, same asset route, same RAM cache.
import db from './db.js';

export const IMAGE_SLOTS = ['poster', 'backdrop', 'fanart'];

const COLUMN = {
  poster: 'custom_poster',
  backdrop: 'custom_backdrop',
  fanart: 'custom_fanart',
};

export function isSlot(slot) {
  return Object.prototype.hasOwnProperty.call(COLUMN, slot);
}

// Prepared once per slot at module load (better-sqlite3 compiles on prepare).
const selectStmt = db.prepare(
  'SELECT custom_poster, custom_backdrop, custom_fanart FROM items WHERE tmdb_id = ? AND type = ?'
);
const setStmt = {};
const clearStmt = {};
for (const slot of IMAGE_SLOTS) {
  setStmt[slot] = db.prepare(
    `UPDATE items SET ${COLUMN[slot]} = datetime('now') WHERE tmdb_id = ? AND type = ?`
  );
  clearStmt[slot] = db.prepare(
    `UPDATE items SET ${COLUMN[slot]} = NULL WHERE tmdb_id = ? AND type = ?`
  );
}
const clearAllStmt = db.prepare(
  'UPDATE items SET custom_poster = NULL, custom_backdrop = NULL, custom_fanart = NULL' +
    ' WHERE tmdb_id = ? AND type = ?'
);

// Which slots this title overrides. Always returns all three keys, so callers
// can read `.poster` without a null check. A title that is only cached (not in
// the library) has no row and therefore no overrides.
export function customSlots(type, tmdbId) {
  try {
    const row = selectStmt.get(String(tmdbId), type);
    return {
      poster: !!(row && row.custom_poster),
      backdrop: !!(row && row.custom_backdrop),
      fanart: !!(row && row.custom_fanart),
    };
  } catch {
    return { poster: false, backdrop: false, fanart: false };
  }
}

// A cache-busting token for a slot, taken from the timestamp the user set it.
// Cached artwork is served `immutable` (see routes/assets.js), so replacing the
// file on disk is invisible to a browser that already has it: the URL itself has
// to change. Empty string when the slot is not overridden, which returns the URL
// to its plain form and lets the original cached copy stand.
export function imageVersion(row, slot) {
  if (!row || !isSlot(slot)) return '';
  const stamp = row[COLUMN[slot]];
  return stamp ? String(stamp).replace(/\D/g, '') : '';
}

export function isCustom(type, tmdbId, slot) {
  return !!customSlots(type, tmdbId)[slot];
}

export function setCustom(type, tmdbId, slot) {
  if (!isSlot(slot)) return;
  setStmt[slot].run(String(tmdbId), type);
}

export function clearCustom(type, tmdbId, slot) {
  if (!isSlot(slot)) return;
  clearStmt[slot].run(String(tmdbId), type);
}

// Called when a title's cached files are deleted: the custom bytes went with
// them, so the flags would otherwise claim an override that no longer exists.
export function clearAllCustom(type, tmdbId) {
  try {
    clearAllStmt.run(String(tmdbId), type);
  } catch {
    /* no row for this title - nothing to clear */
  }
}
