// "Back to the Shelf" endpoint: GET /api/shelf/random returns N distinct random
// already-watched titles of a type, each carrying its local poster and, when
// available, a Fanart disc/thumb descriptor so the client can render the disc
// instantly.

import db from '../db.js';
import { readMetaSync } from '../cache.js';
import { ensureFanartDisc } from '../fanart.js';

// "Back to the Shelf" random picks. Returns N distinct already-watched titles of
// a type, each carrying everything the disc needs to render instantly on the
// client: local poster, and (when it exists) the Fanart disc/thumb descriptor so
// the client knows which render path to take and can preload the right image.

function assetBase(type, tmdbId) {
  const folder = type === 'movie' ? 'movies' : 'shows';
  return `/assets/${folder}/${tmdbId}`;
}

// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
const watchedMoviesStmt = db.prepare(
  "SELECT id, tmdb_id, type, title_it, title_orig, rating FROM items WHERE user_id = ? AND type = 'movie' AND status = 'completed'"
);
const watchedShowsStmt = db.prepare(
  `SELECT i.id, i.tmdb_id, i.type, i.title_it, i.title_orig, i.rating
     FROM items i
    WHERE i.user_id = ? AND i.type = 'show'
      AND (i.status = 'completed'
           OR EXISTS (SELECT 1 FROM progress p WHERE p.item_id = i.id AND p.season > 0))`
);

// A member's already-watched rows for a type: completed movies; completed shows
// OR any show with at least one watched episode.
function watchedRows(type, userId) {
  return type === 'movie' ? watchedMoviesStmt.all(userId) : watchedShowsStmt.all(userId);
}

// Pick up to n distinct random rows (in-place shuffle by splice).
function pickDistinct(rows, n) {
  const pool = rows.slice();
  const out = [];
  while (pool.length && out.length < n) {
    const i = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

// Map a row to the shelf item shape, resolving (and warming) its Fanart art.
async function toShelfItem(row, logger) {
  const base = assetBase(row.type, row.tmdb_id);
  const meta = readMetaSync(row.type, row.tmdb_id);
  let fanart = null;
  try {
    const f = await ensureFanartDisc(row.type, row.tmdb_id, logger);
    if (f && f.hit) {
      fanart = { url: `/api/fanart/${row.tmdb_id}?type=${row.type}`, kind: f.kind };
    }
  } catch {
    /* no disc art — the client falls back to the poster */
  }
  return {
    id: row.id,
    tmdb_id: row.tmdb_id,
    type: row.type,
    title: row.title_it || row.title_orig || 'Untitled',
    year: meta ? meta.year : '',
    rating: row.rating || 0,
    poster_url: `${base}/poster.webp`,
    fanart, // { url, kind: 'disc' | 'thumb' } or null
  };
}

export default async function shelfRoutes(fastify) {
  // GET /api/shelf/random?count=3&type=movie|show
  fastify.get('/api/shelf/random', async (request) => {
    const type = request.query.type === 'show' ? 'show' : 'movie';
    let count = parseInt(request.query.count, 10);
    if (!Number.isFinite(count) || count < 1) count = 1;
    count = Math.min(count, 10);

    const rows = watchedRows(type, request.user.id);
    if (!rows.length) return { items: [] };

    const picks = pickDistinct(rows, count);
    // Resolve Fanart in parallel so first-open latency is one lookup, not N.
    const items = await Promise.all(picks.map((r) => toShelfItem(r, fastify.log)));
    return { items };
  });
}
