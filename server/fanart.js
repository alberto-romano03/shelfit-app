import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import fetch from 'node-fetch';
import { CACHE_DIR, FANART_API_KEY } from './config.js';
import { tmdbGet } from './tmdb.js';
import { toWebp } from './images.js';
import { allowed, record } from './usage.js';

const FANART_DIR = path.join(CACHE_DIR, 'fanart');
const FANART_BASE = 'https://webservice.fanart.tv/v3';

// Re-check a "no art" title at most once every 30 days (art can be added later).
const NONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Atomic write (temp + rename) so a crash/concurrent writer can't leave a
// truncated image that the existence check would then trust forever.
async function writeFileAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// True if the negative-cache marker exists and is still fresh.
function noneMarkerFresh(tmdbId) {
  try {
    const st = fs.statSync(noneMarker(tmdbId));
    return Date.now() - st.mtimeMs < NONE_TTL_MS;
  } catch {
    return false;
  }
}

// The disc/label is displayed small (~230px, ×2 retina ≈ 460px), so anything
// wider than this is downscaled during compression.
const MAX_WIDTH = 640;
const WEBP_QUALITY = 78;

// Cache files keyed by TMDB id. Compressed WebP is preferred; a plain copy is
// kept as a fallback when cwebp is unavailable.
function webpPath(tmdbId) {
  return path.join(FANART_DIR, `${tmdbId}.webp`);
}
function rawPath(tmdbId) {
  return path.join(FANART_DIR, `${tmdbId}.png`);
}
function noneMarker(tmdbId) {
  return path.join(FANART_DIR, `${tmdbId}.none`);
}

// Synchronous, network-free check: is a Fanart disc/thumb already cached on disk
// (downloaded earlier by "Back to the Shelf")? Used by the detail endpoint to
// decide between the real disc image and the poster-based disc fallback.
export function hasFanartDiscCached(tmdbId) {
  return fs.existsSync(webpPath(tmdbId)) || fs.existsSync(rawPath(tmdbId));
}

async function fetchBuffer(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

function pickMovieDisc(data) {
  const discs = data && data.moviedisc;
  if (!Array.isArray(discs) || !discs.length) return null;
  const sorted = discs.slice().sort((a, b) => {
    const la = a.lang === 'en' ? 1 : 0;
    const lb = b.lang === 'en' ? 1 : 0;
    if (la !== lb) return lb - la;
    return parseInt(b.likes || '0', 10) - parseInt(a.likes || '0', 10);
  });
  return sorted[0].url;
}

function pickTvAsset(data) {
  const order = ['tvthumb', 'hdclearart', 'clearart', 'hdtvlogo', 'clearlogo', 'tvposter'];
  for (const key of order) {
    const arr = data && data[key];
    if (Array.isArray(arr) && arr.length) {
      const sorted = arr
        .slice()
        .sort((a, b) => parseInt(b.likes || '0', 10) - parseInt(a.likes || '0', 10));
      return sorted[0].url;
    }
  }
  return null;
}

// Where a title's disc art lives once cached. The "Customize metadata" flow
// writes the user's own disc here, so /api/fanart/:tmdbId serves it unchanged.
export function fanartImagePath(tmdbId) {
  return webpPath(tmdbId);
}

// Drop every cached disc file for a title, including the "none found" marker, so
// the next request re-fetches from Fanart.tv. Used when a custom disc is reset.
export async function clearFanartCache(tmdbId) {
  for (const p of [webpPath(tmdbId), rawPath(tmdbId), noneMarker(tmdbId)]) {
    await fsp.rm(p, { force: true }).catch(() => {});
  }
}

// Every disc / label Fanart.tv holds for a title, for the "Customize metadata"
// picker. Same sources and the same ordering ensureFanartDisc picks its single
// winner from, only returned in full rather than reduced to sorted[0].
// Returns [] when the key is missing or the monthly budget is spent.
export async function listFanartCandidates(type, tmdbId, logger) {
  if (!FANART_API_KEY || !allowed('fanart')) return [];
  try {
    let data = null;
    if (type === 'movie') {
      record('fanart');
      const res = await fetch(`${FANART_BASE}/movies/${tmdbId}?api_key=${FANART_API_KEY}`, {
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) data = await res.json();
    } else {
      let tvdbId = null;
      try {
        const ext = await tmdbGet(`/tv/${tmdbId}/external_ids`);
        tvdbId = ext && ext.tvdb_id ? ext.tvdb_id : null;
      } catch {
        /* ignore - no external id, no candidates */
      }
      if (tvdbId) {
        record('fanart');
        const res = await fetch(`${FANART_BASE}/tv/${tvdbId}?api_key=${FANART_API_KEY}`, {
          signal: AbortSignal.timeout(20000),
        });
        if (res.ok) data = await res.json();
      }
    }
    if (!data) return [];

    const keys =
      type === 'movie'
        ? ['moviedisc']
        : ['tvthumb', 'hdclearart', 'clearart', 'hdtvlogo', 'clearlogo', 'tvposter'];
    const out = [];
    for (const key of keys) {
      const arr = data[key];
      if (!Array.isArray(arr)) continue;
      for (const a of arr) {
        if (a && a.url) out.push({ url: a.url, lang: a.lang || null, likes: parseInt(a.likes || '0', 10) });
      }
    }
    // English first, then most-liked - the order ensureFanartDisc already uses.
    out.sort((a, b) => {
      const la = a.lang === 'en' ? 1 : 0;
      const lb = b.lang === 'en' ? 1 : 0;
      if (la !== lb) return lb - la;
      return b.likes - a.likes;
    });
    return out.slice(0, 40);
  } catch (err) {
    if (logger) logger.warn(`fanart list failed for ${type} ${tmdbId}: ${err.message}`);
    return [];
  }
}

// Ensure a Fanart disc/label image is cached (compressed) for a title.
// Returns { hit, path, kind }: kind 'disc' (round movie disc) or 'thumb' (tv).
export async function ensureFanartDisc(type, tmdbId, logger) {
  await fsp.mkdir(FANART_DIR, { recursive: true });
  const kind = type === 'movie' ? 'disc' : 'thumb';

  if (fs.existsSync(webpPath(tmdbId))) return { hit: true, path: webpPath(tmdbId), kind };
  if (fs.existsSync(rawPath(tmdbId))) return { hit: true, path: rawPath(tmdbId), kind };
  if (noneMarkerFresh(tmdbId)) return { hit: false, path: null, kind }; // stale marker → re-check
  if (!FANART_API_KEY) return { hit: false, path: null, kind };
  // Monthly budget reached → skip the API entirely (disc art is decorative; the
  // detail view falls back to the poster-based disc). Not negative-cached, so it
  // resumes automatically next month or after an emergency bypass.
  if (!allowed('fanart')) return { hit: false, path: null, kind };

  try {
    let imageUrl = null;
    if (type === 'movie') {
      record('fanart'); // count the outbound webservice call
      const res = await fetch(`${FANART_BASE}/movies/${tmdbId}?api_key=${FANART_API_KEY}`, {
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) imageUrl = pickMovieDisc(await res.json());
    } else {
      // Fanart TV is keyed by TheTVDB id — resolve it via TMDB.
      let tvdbId = null;
      try {
        const ext = await tmdbGet(`/tv/${tmdbId}/external_ids`);
        tvdbId = ext && ext.tvdb_id ? ext.tvdb_id : null;
      } catch {
        /* ignore */
      }
      if (tvdbId) {
        record('fanart'); // count the outbound webservice call
        const res = await fetch(`${FANART_BASE}/tv/${tvdbId}?api_key=${FANART_API_KEY}`, {
          signal: AbortSignal.timeout(20000),
        });
        if (res.ok) imageUrl = pickTvAsset(await res.json());
      }
    }

    if (imageUrl) {
      const buf = await fetchBuffer(imageUrl);
      if (buf) {
        const webp = await toWebp(buf, { quality: WEBP_QUALITY, maxWidth: MAX_WIDTH });
        if (webp) {
          await writeFileAtomic(webpPath(tmdbId), webp);
          return { hit: true, path: webpPath(tmdbId), kind };
        }
        // Compression unavailable — keep the raw download.
        await writeFileAtomic(rawPath(tmdbId), buf);
        return { hit: true, path: rawPath(tmdbId), kind };
      }
    }

    // No disc art found — negative-cache (time-boxed) to avoid re-hitting the API.
    await fsp.writeFile(noneMarker(tmdbId), '');
    return { hit: false, path: null, kind };
  } catch (err) {
    if (logger) logger.warn(`fanart fetch failed for ${type} ${tmdbId}: ${err.message}`);
    // Transient failure — do not negative-cache, so it can retry later.
    return { hit: false, path: null, kind };
  }
}
