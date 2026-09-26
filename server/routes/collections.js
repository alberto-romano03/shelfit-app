// Movie-collection endpoints under /api/collections: groups the user's movies by
// their TMDB collection (with a standalone bucket for the rest), and serves one
// collection's full film list in release order, flagging which titles are owned.

import db from '../db.js';
import { readMetaSync, ensureMovieCollectionField } from '../cache.js';
import { ensureCollection } from '../collections.js';
import { IMG_SIZES } from '../tmdb.js';
import { clientAbortSignal } from '../http.js';

// Run `fn` over items with at most `limit` concurrent in-flight (bounded
// parallelism, so we don't fire dozens of TMDB calls at once or serialize them).
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Poster URL for a movie already in the library (served from the local cache).
function ownedPoster(tmdbId) {
  return `/assets/movies/${tmdbId}/poster.webp`;
}
// Poster URL for a title not yet cached — proxied through the search thumb route
// so the client never talks to the TMDB CDN directly.
function remotePoster(posterPath) {
  return posterPath
    ? `/api/search/thumb?size=${IMG_SIZES.poster}&path=${encodeURIComponent(posterPath)}`
    : null;
}

// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
const ownedMovieRowsStmt = db.prepare(
  "SELECT id, tmdb_id, title_it, status, rating FROM items WHERE type = 'movie'"
);
function ownedMovieRows() {
  return ownedMovieRowsStmt.all();
}

export default async function collectionRoutes(fastify) {
  // GET /api/collections
  // Groups the user's movies by TMDB collection, plus a standalone bucket.
  fastify.get('/api/collections', async (request, reply) => {
    const signal = clientAbortSignal(request, reply);
    const rows = ownedMovieRows();

    // First pass (sync): read metas, note which need a legacy backfill.
    const entries = rows.map((row) => {
      const meta = readMetaSync('movie', row.tmdb_id);
      return {
        row,
        meta,
        ref: meta ? meta.belongs_to_collection : undefined,
        movie: {
          item_id: row.id,
          tmdb_id: row.tmdb_id,
          title: row.title_it,
          year: meta ? meta.year : '',
          status: row.status,
          rating: row.rating,
          poster_url: ownedPoster(row.tmdb_id),
        },
      };
    });

    try {
      // Backfill legacy collection refs in parallel (bounded), persisted once.
      const legacy = entries.filter((e) => e.meta && e.ref === undefined);
      await mapLimit(legacy, 5, async (e) => {
        try {
          e.ref = await ensureMovieCollectionField(e.row.tmdb_id);
        } catch {
          e.ref = null;
        }
      });

      // Group.
      const groups = new Map(); // collectionId -> { ref, movies: [] }
      const standalone = [];
      for (const e of entries) {
        if (e.ref && e.ref.id) {
          if (!groups.has(e.ref.id)) groups.set(e.ref.id, { ref: e.ref, movies: [] });
          groups.get(e.ref.id).movies.push(e.movie);
        } else {
          standalone.push(e.movie);
        }
      }

      // Resolve totals for each collection in parallel (bounded).
      const groupList = [...groups.entries()];
      const collections = await mapLimit(groupList, 5, async ([id, group]) => {
        let total = group.movies.length;
        try {
          const detail = await ensureCollection(id, { signal });
          total = Math.max(detail.parts.length, group.movies.length);
        } catch (err) {
          fastify.log.warn(`collection ${id} detail fetch failed: ${err.message}`);
        }
        group.movies.sort((a, b) => String(a.year).localeCompare(String(b.year)));
        return {
          id,
          name: group.ref.name || 'Collection',
          poster_url: `/assets/collections/${id}/poster.webp`,
          owned: group.movies.length,
          total,
          owned_movies: group.movies,
        };
      });

      collections.sort((a, b) => a.name.localeCompare(b.name));
      standalone.sort((a, b) => a.title.localeCompare(b.title));
      return { collections, standalone };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        reply.hijack(); // client navigated away — stop silently
        return;
      }
      throw err;
    }
  });

  // GET /api/collections/:id  → full collection with every film in release order.
  fastify.get('/api/collections/:id', async (request, reply) => {
    const { id } = request.params;
    if (!/^\d+$/.test(id)) {
      reply.code(400);
      return { error: 'invalid collection id' };
    }

    let detail;
    try {
      detail = await ensureCollection(id);
    } catch (err) {
      fastify.log.error(err); // full detail stays in the server log only
      reply.code(502);
      return { error: 'failed to fetch collection' };
    }

    // Which of these films are already in the library?
    const owned = new Map(); // tmdb_id -> { item_id, status }
    for (const r of ownedMovieRows()) {
      owned.set(String(r.tmdb_id), { item_id: r.id, status: r.status });
    }

    let ownedCount = 0;
    const parts = detail.parts.map((p) => {
      const inLib = owned.get(p.tmdb_id);
      if (inLib) ownedCount++;
      return {
        tmdb_id: p.tmdb_id,
        title: p.title,
        year: p.year,
        overview: p.overview,
        in_library: !!inLib,
        item_id: inLib ? inLib.item_id : null,
        status: inLib ? inLib.status : null,
        poster_url: inLib ? ownedPoster(p.tmdb_id) : remotePoster(p.poster_path),
      };
    });

    return {
      id: detail.id,
      name: detail.name,
      overview: detail.overview,
      poster_url: `/assets/collections/${id}/poster.webp`,
      backdrop_url: detail.backdrop_path
        ? `/assets/collections/${id}/backdrop.webp`
        : null,
      owned: ownedCount,
      total: parts.length,
      parts,
    };
  });
}
