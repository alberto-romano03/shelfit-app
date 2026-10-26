// Discover / suggestion endpoints: GET /api/genres exposes the TMDB genre lists,
// and POST /api/discover returns one random title matching the caller's genre,
// mood, rating, duration and era filters, excluding titles already in the
// library. All TMDB access stays server-side.

import db from '../db.js';
import { ensureGenres } from '../genres.js';
import { discover, IMG_SIZES } from '../tmdb.js';
import { clientAbortSignal } from '../http.js';
import { getTmdbLanguage } from '../language.js';

// Local image proxy (cached 1 day) — keeps the phone off the TMDB CDN and
// avoids a full show rebuild just to preview a suggestion.
function thumbUrl(imgPath, size) {
  return imgPath ? `/api/search/thumb?size=${size}&path=${encodeURIComponent(imgPath)}` : null;
}

// Mood → TMDB (kept server-side; the client only sends the mood key). Genre
// candidates are resolved against the real genre list, so missing ones (e.g.
// TV has no "Horror") are simply skipped.
const MOODS = {
  movie: {
    light: { genres: ['Comedy', 'Animation'], minVote: 7 },
    emotional: { genres: ['Drama'] },
    tense: { genres: ['Horror', 'Thriller'] },
    mindbending: { genres: ['Science Fiction', 'Mystery'] },
    epic: { genres: ['Action', 'Adventure'], runtimeGte: 120 },
    easy: { runtimeLte: 90 },
  },
  tv: {
    light: { genres: ['Comedy', 'Animation'], minVote: 7 },
    emotional: { genres: ['Drama'] },
    tense: { genres: ['Mystery', 'Crime'] },
    mindbending: { genres: ['Sci-Fi & Fantasy', 'Mystery'] },
    epic: { genres: ['Action & Adventure'] },
    easy: {},
  },
};

const ERAS = {
  classic: { lte: '1989-12-31' },
  '90s00s': { gte: '1990-01-01', lte: '2009-12-31' },
  recent: { gte: '2010-01-01', lte: '2019-12-31' },
  latest: { gte: '2020-01-01' },
};

// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
const ownedByTypeStmt = db.prepare('SELECT tmdb_id FROM items WHERE user_id = ? AND type = ?');

function idsForNames(genreList, names) {
  const byName = new Map(genreList.map((g) => [g.name.toLowerCase(), g.id]));
  const out = [];
  for (const n of names) {
    const id = byName.get(n.toLowerCase());
    if (id) out.push(id);
  }
  return out;
}

export default async function discoverRoutes(fastify) {
  // GET /api/genres → { movie:[{id,name}], tv:[{id,name}] }
  fastify.get('/api/genres', async (request, reply) => {
    const signal = clientAbortSignal(request, reply);
    try {
      const g = await ensureGenres({ signal });
      // Genre lists change extremely rarely (backed by a 30-day on-disk cache) —
      // let the browser reuse them for a day instead of refetching every load.
      reply.header('Cache-Control', 'public, max-age=86400');
      return { movie: g.movie, tv: g.tv };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        reply.hijack();
        return;
      }
      fastify.log.warn(`genres fetch failed: ${err.message}`);
      reply.code(502);
      return { error: 'could not load genres' };
    }
  });

  // POST /api/discover → random suggestions matching the filters.
  //   count   (optional, 1-5, default 1): how many distinct picks to return in
  //           `results`; the client keeps a few ready so "Suggest another" is
  //           instant. `result` is always the first one (older clients).
  //   exclude (optional): tmdb ids already suggested this session, skipped while
  //           anything else matches (then repeats are allowed rather than none).
  fastify.post('/api/discover', async (request, reply) => {
    const b = request.body || {};
    const count = Math.min(5, Math.max(1, parseInt(b.count, 10) || 1));
    const exclude = new Set((Array.isArray(b.exclude) ? b.exclude : []).map(String));
    const type = b.type === 'show' ? 'show' : 'movie';
    const kind = type === 'movie' ? 'movie' : 'tv';
    const signal = clientAbortSignal(request, reply);

    let genreData;
    try {
      genreData = await ensureGenres({ signal });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        reply.hijack();
        return;
      }
      reply.code(502);
      return { error: 'could not load genres' };
    }
    const genreList = kind === 'movie' ? genreData.movie : genreData.tv;

    const params = {
      language: getTmdbLanguage(),
      include_adult: false,
      'vote_count.gte': 50, // always — avoid obscure low-data titles
      sort_by: 'popularity.desc',
      page: 1,
    };

    // Genres: user selection + mood genres, OR-combined for lenient, non-empty
    // results.
    const genreIds = new Set();
    for (const id of Array.isArray(b.genres) ? b.genres : []) {
      if (Number.isInteger(id)) genreIds.add(id);
    }

    let minVote = [6, 7, 8].includes(b.minRating) ? b.minRating : 0;
    let runtimeGte;
    let runtimeLte;

    const mood = b.mood && MOODS[kind][b.mood] ? MOODS[kind][b.mood] : null;
    if (mood) {
      if (mood.genres) for (const id of idsForNames(genreList, mood.genres)) genreIds.add(id);
      if (mood.minVote) minVote = Math.max(minVote, mood.minVote);
      if (mood.runtimeGte) runtimeGte = mood.runtimeGte;
      if (mood.runtimeLte) runtimeLte = mood.runtimeLte;
    }

    // Explicit duration (movies only) overrides any mood runtime.
    if (kind === 'movie' && b.duration) {
      if (b.duration === 'short') {
        runtimeLte = 90;
        runtimeGte = undefined;
      } else if (b.duration === 'standard') {
        runtimeGte = 90;
        runtimeLte = 150;
      } else if (b.duration === 'long') {
        runtimeGte = 150;
        runtimeLte = undefined;
      }
    }

    if (genreIds.size) params.with_genres = [...genreIds].join('|');
    if (minVote) params['vote_average.gte'] = minVote;
    if (kind === 'movie') {
      if (runtimeGte) params['with_runtime.gte'] = runtimeGte;
      if (runtimeLte) params['with_runtime.lte'] = runtimeLte;
    }

    const era = b.era && ERAS[b.era] ? ERAS[b.era] : null;
    if (era) {
      const gteKey = kind === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte';
      const lteKey = kind === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte';
      if (era.gte) params[gteKey] = era.gte;
      if (era.lte) params[lteKey] = era.lte;
    }

    let results;
    try {
      results = await discover(kind, params, { signal });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        reply.hijack();
        return;
      }
      fastify.log.warn(`discover failed: ${err.message}`);
      reply.code(502);
      return { error: 'discover failed' };
    }

    // Exclude titles already in the library, and require a poster.
    const owned = new Set(
      ownedByTypeStmt.all(request.user.id, type).map((r) => String(r.tmdb_id))
    );
    const pool = results.filter((r) => r.poster_path && !owned.has(String(r.id)));
    if (!pool.length) return { result: null, results: [] };

    // Distinct random picks, unseen ones first.
    const fresh = pool.filter((r) => !exclude.has(String(r.id)));
    const source = (fresh.length ? fresh : pool).slice();
    const picks = [];
    while (source.length && picks.length < count) {
      picks.push(source.splice(Math.floor(Math.random() * source.length), 1)[0]);
    }
    const gmap = new Map(genreList.map((g) => [g.id, g.name]));
    const shaped = picks.map((pick) => shapePick(pick));
    return { result: shaped[0], results: shaped };

    function shapePick(pick) {
      const dateStr = (kind === 'movie' ? pick.release_date : pick.first_air_date) || '';
      return {
        tmdb_id: String(pick.id),
        type,
        title:
          kind === 'movie'
            ? pick.title || pick.original_title || ''
            : pick.name || pick.original_name || '',
        year: dateStr.slice(0, 4),
        rating: Math.round((pick.vote_average || 0) * 10) / 10,
        genres: (pick.genre_ids || []).map((id) => gmap.get(id)).filter(Boolean),
        // The ids alongside the names, so the client can theme each genre chip by
        // id (names arrive in the TMDB language).
        genre_ids: (pick.genre_ids || []).filter((id) => gmap.has(id)),
        overview: pick.overview || '',
        poster_url: thumbUrl(pick.poster_path, IMG_SIZES.poster),
        // Opens the result card; null when TMDB has none (the card then starts
        // at the poster).
        backdrop_url: thumbUrl(pick.backdrop_path, IMG_SIZES.backdrop),
      };
    }
  });
}
