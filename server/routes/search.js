// Title search under /api/search: queries TMDB for movies and/or shows (or an
// exact IMDb-id lookup), normalizing results and flagging which are already in
// the library. With `scope=library` it searches the user's own rows instead and
// never calls TMDB. /api/search/thumb proxies TMDB poster thumbnails so the
// client never talks to the TMDB CDN directly.

import db from '../db.js';
import {
  searchMovie,
  searchTv,
  findByImdb,
  imageUrl,
  IMG_SIZES,
} from '../tmdb.js';
import { imageVersion } from '../customImages.js';

const IMDB_RE = /^tt\d+$/i;

// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
// The signed-in member's titles, for the "already added" flags on TMDB results.
const allItemsStmt = db.prepare('SELECT id, tmdb_id, type FROM items WHERE user_id = ?');

// The library half of the search box (the "my collection only" toggle). This
// never touches TMDB: it reads the rows the user already owns, so the answer is
// instant, costs nothing against the monthly budget, and still works offline.
// LIKE is case-insensitive for ASCII in SQLite; accented letters still have to
// match their own case.
const libraryStmt = db.prepare(
  `SELECT id, tmdb_id, type, title_it, title_orig, year
     FROM items
    WHERE user_id = ? AND (title_it LIKE ? OR title_orig LIKE ?)
    ORDER BY title_it
    LIMIT 60`
);

// Same shape the TMDB mappers produce, so the client renders one kind of result.
// The poster is the cached file, carrying a version when the user replaced it
// (assets are served immutable, so the URL has to change or the browser keeps
// the copy it already has).
function mapLibraryRow(row) {
  const folder = row.type === 'movie' ? 'movies' : 'shows';
  const v = imageVersion(row.type, row.tmdb_id, 'poster');
  return {
    tmdb_id: String(row.tmdb_id),
    type: row.type,
    title: row.title_it || row.title_orig || '',
    original_title: row.title_orig || '',
    year: row.year || '',
    overview: '',
    poster_path: null,
    thumb_url: `/assets/${folder}/${row.tmdb_id}/poster.webp${v ? `?v=${v}` : ''}`,
    already_added: true,
    item_id: row.id,
  };
}

// Map a raw TMDB movie result to our normalized search shape.
function mapMovie(r, addedMap) {
  const tmdbId = String(r.id);
  const key = `movie:${tmdbId}`;
  const added = addedMap.get(key);
  return {
    tmdb_id: tmdbId,
    type: 'movie',
    title: r.title || r.original_title || '',
    original_title: r.original_title || '',
    year: r.release_date ? r.release_date.slice(0, 4) : '',
    overview: r.overview || '',
    poster_path: r.poster_path || null,
    thumb_url: r.poster_path
      ? `/api/search/thumb?size=${IMG_SIZES.poster}&path=${encodeURIComponent(r.poster_path)}`
      : null,
    already_added: !!added,
    item_id: added ? added.id : null,
  };
}

function mapShow(r, addedMap) {
  const tmdbId = String(r.id);
  const key = `show:${tmdbId}`;
  const added = addedMap.get(key);
  return {
    tmdb_id: tmdbId,
    type: 'show',
    title: r.name || r.original_name || '',
    original_title: r.original_name || '',
    year: r.first_air_date ? r.first_air_date.slice(0, 4) : '',
    overview: r.overview || '',
    poster_path: r.poster_path || null,
    thumb_url: r.poster_path
      ? `/api/search/thumb?size=${IMG_SIZES.poster}&path=${encodeURIComponent(r.poster_path)}`
      : null,
    already_added: !!added,
    item_id: added ? added.id : null,
  };
}

function buildAddedMap(userId) {
  const rows = allItemsStmt.all(userId);
  const map = new Map();
  for (const row of rows) map.set(`${row.type}:${row.tmdb_id}`, row);
  return map;
}

export default async function searchRoutes(fastify) {
  // GET /api/search?q=&type=movie|show|all&scope=library
  fastify.get('/api/search', async (request, reply) => {
    const q = (request.query.q || '').trim();
    const type = request.query.type || 'all';
    if (!q) return { results: [] };

    // Library scope: answered entirely from the local rows.
    if (request.query.scope === 'library') {
      const like = `%${q}%`;
      const rows = libraryStmt.all(request.user.id, like, like);
      const results = rows
        .filter((r) => type === 'all' || r.type === type)
        .map(mapLibraryRow);
      return { results };
    }

    const addedMap = buildAddedMap(request.user.id);
    let results = [];

    try {
      if (IMDB_RE.test(q)) {
        // Exact match via IMDb id.
        const { movies, shows } = await findByImdb(q);
        if (type === 'movie' || type === 'all') {
          results.push(...movies.map((r) => mapMovie(r, addedMap)));
        }
        if (type === 'show' || type === 'all') {
          results.push(...shows.map((r) => mapShow(r, addedMap)));
        }
      } else {
        if (type === 'movie' || type === 'all') {
          const movies = await searchMovie(q);
          results.push(...movies.map((r) => mapMovie(r, addedMap)));
        }
        if (type === 'show' || type === 'all') {
          const shows = await searchTv(q);
          results.push(...shows.map((r) => mapShow(r, addedMap)));
        }
      }
    } catch (err) {
      if (err && err.capReached) {
        reply.code(429);
        return { error: 'TMDB monthly budget reached', capReached: true, results: [] };
      }
      fastify.log.error(err); // full detail stays in the server log only
      reply.code(502);
      return { error: 'TMDB search failed', results: [] };
    }

    return { results };
  });

  // Thumbnail proxy for search previews (titles not yet cached locally).
  // Keeps the phone off the TMDB CDN, consistent with the caching design.
  fastify.get('/api/search/thumb', async (request, reply) => {
    const { size, path: imgPath } = request.query;
    if (!imgPath || imgPath.includes('..') || !/^\/[\w./-]+$/.test(imgPath)) {
      reply.code(400);
      return { error: 'invalid path' };
    }
    const safeSize = /^w\d+$/.test(size || '') ? size : IMG_SIZES.poster;
    const url = imageUrl(safeSize, imgPath);
    try {
      const { default: fetch } = await import('node-fetch');
      // Bound the upstream call so a stalled CDN connection can't hang the
      // handler (consistent with every other external fetch in the backend).
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        reply.code(404);
        return { error: 'not found' };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      reply
        .header('Content-Type', res.headers.get('content-type') || 'image/jpeg')
        .header('Cache-Control', 'public, max-age=86400');
      return reply.send(buf);
    } catch (err) {
      reply.code(502);
      return { error: 'thumb proxy failed' };
    }
  });
}
