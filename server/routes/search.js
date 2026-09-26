// Title search under /api/search: queries TMDB for movies and/or shows (or an
// exact IMDb-id lookup), normalizing results and flagging which are already in
// the library. /api/search/thumb proxies TMDB poster thumbnails so the client
// never talks to the TMDB CDN directly.

import db from '../db.js';
import {
  searchMovie,
  searchTv,
  findByImdb,
  imageUrl,
  IMG_SIZES,
} from '../tmdb.js';

const IMDB_RE = /^tt\d+$/i;

// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
const allItemsStmt = db.prepare('SELECT id, tmdb_id, type FROM items');

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

function buildAddedMap() {
  const rows = allItemsStmt.all();
  const map = new Map();
  for (const row of rows) map.set(`${row.type}:${row.tmdb_id}`, row);
  return map;
}

export default async function searchRoutes(fastify) {
  // GET /api/search?q=&type=movie|show|all
  fastify.get('/api/search', async (request, reply) => {
    const q = (request.query.q || '').trim();
    const type = request.query.type || 'all';
    if (!q) return { results: [] };

    const addedMap = buildAddedMap();
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
