import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR } from './config.js';
import { getGenres } from './tmdb.js';

// TMDB genre lists change very rarely — cache them on disk and refresh only if
// older than 30 days.
const GENRES_PATH = path.join(CACHE_DIR, 'genres.json');
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function ensureGenres({ signal } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(GENRES_PATH, 'utf-8'));
    if (
      data &&
      data.fetched_at &&
      Date.now() - data.fetched_at < MAX_AGE_MS &&
      Array.isArray(data.movie) &&
      Array.isArray(data.tv)
    ) {
      return data;
    }
  } catch {
    /* missing or stale — refetch below */
  }

  const [movie, tv] = await Promise.all([
    getGenres('movie', { signal }),
    getGenres('tv', { signal }),
  ]);
  const data = { fetched_at: Date.now(), movie, tv };
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await fsp.writeFile(GENRES_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    /* best-effort cache */
  }
  return data;
}
