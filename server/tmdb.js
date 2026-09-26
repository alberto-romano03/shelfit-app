import fetch from 'node-fetch';
import { TMDB_API_KEY } from './config.js';
import { getTmdbLanguage, fallbackTmdbLanguage } from './language.js';
import { guard, record } from './usage.js';

const API_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p';

// Optimized image sizes per context (see spec — never download originals).
export const IMG_SIZES = {
  poster: 'w342', // grid posters
  backdrop: 'w780', // detail backdrop
  thumb: 'w185', // episode thumbnails
  seasonPoster: 'w185', // season posters
  profile: 'w342', // person photos (frame + person page header)
};

// TMDB accepts either a v3 api_key query param or a v4 bearer read token
// (a JWT that starts with "eyJ"). Detect which one the user supplied.
const isBearer = TMDB_API_KEY.startsWith('eyJ');

// Global minimum spacing between API calls (0 = off). The import raises this
// to 250ms so every TMDB request — search, detail and per-season — stays under
// the 40 req / 10s limit, then resets it to 0 when the job ends.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let minInterval = 0;
let lastCallAt = 0;
export function setMinInterval(ms) {
  minInterval = ms || 0;
}
async function gate() {
  if (!minInterval) return;
  const wait = minInterval - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

// Combine the caller's abort signal (if any) with a hard timeout so a hung
// TMDB/CDN connection can never leave a request (or a signal-less background
// refresh) stuck forever.
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function buildUrl(endpoint, params = {}) {
  const url = new URL(`${API_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  if (!isBearer) url.searchParams.set('api_key', TMDB_API_KEY);
  return url.toString();
}

async function tmdbGet(endpoint, params = {}, { signal } = {}) {
  if (!TMDB_API_KEY) {
    throw new Error('TMDB_API_KEY is not configured');
  }
  guard('tmdb'); // throws ApiCapError when the monthly budget is reached
  await gate();
  const url = buildUrl(endpoint, params);
  const headers = { Accept: 'application/json' };
  if (isBearer) headers.Authorization = `Bearer ${TMDB_API_KEY}`;

  record('tmdb'); // count the outbound API call
  const res = await fetch(url, { headers, signal: withTimeout(signal, 20000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TMDB ${endpoint} -> ${res.status} ${body}`);
  }
  return res.json();
}

// Build a full CDN url for a TMDB image path at a given size.
export function imageUrl(size, filePath) {
  if (!filePath) return null;
  return `${IMG_BASE}/${size}${filePath}`;
}

// Download an image and return it as a Buffer (null if unavailable).
export async function downloadImage(size, filePath, { signal } = {}) {
  if (!filePath) return null;
  const url = imageUrl(size, filePath);
  const res = await fetch(url, { signal: withTimeout(signal, 30000) });
  if (!res.ok) return null;
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// --- Search ---------------------------------------------------------------

export async function searchMovie(query) {
  const data = await tmdbGet('/search/movie', {
    query,
    language: getTmdbLanguage(),
    include_adult: false,
  });
  return data.results || [];
}

export async function searchTv(query) {
  const data = await tmdbGet('/search/tv', {
    query,
    language: getTmdbLanguage(),
    include_adult: false,
  });
  return data.results || [];
}

// Resolve an IMDb id (tt#######) to a movie or tv result.
export async function findByImdb(imdbId) {
  const data = await tmdbGet(`/find/${imdbId}`, {
    external_source: 'imdb_id',
    language: getTmdbLanguage(),
  });
  const movies = (data.movie_results || []).map((r) => ({ ...r, _type: 'movie' }));
  const shows = (data.tv_results || []).map((r) => ({ ...r, _type: 'show' }));
  return { movies, shows };
}

// Resolve a TheTVDB series id to its TMDB id (used by the extras importer to map
// TV Time's TheTVDB-keyed favourites / watchlist). Returns null if unmatched.
export async function findShowByTvdb(tvdbId) {
  if (!tvdbId) return null;
  const data = await tmdbGet(`/find/${tvdbId}`, { external_source: 'tvdb_id' });
  const r = (data.tv_results || [])[0];
  return r ? String(r.id) : null;
}

// --- Detail (localized, with a fallback-language overview) ----------------

// Fetch a movie in the configured language; if the overview is empty, fill it
// from the fallback language.
export async function getMovie(tmdbId, { signal } = {}) {
  // append_to_response=release_dates piggybacks the certification data on the same
  // request (no extra API call) so we can show an age rating.
  const it = await tmdbGet(
    `/movie/${tmdbId}`,
    { language: getTmdbLanguage(), append_to_response: 'release_dates,credits' },
    { signal }
  );
  if (!it.overview || it.overview.trim() === '') {
    try {
      const en = await tmdbGet(`/movie/${tmdbId}`, { language: fallbackTmdbLanguage() }, { signal });
      it.overview = en.overview || '';
    } catch {
      /* keep empty overview if EN fetch fails */
    }
  }
  return it;
}

// Fetch a tv series in the configured language; fall back for an empty overview.
export async function getTv(tmdbId, { signal } = {}) {
  const it = await tmdbGet(`/tv/${tmdbId}`, { language: getTmdbLanguage() }, { signal });
  if (!it.overview || it.overview.trim() === '') {
    try {
      const en = await tmdbGet(`/tv/${tmdbId}`, { language: fallbackTmdbLanguage() }, { signal });
      it.overview = en.overview || '';
    } catch {
      /* ignore */
    }
  }
  return it;
}

// Fetch a single season (episodes included), same language fallback as above.
export async function getSeason(tmdbId, seasonNumber, { signal } = {}) {
  const it = await tmdbGet(
    `/tv/${tmdbId}/season/${seasonNumber}`,
    { language: getTmdbLanguage() },
    { signal }
  );
  if (!it.overview || it.overview.trim() === '') {
    try {
      const en = await tmdbGet(
        `/tv/${tmdbId}/season/${seasonNumber}`,
        { language: fallbackTmdbLanguage() },
        { signal }
      );
      it.overview = en.overview || '';
    } catch {
      /* ignore */
    }
  }
  return it;
}

// Genre list for movies ('movie') or TV ('tv'). Fetched in en-US so the names
// are stable for the mood→genre mapping.
export async function getGenres(kind, { signal } = {}) {
  const data = await tmdbGet(`/genre/${kind}/list`, { language: 'en-US' }, { signal });
  return data.genres || [];
}

// Run a discover query for movies ('movie') or TV ('tv'). `params` are raw TMDB
// discover parameters. Returns the results array.
export async function discover(kind, params, { signal } = {}) {
  const data = await tmdbGet(`/discover/${kind}`, params, { signal });
  return data.results || [];
}

// Fetch a movie collection (its films list) with the same language fallback.
export async function getCollection(collectionId, { signal } = {}) {
  const it = await tmdbGet(`/collection/${collectionId}`, { language: getTmdbLanguage() }, { signal });
  if (!it.overview || it.overview.trim() === '') {
    try {
      const en = await tmdbGet(`/collection/${collectionId}`, { language: fallbackTmdbLanguage() }, { signal });
      it.overview = en.overview || '';
    } catch {
      /* keep empty overview if EN fetch fails */
    }
  }
  return it;
}

// Look up a series id from a TMDB episode id (used during import for an
// exact match). Returns the show_id or null.
export async function findSeriesByEpisodeId(episodeId) {
  try {
    const data = await tmdbGet(`/tv/episode/${episodeId}`, {
      language: getTmdbLanguage(),
    });
    return data.show_id || null;
  } catch {
    return null;
  }
}

export { tmdbGet };

// Fetch a person in the configured language; fall back for an empty biography (same
// language pattern as getMovie/getTv).
export async function getPerson(tmdbId, { signal } = {}) {
  const it = await tmdbGet(`/person/${tmdbId}`, { language: getTmdbLanguage() }, { signal });
  if (!it.biography || it.biography.trim() === '') {
    try {
      const en = await tmdbGet(`/person/${tmdbId}`, { language: fallbackTmdbLanguage() }, { signal });
      it.biography = en.biography || '';
    } catch {
      /* keep the empty biography if the EN fetch fails */
    }
  }
  return it;
}

// Every acting + crew credit for a person, in one call.
export async function getPersonCredits(tmdbId, { signal } = {}) {
  return tmdbGet(`/person/${tmdbId}/combined_credits`, { language: getTmdbLanguage() }, { signal });
}
