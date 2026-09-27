// Custom artwork endpoints under /api/media/:type/:tmdbId/images/:slot.
//
//   GET    → the images the user can choose from for that slot
//   PUT    → replace the slot with the image the user cropped
//   DELETE → drop the override and restore the default
//
// Slots are poster, backdrop and fanart. Poster and backdrop candidates come
// from TMDB; disc art has no TMDB equivalent, so fanart candidates come from
// Fanart.tv, the same source (and the same ordering) the automatic disc picker
// already uses.
//
// The client sends an image it has ALREADY cropped to the slot's aspect ratio,
// so nothing here crops. The bytes go through toWebp(), exactly as every cached
// TMDB image does, and are written to the slot's normal cache path, so no new
// URL, asset route or cache invalidation is involved.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR } from '../config.js';
import { getImages, imageUrl, IMG_SIZES } from '../tmdb.js';
import { listFanartCandidates, fanartImagePath, clearFanartCache } from '../fanart.js';
import { ensureAsset, ensureCached, saveImage, itemDir } from '../cache.js';
import { toWebp } from '../images.js';
import { imageRamCache } from '../imageRamCache.js';
import { isSlot, setCustom, clearCustom, customSlots } from '../customImages.js';

// The quality every cached image is written at (see saveImage in cache.js).
const WEBP_QUALITY = 62;

// A cropped backdrop can exceed the global 512 KB body limit once base64 adds
// its third, so this route raises it the way the photo uploads do.
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

// Per slot: the width the stored file is capped to (matching what the rest of
// the cache stores) and where it lives on disk.
const SLOT = {
  poster: { maxWidth: 500, file: 'poster.webp' },
  backdrop: { maxWidth: 900, file: 'backdrop.webp' },
  fanart: { maxWidth: 640, file: null }, // lives under cache/fanart, not the item dir
};

function normType(t) {
  if (t === 'movie' || t === 'movies') return 'movie';
  if (t === 'show' || t === 'shows') return 'show';
  return null;
}

// TMDB ids are numeric. Reject anything else before it reaches a cache path.
function validTmdbId(id) {
  return typeof id === 'string' && /^\d+$/.test(id);
}

// Absolute path of the file a slot is stored as.
function slotPath(type, tmdbId, slot) {
  if (slot === 'fanart') return fanartImagePath(tmdbId);
  return path.join(itemDir(type, tmdbId), SLOT[slot].file);
}

// Decode the `data:image/...;base64,...` payload the crop tool produces. Returns
// null for anything that is not a plausible image data URL.
function decodeDataUrl(value) {
  if (typeof value !== 'string') return null;
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value.trim());
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  return buf.length ? buf : null;
}

export default async function imageRoutes(fastify) {
  // GET /api/media/:type/:tmdbId/images/:slot
  // → { slot, custom, candidates: [{ url, thumb, w, h }] }
  // `url` is what the crop tool loads (the largest sensible source), `thumb`
  // what the grid shows.
  fastify.get('/api/media/:type/:tmdbId/images/:slot', async (request, reply) => {
    const type = normType(request.params.type);
    const { tmdbId, slot } = request.params;
    if (!type || !validTmdbId(tmdbId) || !isSlot(slot)) {
      reply.code(400);
      return { error: 'invalid type, id or slot' };
    }

    if (slot === 'fanart') {
      const list = await listFanartCandidates(type, tmdbId, fastify.log);
      return {
        slot,
        custom: customSlots(type, tmdbId)[slot],
        // Fanart serves one size only, so the grid and the crop tool share it.
        candidates: list.map((c) => ({ url: c.url, thumb: c.url, w: null, h: null })),
      };
    }

    const kind = type === 'movie' ? 'movie' : 'tv';
    let data;
    try {
      data = await getImages(kind, tmdbId);
    } catch (err) {
      fastify.log.warn(`tmdb images failed for ${type} ${tmdbId}: ${err.message}`);
      reply.code(502);
      return { error: 'could not load images' };
    }
    const raw = (slot === 'poster' ? data.posters : data.backdrops) || [];
    const thumbSize = slot === 'poster' ? IMG_SIZES.poster : IMG_SIZES.backdrop;
    return {
      slot,
      custom: customSlots(type, tmdbId)[slot],
      candidates: raw.slice(0, 60).map((c) => ({
        // 'original' for the crop so the user has real room to pan and zoom.
        url: imageUrl('original', c.file_path),
        thumb: imageUrl(thumbSize, c.file_path),
        w: c.width || null,
        h: c.height || null,
      })),
    };
  });

  // PUT /api/media/:type/:tmdbId/images/:slot   { image: '<data url>' }
  // The image is already cropped to the slot's ratio.
  fastify.put(
    '/api/media/:type/:tmdbId/images/:slot',
    { bodyLimit: MAX_UPLOAD_BYTES },
    async (request, reply) => {
      const type = normType(request.params.type);
      const { tmdbId, slot } = request.params;
      if (!type || !validTmdbId(tmdbId) || !isSlot(slot)) {
        reply.code(400);
        return { error: 'invalid type, id or slot' };
      }
      const buf = decodeDataUrl(request.body && request.body.image);
      if (!buf) {
        reply.code(400);
        return { error: 'invalid image' };
      }

      const target = slotPath(type, tmdbId, slot);
      try {
        // Disc art first: clear the raw fallback and the "no disc found" marker,
        // so nothing older than the new file can win when it is served.
        if (slot === 'fanart') await clearFanartCache(tmdbId).catch(() => {});
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const webp = await toWebp(buf, { quality: WEBP_QUALITY, maxWidth: SLOT[slot].maxWidth });
        await fsp.writeFile(target, webp || buf);
        imageRamCache.invalidate(target);
      } catch (err) {
        fastify.log.error(err);
        reply.code(500);
        return { error: 'could not save image' };
      }

      setCustom(type, tmdbId, slot);
      // Read the flag back rather than assuming: a title that is only cached and
      // not in the library has no row to flag, so its image is stored but never
      // protected from a refresh.
      return { ok: true, slot, custom: customSlots(type, tmdbId)[slot] };
    }
  );

  // DELETE /api/media/:type/:tmdbId/images/:slot
  // Drops the override and puts the default back immediately, rather than
  // leaving the user's image on screen until the next metadata refresh.
  fastify.delete('/api/media/:type/:tmdbId/images/:slot', async (request, reply) => {
    const type = normType(request.params.type);
    const { tmdbId, slot } = request.params;
    if (!type || !validTmdbId(tmdbId) || !isSlot(slot)) {
      reply.code(400);
      return { error: 'invalid type, id or slot' };
    }

    clearCustom(type, tmdbId, slot);
    try {
      if (slot === 'fanart') {
        // Removing every cached disc file is enough: the next request to
        // /api/fanart/:tmdbId re-fetches from Fanart.tv.
        await clearFanartCache(tmdbId);
      } else {
        const meta = await ensureCached(type, tmdbId);
        const src = slot === 'poster' ? meta.poster_path : meta.backdrop_path;
        const dir = itemDir(type, tmdbId);
        await saveImage(dir, SLOT[slot].file, IMG_SIZES[slot], src, {
          maxWidth: SLOT[slot].maxWidth,
        });
        // No TMDB image for this slot at all: drop the user's file so the UI
        // falls back the way an untouched title would.
        const folder = type === 'movie' ? 'movies' : 'shows';
        const rel = `${folder}/${tmdbId}/${SLOT[slot].file}`;
        if (!src) {
          await fsp.rm(path.join(CACHE_DIR, rel), { force: true }).catch(() => {});
        } else {
          await ensureAsset(rel).catch(() => {});
        }
        imageRamCache.invalidate(path.join(CACHE_DIR, rel));
      }
    } catch (err) {
      // The flag is already cleared, so the next refresh restores the default
      // even if this immediate attempt failed.
      fastify.log.warn(`image reset failed for ${type} ${tmdbId} ${slot}: ${err.message}`);
    }
    return { ok: true, slot, custom: false };
  });
}
