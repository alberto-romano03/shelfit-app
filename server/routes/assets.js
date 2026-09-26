// Cached-image delivery under /assets/*: serves poster/backdrop/still WebP files,
// lazily re-downloading any that are missing. Small images are served from an
// in-RAM cache (zero disk I/O) with long-lived immutable headers; large files
// stream straight from disk. Traversal and unexpected roots are rejected.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureAsset } from '../cache.js';
import { sniffMime } from '../images.js';
import { clientAbortSignal } from '../http.js';
import { CACHE_DIR } from '../config.js';
import { imageRamCache } from '../imageRamCache.js';
import { safePath } from '../security.js';

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
};

// Cached images are WebP (.webp). We still detect the type from the file header
// so a fallback file written as original bytes (when cwebp is unavailable) is
// served with the correct MIME regardless of its name.
//
// The sniff result is memoized per path: cached image content is immutable, and
// /assets/* is by far the highest-volume endpoint (every poster/backdrop/still),
// so this turns a synchronous file read on every repeat request into one read
// per file for the life of the process. Bounded to keep memory in check.
const mimeCache = new Map();
const MIME_CACHE_MAX = 4096;
function detectMime(abs) {
  const cached = mimeCache.get(abs);
  if (cached) return cached;
  let mime;
  try {
    const fd = fs.openSync(abs, 'r');
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    fs.closeSync(fd);
    mime = sniffMime(header);
  } catch {
    /* fall through to extension */
  }
  mime = mime || MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  if (mimeCache.size >= MIME_CACHE_MAX) mimeCache.clear(); // simple bound
  mimeCache.set(abs, mime);
  return mime;
}

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

export default async function assetRoutes(fastify) {
  // GET /assets/*  → serve a cached image, lazily re-downloading if missing.
  fastify.get('/assets/*', async (request, reply) => {
    const rel = request.params['*'] || '';

    // Reject traversal / unexpected roots.
    if (rel.includes('..') || !/^(movies|shows|collections)\//.test(rel)) {
      reply.code(400);
      return { error: 'invalid asset path' };
    }

    // Fast path: serve from the in-RAM image cache with ZERO disk I/O. The key is
    // the exact on-disk path the pipeline writes to (and invalidates), so a hit
    // here is always a valid, current image. Headers match the disk path exactly,
    // so the client can't tell RAM from disk.
    //
    // safePath is a second, canonical guard on top of the textual `..` check
    // above: it resolves the final path and refuses anything that escapes
    // CACHE_DIR (throws a 400 via its statusCode), so no crafted input can reach
    // a file outside the cache even if it slips past the regex.
    let abs;
    try {
      abs = safePath(CACHE_DIR, rel.replace(/\.jpg$/i, '.webp'));
    } catch {
      reply.code(400);
      return { error: 'invalid asset path' };
    }
    const cached = imageRamCache.get(abs);
    if (cached) {
      reply
        .header('Content-Type', cached.mime)
        .header('Cache-Control', CACHE_CONTROL)
        .header('ETag', cached.etag);
      return reply.send(cached.buf);
    }

    // Miss: lazily (re)build if the file is absent, then serve from disk and
    // populate the cache. Cancel the (possibly large) rebuild if the client goes away.
    const signal = clientAbortSignal(request, reply);
    let resolved;
    try {
      resolved = await ensureAsset(rel, { signal });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        reply.hijack();
        return;
      }
      fastify.log.warn(`asset build failed for ${rel}: ${err.message}`);
      resolved = null;
    }
    if (signal.aborted) {
      reply.hijack(); // navigated away mid-rebuild — don't respond
      return;
    }

    if (!resolved) {
      // Missing on TMDB too — client renders an SVG placeholder.
      reply.code(404);
      return { error: 'asset not available' };
    }

    let st;
    try {
      st = await fsp.stat(resolved);
    } catch {
      reply.code(404);
      return { error: 'asset not available' };
    }
    const mime = detectMime(resolved);
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    reply.header('Content-Type', mime).header('Cache-Control', CACHE_CONTROL).header('ETag', etag);

    // Small images → read into RAM, serve the buffer, and cache it. Large files
    // (e.g. big backdrops) → stream straight from disk, never cached.
    if (st.size <= imageRamCache.PER_FILE_MAX && mime.startsWith('image/')) {
      const buf = await fsp.readFile(resolved);
      imageRamCache.set(resolved, buf, { mime, etag });
      return reply.send(buf);
    }
    return reply.send(fs.createReadStream(resolved));
  });
}
