import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import fetch from 'node-fetch';
import { CACHE_DIR, FANART_API_KEY } from './config.js';
import { tmdbGet } from './tmdb.js';
import { toWebp } from './images.js';
import { allowed, record } from './usage.js';
import { getTmdbLanguage } from './language.js';

const FANART_DIR = path.join(CACHE_DIR, 'fanart');
// Clear logos live beside the disc art rather than in it: they are a different
// asset with a different shape and their own negative-cache markers.
const LOGO_DIR = path.join(CACHE_DIR, 'logos');
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

// True if a negative-cache marker exists and is still fresh.
function markerFresh(markerPath) {
  try {
    const st = fs.statSync(markerPath);
    return Date.now() - st.mtimeMs < NONE_TTL_MS;
  } catch {
    return false;
  }
}
function noneMarkerFresh(tmdbId) {
  return markerFresh(noneMarker(tmdbId));
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

// A clear logo is flat, hard-edged artwork on transparency and is drawn at most
// ~44px tall, so it survives far harsher compression than a poster. cwebp keeps
// the alpha channel by default, which is what makes it usable over the sheet.
const LOGO_MAX_WIDTH = 480;
const LOGO_WEBP_QUALITY = 55;

function logoWebpPath(tmdbId) {
  return path.join(LOGO_DIR, `${tmdbId}.webp`);
}
function logoRawPath(tmdbId) {
  return path.join(LOGO_DIR, `${tmdbId}.png`);
}
function logoNoneMarker(tmdbId) {
  return path.join(LOGO_DIR, `${tmdbId}.none`);
}

// Synchronous, network-free check: is a Fanart disc/thumb already cached on disk
// (downloaded earlier by "Back to the Shelf")? Used by the detail endpoint to
// decide between the real disc image and the poster-based disc fallback.
export function hasFanartDiscCached(tmdbId) {
  return fs.existsSync(webpPath(tmdbId)) || fs.existsSync(rawPath(tmdbId));
}

// Fanart.tv answers with ONE document per title holding every asset kind, so the
// disc, the clear logo and the "Customize metadata" list all read the same
// response. Memoizing it briefly means opening a detail page costs one call
// against the monthly budget instead of one per asset.
const DATA_TTL_MS = 10 * 60 * 1000;
const dataMemo = new Map(); // `${type}:${tmdbId}` -> { at, data }

async function fetchFanartData(type, tmdbId) {
  const key = `${type}:${tmdbId}`;
  const hit = dataMemo.get(key);
  if (hit && Date.now() - hit.at < DATA_TTL_MS) return hit.data;

  let url = null;
  if (type === 'movie') {
    url = `${FANART_BASE}/movies/${tmdbId}?api_key=${FANART_API_KEY}`;
  } else {
    // Fanart TV is keyed by TheTVDB id - resolve it via TMDB.
    let tvdbId = null;
    try {
      const ext = await tmdbGet(`/tv/${tmdbId}/external_ids`);
      tvdbId = ext && ext.tvdb_id ? ext.tvdb_id : null;
    } catch {
      /* no external id, so no Fanart document */
    }
    if (tvdbId) url = `${FANART_BASE}/tv/${tvdbId}?api_key=${FANART_API_KEY}`;
  }
  if (!url) {
    dataMemo.set(key, { at: Date.now(), data: null });
    return null;
  }

  record('fanart'); // count the outbound webservice call
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const data = res.ok ? await res.json() : null;
  dataMemo.set(key, { at: Date.now(), data });
  // The memo is per title and short-lived; cap it so a long-running server with
  // a large library cannot grow it without bound.
  if (dataMemo.size > 200) dataMemo.delete(dataMemo.keys().next().value);
  return data;
}

// Fanart tags each asset with a two-letter language ('00' means none). Artwork
// is preferred in the language the library is set to (Settings > Library >
// metadata language), then English, then whatever has the most likes. The same
// order decides the disc, the logo and the picker list.
function byLanguageThenLikes() {
  const want = getTmdbLanguage().split('-')[0];
  const rank = (a) => (a.lang === want ? 2 : a.lang === 'en' ? 1 : 0);
  return (a, b) => {
    const diff = rank(b) - rank(a);
    if (diff) return diff;
    return (b.likes || 0) - (a.likes || 0);
  };
}

async function fetchBuffer(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

function pickMovieDisc(data) {
  const discs = data && data.moviedisc;
  if (!Array.isArray(discs) || !discs.length) return null;
  const sorted = discs
    .map((d) => ({ ...d, likes: parseInt(d.likes || '0', 10) }))
    .sort(byLanguageThenLikes());
  return sorted[0].url;
}

// The clear logo shown as the options-modal title. Fanart names it differently
// per kind; the non-HD variant is accepted as a second choice so a title with
// only an older logo still gets one rather than falling back to plain text.
function pickLogo(data, type) {
  const keys = type === 'movie' ? ['hdmovielogo', 'movielogo'] : ['hdtvlogo', 'clearlogo'];
  for (const key of keys) {
    const arr = data && data[key];
    if (!Array.isArray(arr) || !arr.length) continue;
    const sorted = arr
      .filter((a) => a && a.url)
      .map((a) => ({ ...a, likes: parseInt(a.likes || '0', 10) }))
      .sort(byLanguageThenLikes());
    if (sorted.length) return sorted[0].url;
  }
  return null;
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
    const data = await fetchFanartData(type, tmdbId);
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
    out.sort(byLanguageThenLikes());
    return out.slice(0, 40);
  } catch (err) {
    if (logger) logger.warn(`fanart list failed for ${type} ${tmdbId}: ${err.message}`);
    return [];
  }
}

// Synchronous, network-free check: is a clear logo already cached on disk?
export function hasFanartLogoCached(tmdbId) {
  return fs.existsSync(logoWebpPath(tmdbId)) || fs.existsSync(logoRawPath(tmdbId));
}

// Ensure a title's clear logo is cached (compressed, transparency intact).
// Returns { hit, path }. Same lifecycle as the disc: cached file wins, a fresh
// "none" marker short-circuits for 30 days, and the monthly budget is respected.
export async function ensureFanartLogo(type, tmdbId, logger) {
  await fsp.mkdir(LOGO_DIR, { recursive: true });

  if (fs.existsSync(logoWebpPath(tmdbId))) return { hit: true, path: logoWebpPath(tmdbId) };
  if (fs.existsSync(logoRawPath(tmdbId))) return { hit: true, path: logoRawPath(tmdbId) };
  if (markerFresh(logoNoneMarker(tmdbId))) return { hit: false, path: null };
  if (!FANART_API_KEY) return { hit: false, path: null };
  // Budget spent: the modal keeps its text title. Not negative-cached, so it
  // resumes next month without a manual reset.
  if (!allowed('fanart')) return { hit: false, path: null };

  try {
    const data = await fetchFanartData(type, tmdbId);
    const imageUrl = data ? pickLogo(data, type) : null;

    if (imageUrl) {
      const buf = await fetchBuffer(imageUrl);
      if (buf) {
        const webp = await toWebp(buf, {
          quality: LOGO_WEBP_QUALITY,
          maxWidth: LOGO_MAX_WIDTH,
        });
        if (webp) {
          await writeFileAtomic(logoWebpPath(tmdbId), webp);
          return { hit: true, path: logoWebpPath(tmdbId) };
        }
        // cwebp unavailable: keep the original, which is already a transparent PNG.
        await writeFileAtomic(logoRawPath(tmdbId), buf);
        return { hit: true, path: logoRawPath(tmdbId) };
      }
    }

    await fsp.writeFile(logoNoneMarker(tmdbId), '');
    return { hit: false, path: null };
  } catch (err) {
    if (logger) logger.warn(`fanart logo fetch failed for ${type} ${tmdbId}: ${err.message}`);
    return { hit: false, path: null }; // transient: do not negative-cache
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
    const data = await fetchFanartData(type, tmdbId);
    const imageUrl = data ? (type === 'movie' ? pickMovieDisc(data) : pickTvAsset(data)) : null;

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
