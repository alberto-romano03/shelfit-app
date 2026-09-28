// Explore feed for the Search page: GET /api/explore returns every Explore row
// (trending, in theaters, popular, top rated, and mood-based rows) in one
// response. The expensive TMDB fetches are memoized in memory with a TTL; the
// per-user "already in library" overlay is recomputed on every request.

import db from '../db.js';
import { tmdbGet, discover, IMG_SIZES } from '../tmdb.js';
import { ensureGenres } from '../genres.js';
import { allowed } from '../usage.js';
import { clientAbortSignal } from '../http.js';

// GET /api/explore — one response with every Explore row for the Search page.
// All TMDB calls happen HERE (the client never touches TMDB). The expensive
// TMDB fetches are memoized in-memory with a TTL (like routes/upcoming.js); the
// cheap, per-user "already in library" overlay is recomputed on every request.

const TTL_MS = (parseInt(process.env.EXPLORE_TTL_MIN, 10) || 90) * 60 * 1000;
const PER_ROW = 20; // cap posters per row

let memo = null; // { at, sections: [{ key, title, items: [baseItem] }] }

// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
const allItemsStmt = db.prepare('SELECT id, tmdb_id, type FROM items');

// Normalize a raw TMDB result to the same shape as a search result (minus the
// live "added" flags, which are overlaid per request). Returns null for people /
// posterless entries so rows stay clean.
function baseItem(r, forcedType) {
  let mt = forcedType || r.media_type;
  if (mt === 'tv') mt = 'show';
  if (mt !== 'movie' && mt !== 'show') return null;
  if (!r.poster_path) return null;
  const isMovie = mt === 'movie';
  const date = isMovie ? r.release_date : r.first_air_date;
  return {
    tmdb_id: String(r.id),
    type: mt,
    title: isMovie ? r.title || r.original_title || '' : r.name || r.original_name || '',
    year: date ? String(date).slice(0, 4) : '',
    rating: Math.round((r.vote_average || 0) * 10) / 10,
    // Include the synopsis so the add dialog shows a summary for Explore items
    // too (search results already carry one).
    overview: r.overview || '',
    thumb_url: `/api/search/thumb?size=${IMG_SIZES.poster}&path=${encodeURIComponent(r.poster_path)}`,
  };
}

function idsForNames(genreList, names) {
  const byName = new Map(genreList.map((g) => [g.name.toLowerCase(), g.id]));
  return names.map((n) => byName.get(n.toLowerCase())).filter(Boolean);
}

// Unwrap either a tmdbGet json ({results}) or a discover() array into an array.
function arr(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.results)) return v.results;
  return [];
}

async function buildSections(signal) {
  const genres = await ensureGenres({ signal });
  const dParams = (extra) => ({
    language: 'it-IT',
    include_adult: false,
    'vote_count.gte': 100,
    sort_by: 'popularity.desc',
    page: 1,
    ...extra,
  });

  // Fire everything concurrently; a single failed row must not sink the page.
  const calls = await Promise.allSettled([
    tmdbGet('/trending/all/week', { language: 'it-IT' }, { signal }),
    tmdbGet('/movie/now_playing', { language: 'it-IT', region: 'IT' }, { signal }),
    tmdbGet('/movie/popular', { language: 'it-IT' }, { signal }),
    tmdbGet('/tv/popular', { language: 'it-IT' }, { signal }),
    tmdbGet('/movie/top_rated', { language: 'it-IT' }, { signal }),
    tmdbGet('/tv/on_the_air', { language: 'it-IT' }, { signal }),
    // Mood rows (labelled by feeling, not genre). These six are the Search
    // page's mood strip; the same definitions Dust It Off uses in
    // routes/discover.js, so a mood means the same thing in both places.
    discover('movie', dParams({ with_genres: idsForNames(genres.movie, ['Comedy', 'Animation']).join('|'), 'vote_average.gte': 7 }), { signal }),
    discover('movie', dParams({ with_genres: idsForNames(genres.movie, ['Thriller', 'Horror']).join('|') }), { signal }),
    discover('movie', dParams({ with_genres: idsForNames(genres.movie, ['Action', 'Adventure']).join('|'), 'with_runtime.gte': 120 }), { signal }),
    discover('tv', dParams({ with_genres: idsForNames(genres.tv, ['Drama']).join('|'), 'vote_average.gte': 7 }), { signal }),
    discover('movie', dParams({ with_genres: idsForNames(genres.movie, ['Science Fiction', 'Mystery']).join('|'), 'vote_average.gte': 7 }), { signal }),
    discover('movie', dParams({ 'with_runtime.lte': 90 }), { signal }),
  ]);

  // If the whole batch was rejected by the monthly cap, propagate so the handler
  // can flag it (and keep any stale memo instead of caching an empty page).
  if (calls.every((c) => c.status === 'rejected' && c.reason && c.reason.capReached)) {
    const e = new Error('tmdb budget reached');
    e.capReached = true;
    throw e;
  }

  const val = (i) => (calls[i].status === 'fulfilled' ? calls[i].value : null);
  const defs = [
    ['trending', 'Trending this week', val(0), undefined],
    ['theaters', 'Now in theaters', val(1), 'movie'],
    ['popular_movies', 'Popular movies', val(2), 'movie'],
    ['popular_tv', 'Popular series', val(3), 'show'],
    ['top_rated', 'Top rated of all time', val(4), 'movie'],
    ['on_the_air', 'New episodes this week', val(5), 'show'],
    ['feel_good', 'Feel-good', val(6), 'movie'],
    ['edge', 'Edge of your seat', val(7), 'movie'],
    ['epic', 'Something epic', val(8), 'movie'],
    ['binge', 'Bingeable drama', val(9), 'show'],
    ['mindbending', 'Mind-bending', val(10), 'movie'],
    ['easy', 'Easy watch', val(11), 'movie'],
  ];

  const seenPerRow = new Set();
  const sections = [];
  for (const [key, title, raw, forced] of defs) {
    const items = [];
    seenPerRow.clear();
    for (const r of arr(raw)) {
      const it = baseItem(r, forced);
      if (!it) continue;
      const dedupe = `${it.type}:${it.tmdb_id}`;
      if (seenPerRow.has(dedupe)) continue;
      seenPerRow.add(dedupe);
      items.push(it);
      if (items.length >= PER_ROW) break;
    }
    if (items.length) sections.push({ key, title, items });
  }
  return sections;
}

// Overlay the live "already in library" flags so tapping a poster opens the
// existing detail (if owned) or the add sheet (if not) — same as search results.
function annotate(sections) {
  const rows = allItemsStmt.all();
  const addedMap = new Map();
  for (const row of rows) addedMap.set(`${row.type}:${row.tmdb_id}`, row);
  return sections.map((s) => ({
    key: s.key,
    title: s.title,
    items: s.items.map((it) => {
      const added = addedMap.get(`${it.type}:${it.tmdb_id}`);
      return { ...it, already_added: !!added, item_id: added ? added.id : null };
    }),
  }));
}

export default async function exploreRoutes(fastify) {
  fastify.get('/api/explore', async (request, reply) => {
    const signal = clientAbortSignal(request, reply);

    if (!memo || Date.now() - memo.at >= TTL_MS) {
      try {
        const sections = await buildSections(signal);
        if (sections.length) memo = { at: Date.now(), sections };
      } catch (err) {
        if (err && err.name === 'AbortError') {
          reply.hijack();
          return;
        }
        // Cap reached, or a transient TMDB failure. Serve a stale memo if we have
        // one; otherwise return an empty page (with a capped flag when relevant)
        // so the client can show the right message instead of erroring hard.
        if (!memo && !(err && err.capReached)) {
          fastify.log.warn(`explore build failed: ${err.message}`);
          reply.code(502);
          return { sections: [], error: 'explore failed' };
        }
      }
    }

    return { sections: annotate(memo ? memo.sections : []), capped: !allowed('tmdb') };
  });
}
