// Cached TMDB metadata written straight into a test data dir, in the same shape
// cache.js produces (see normalizeMovie / normalizeShow / normalizeSeason). With
// these files in place, adding or opening a title never needs TMDB.

import fs from 'node:fs';
import path from 'node:path';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

export function writeMovieMeta(dataDir, tmdbId, { title, year, runtime, genres = [] }) {
  writeJson(path.join(dataDir, 'cache', 'movies', String(tmdbId), 'meta.json'), {
    cached_at: new Date().toISOString(),
    lang: 'en-US',
    tmdb_id: String(tmdbId),
    type: 'movie',
    title_it: title,
    title_orig: title,
    overview: '',
    tagline: '',
    release_date: `${year}-01-01`,
    year: String(year),
    runtime,
    genres,
    poster_path: null,
    backdrop_path: null,
    imdb_id: null,
    belongs_to_collection: null,
    status: 'Released',
    budget: 0,
    revenue: 0,
    original_language: 'en',
    origin_country: 'US',
    origin_countries: ['US'],
    production_company: '',
    certification: '',
    director: '',
  });
}

// `seasons`: [[{ runtime, air_date }, ...], ...], season 1 first.
export function writeShowMeta(dataDir, tmdbId, { title, year, runTime = 45, genres = [], seasons }) {
  const dir = path.join(dataDir, 'cache', 'shows', String(tmdbId));
  writeJson(path.join(dir, 'meta.json'), {
    cached_at: new Date().toISOString(),
    lang: 'en-US',
    tmdb_id: String(tmdbId),
    type: 'show',
    title_it: title,
    title_orig: title,
    overview: '',
    tagline: '',
    first_air_date: `${year}-01-01`,
    year: String(year),
    status: 'Ended',
    genres,
    episode_run_time: [runTime],
    number_of_seasons: seasons.length,
    number_of_episodes: seasons.reduce((n, s) => n + s.length, 0),
    poster_path: null,
    backdrop_path: null,
    original_language: 'en',
    origin_country: 'US',
    network: 'Test Network',
    created_by: [],
    last_air_date: `${year + seasons.length - 1}-12-31`,
    seasons: seasons.map((eps, i) => ({
      season_number: i + 1,
      name: `Season ${i + 1}`,
      episode_count: eps.length,
      poster_path: null,
      air_date: eps[0] ? eps[0].air_date : null,
    })),
  });
  seasons.forEach((eps, i) => {
    writeJson(path.join(dir, 'seasons', `s${i + 1}`, 'meta.json'), {
      cached_at: new Date().toISOString(),
      season_number: i + 1,
      name: `Season ${i + 1}`,
      overview: '',
      poster_path: null,
      episodes: eps.map((e, j) => ({
        episode_number: j + 1,
        name: `Episode ${j + 1}`,
        overview: '',
        air_date: e.air_date,
        runtime: e.runtime,
        still_path: null,
      })),
    });
  });
}
