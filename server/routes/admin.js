// Cache administration HTTP API under /api/admin/cache: reports on-disk and
// in-RAM image cache stats, wipes all or a single title's cached media, forces a
// meta re-download for one title, and bulk-refreshes ongoing (watching/paused)
// series. Type and TMDB-id params are validated before any cache path is touched.

import db from '../db.js';
import {
  getCacheBreakdown,
  clearAllCache,
  clearItemCache,
  ensureCached,
} from '../cache.js';
import { imageRamCache } from '../imageRamCache.js';

// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
const ongoingShowsStmt = db.prepare(
  "SELECT tmdb_id FROM items WHERE type = 'show' AND status IN ('watching','paused')"
);

// Accept singular or plural type names ('movie'/'movies').
function normType(t) {
  if (t === 'movie' || t === 'movies') return 'movie';
  if (t === 'show' || t === 'shows') return 'show';
  return null;
}

// TMDB ids are numeric. Reject anything else so a crafted param (e.g. '..') can
// never reach a filesystem path in clearItemCache / ensureCached.
function validTmdbId(id) {
  return typeof id === 'string' && /^\d+$/.test(id);
}

export default async function adminRoutes(fastify) {
  // GET /api/admin/cache/stats — on-demand only (the client calls it when the
  // user taps "Check cache"; nothing computes this automatically).
  fastify.get('/api/admin/cache/stats', async () => {
    return getCacheBreakdown();
  });

  // GET /api/admin/cache/ram → in-memory image cache stats (size, entries, hit rate).
  fastify.get('/api/admin/cache/ram', async () => {
    return imageRamCache.stats();
  });

  // DELETE /api/admin/cache → wipe all cached media (keeps the database).
  fastify.delete('/api/admin/cache', async () => {
    clearAllCache();
    return { ok: true };
  });

  // DELETE /api/admin/cache/:type/:tmdb_id → wipe one title's cache.
  fastify.delete('/api/admin/cache/:type/:tmdb_id', async (request, reply) => {
    const type = normType(request.params.type);
    if (!type || !validTmdbId(request.params.tmdb_id)) {
      reply.code(400);
      return { error: 'invalid type or id' };
    }
    clearItemCache(type, request.params.tmdb_id);
    return { ok: true };
  });

  // POST /api/admin/cache/:type/:tmdb_id/refresh → force re-download meta.
  fastify.post(
    '/api/admin/cache/:type/:tmdb_id/refresh',
    async (request, reply) => {
      const type = normType(request.params.type);
      if (!type || !validTmdbId(request.params.tmdb_id)) {
        reply.code(400);
        return { error: 'invalid type or id' };
      }
      try {
        await ensureCached(type, request.params.tmdb_id, { force: true });
      } catch (err) {
        fastify.log.error(err); // full detail stays in the server log only
        reply.code(502);
        return { error: 'refresh failed' };
      }
      return { ok: true };
    }
  );

  // POST /api/admin/cache/refresh-ongoing → force refresh all watching/paused
  // series (new seasons/episodes).
  fastify.post('/api/admin/cache/refresh-ongoing', async () => {
    const shows = ongoingShowsStmt.all();
    let refreshed = 0;
    let failed = 0;
    for (const s of shows) {
      try {
        await ensureCached('show', s.tmdb_id, { force: true });
        refreshed += 1;
      } catch (err) {
        failed += 1;
        fastify.log.warn(`refresh failed for show ${s.tmdb_id}: ${err.message}`);
      }
    }
    return { ok: true, refreshed, failed, total: shows.length };
  });
}
