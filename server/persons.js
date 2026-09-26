// Lazy TMDB person cache. People have no other home in the schema, so this owns
// both the `persons` row (bio/birthday/credits JSON) and the cached profile
// image on disk. Populated on first access and refreshed once older than 7 days.
//
// Photo layout under data/cache/persons/:
//   {tmdbId}_custom.<ext> — user upload (takes priority; written by the route)
//   {tmdbId}.webp        — the cached TMDB profile image
// They're served by GET /api/persons/:tmdbId/photo rather than /assets/*, because
// that route rewrites .jpg → .webp and would never find the custom file.

import fs from 'node:fs';
import path from 'node:path';
import db from './db.js';
import { CACHE_DIR } from './config.js';
import { getPerson, getPersonCredits, IMG_SIZES } from './tmdb.js';
import { saveImage } from './cache.js';

export const PERSONS_DIR = path.join(CACHE_DIR, 'persons');
const FRESH_MS = 7 * 24 * 60 * 60 * 1000; // spec: cache is fresh for 7 days

const getPersonStmt = db.prepare('SELECT * FROM persons WHERE tmdb_id = ?');
const upsertPersonStmt = db.prepare(`
  INSERT INTO persons (tmdb_id, name, biography, birthday, place_of_birth, profile_path, credits, cached_at)
  VALUES (@tmdb_id, @name, @biography, @birthday, @place_of_birth, @profile_path, @credits, @cached_at)
  ON CONFLICT(tmdb_id) DO UPDATE SET
    name           = excluded.name,
    biography      = excluded.biography,
    birthday       = excluded.birthday,
    place_of_birth = excluded.place_of_birth,
    profile_path   = excluded.profile_path,
    credits        = excluded.credits,
    cached_at      = excluded.cached_at
`);

// A custom photo KEEPS THE FORMAT IT ARRIVED IN. It used to be written as
// `_custom.jpg` whatever the bytes actually were, and looked up by that one
// name — so a WebP was served with a JPEG content-type, and a WebP dropped into
// the folder by hand was never found at all.
const CUSTOM_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
const MIME_FOR_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
export const EXT_FOR_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export function customPhotoPath(tmdbId, ext = '.jpg') {
  return path.join(PERSONS_DIR, `${tmdbId}_custom${ext}`);
}

// The custom photo actually on disk, in whichever format it was saved — a file
// copied into the folder by hand counts exactly the same as an upload.
// Returns { file, mime }, or null when there is none.
export function findCustomPhoto(tmdbId) {
  for (const ext of CUSTOM_EXTS) {
    const file = customPhotoPath(tmdbId, ext);
    if (fs.existsSync(file)) return { file, mime: MIME_FOR_EXT[ext] };
  }
  return null;
}

// Drop every format of the custom photo — a new upload replaces whatever was
// there, so a PNG must not be left behind shadowing a fresh WebP.
export function removeCustomPhotos(tmdbId) {
  for (const ext of CUSTOM_EXTS) {
    fs.rmSync(customPhotoPath(tmdbId, ext), { force: true });
  }
}
export function tmdbPhotoPath(tmdbId) {
  return path.join(PERSONS_DIR, `${tmdbId}.webp`);
}
export function hasCustomPhoto(tmdbId) {
  return findCustomPhoto(tmdbId) !== null;
}

// Shape a DB row into the API response (credits parsed back from JSON).
function shape(row) {
  let credits = { cast: [], crew: [] };
  if (row.credits) {
    try {
      credits = JSON.parse(row.credits);
    } catch {
      /* corrupt cache → treat as empty; the next refresh rewrites it */
    }
  }
  return {
    tmdb_id: row.tmdb_id,
    name: row.name || '',
    biography: row.biography || '',
    birthday: row.birthday || null,
    place_of_birth: row.place_of_birth || null,
    profile_path: row.profile_path || null,
    has_custom_photo: hasCustomPhoto(row.tmdb_id),
    photo_url: `/api/persons/${row.tmdb_id}/photo`,
    credits,
    cached_at: row.cached_at,
  };
}

// Concurrent opens of the same person share one build (mirrors cache.js's
// inflightBuilds idiom) so a double-tap can't fire two TMDB round-trips.
const inflight = new Map();

async function build(tmdbId, { signal } = {}) {
  const [person, credits] = await Promise.all([
    getPerson(tmdbId, { signal }),
    getPersonCredits(tmdbId, { signal }).catch(() => ({ cast: [], crew: [] })),
  ]);
  upsertPersonStmt.run({
    tmdb_id: tmdbId,
    name: person.name || '',
    biography: person.biography || '',
    birthday: person.birthday || null,
    place_of_birth: person.place_of_birth || null,
    profile_path: person.profile_path || null,
    credits: JSON.stringify({ cast: credits.cast || [], crew: credits.crew || [] }),
    cached_at: Date.now(),
  });
  // Cache the profile image alongside the row (best-effort — a missing image
  // must never fail the person load; the photo route falls back to 404).
  if (person.profile_path) {
    try {
      await saveImage(PERSONS_DIR, `${tmdbId}.webp`, IMG_SIZES.profile, person.profile_path, {
        signal,
        maxWidth: 500,
      });
    } catch {
      /* image is optional */
    }
  }
  return shape(getPersonStmt.get(tmdbId));
}

// Return a person from cache, fetching/refreshing from TMDB when missing or
// older than 7 days. If a refresh fails but we still hold a stale row, serve the
// stale copy rather than erroring — offline/over-budget should degrade, not break.
export async function ensurePerson(tmdbId, { force = false, signal } = {}) {
  const id = Number(tmdbId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const row = getPersonStmt.get(id);
  const fresh = row && row.cached_at && Date.now() - row.cached_at < FRESH_MS;
  if (row && fresh && !force) return shape(row);

  if (inflight.has(id)) return inflight.get(id);
  const p = build(id, { signal }).finally(() => inflight.delete(id));
  inflight.set(id, p);
  try {
    return await p;
  } catch (err) {
    if (row) return shape(row); // stale-but-usable beats an error
    throw err;
  }
}

// Cached row without touching TMDB (null when never fetched). Used by the
// favorites endpoint so rendering The Wall never triggers a network call.
export function readPersonSync(tmdbId) {
  const row = getPersonStmt.get(Number(tmdbId));
  return row ? shape(row) : null;
}
