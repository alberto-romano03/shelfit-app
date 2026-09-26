// Fanart disc-art endpoint: GET /api/fanart/:tmdbId serves the cached Fanart.tv
// disc image for a movie or show when available, otherwise falls back to the
// locally cached poster. X-Fanart headers report whether the result was a hit.

import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from '../config.js';
import { ensureFanartDisc } from '../fanart.js';
import { ensureAsset } from '../cache.js';

// GET /api/fanart/:tmdbId?type=movie|show
// Returns the Fanart disc image (cached) if available, otherwise the local
// poster as a seamless fallback. Headers:
//   X-Fanart: hit | miss
//   X-Fanart-Kind: disc | thumb   (only meaningful on a hit)
export default async function fanartRoutes(fastify) {
  fastify.get('/api/fanart/:tmdbId', async (request, reply) => {
    const { tmdbId } = request.params;
    const type = request.query.type === 'show' ? 'show' : 'movie';
    if (!/^\d+$/.test(tmdbId)) {
      reply.code(400);
      return { error: 'invalid tmdb id' };
    }

    let result;
    try {
      result = await ensureFanartDisc(type, tmdbId, fastify.log);
    } catch {
      result = { hit: false, path: null, kind: type === 'movie' ? 'disc' : 'thumb' };
    }

    if (result.hit && result.path && fs.existsSync(result.path)) {
      const ext = path.extname(result.path).toLowerCase();
      const mime =
        ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : 'image/jpeg';
      reply
        .header('Content-Type', mime)
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .header('X-Fanart', 'hit')
        .header('X-Fanart-Kind', result.kind);
      return reply.send(fs.createReadStream(result.path));
    }

    // Fallback: the poster already cached locally (lazy-rebuild if missing).
    const folder = type === 'movie' ? 'movies' : 'shows';
    const rel = `${folder}/${tmdbId}/poster.webp`;
    let abs = path.join(CACHE_DIR, rel);
    if (!fs.existsSync(abs)) {
      try {
        abs = await ensureAsset(rel);
      } catch {
        abs = null;
      }
    }
    if (abs && fs.existsSync(abs)) {
      reply
        .header('Content-Type', 'image/webp')
        .header('Cache-Control', 'public, max-age=86400')
        .header('X-Fanart', 'miss');
      return reply.send(fs.createReadStream(abs));
    }

    reply.code(404).header('X-Fanart', 'miss');
    return { error: 'no image available' };
  });
}
