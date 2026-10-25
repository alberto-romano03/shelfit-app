// User-chosen artwork. A title's poster, backdrop and disc art normally come
// from TMDB / Fanart.tv and are replaced whenever the cache is rebuilt. When a
// member picks an image themselves (Detail options, "Change images"), that slot is
// flagged here and every later refresh leaves its file alone.
//
// Artwork is a household choice, shared like the cache it lives in: one row per
// overridden slot in `title_art`, keyed by title (type + TMDB id) rather than by
// anyone's library entry, holding the timestamp it was set.
//
// The image itself is written to the slot's normal cache path, so nothing
// downstream changes: same URL, same asset route, same RAM cache.
import db from './db.js';

export const IMAGE_SLOTS = ['poster', 'backdrop', 'fanart'];

export function isSlot(slot) {
  return IMAGE_SLOTS.includes(slot);
}

// Prepared once at module load (better-sqlite3 compiles on prepare).
const selectStmt = db.prepare('SELECT slot, updated_at FROM title_art WHERE type = ? AND tmdb_id = ?');
const versionStmt = db.prepare(
  'SELECT updated_at FROM title_art WHERE type = ? AND tmdb_id = ? AND slot = ?'
);
const setStmt = db.prepare(
  `INSERT INTO title_art (type, tmdb_id, slot, updated_at) VALUES (?, ?, ?, datetime('now'))
   ON CONFLICT(type, tmdb_id, slot) DO UPDATE SET updated_at = excluded.updated_at`
);
const clearStmt = db.prepare('DELETE FROM title_art WHERE type = ? AND tmdb_id = ? AND slot = ?');
const clearAllStmt = db.prepare('DELETE FROM title_art WHERE type = ? AND tmdb_id = ?');

// Which slots this title overrides. Always returns all three keys, so callers
// can read `.poster` without a null check.
export function customSlots(type, tmdbId) {
  const out = { poster: false, backdrop: false, fanart: false };
  try {
    for (const row of selectStmt.all(type, String(tmdbId))) out[row.slot] = true;
  } catch {
    /* table unreadable: treat as no overrides */
  }
  return out;
}

// A cache-busting token for a slot, taken from the timestamp it was set.
// Cached artwork is served `immutable` (see routes/assets.js), so replacing the
// file on disk is invisible to a browser that already has it: the URL itself has
// to change. Empty string when the slot is not overridden, which returns the URL
// to its plain form and lets the original cached copy stand.
export function imageVersion(type, tmdbId, slot) {
  if (!isSlot(slot)) return '';
  const row = versionStmt.get(type, String(tmdbId), slot);
  return row ? String(row.updated_at).replace(/\D/g, '') : '';
}

export function isCustom(type, tmdbId, slot) {
  return !!customSlots(type, tmdbId)[slot];
}

export function setCustom(type, tmdbId, slot) {
  if (!isSlot(slot)) return;
  setStmt.run(type, String(tmdbId), slot);
}

export function clearCustom(type, tmdbId, slot) {
  if (!isSlot(slot)) return;
  clearStmt.run(type, String(tmdbId), slot);
}

// Called when a title's cached files are deleted: the custom bytes went with
// them, so the flags would otherwise claim an override that no longer exists.
export function clearAllCustom(type, tmdbId) {
  try {
    clearAllStmt.run(type, String(tmdbId));
  } catch {
    /* nothing to clear */
  }
}
