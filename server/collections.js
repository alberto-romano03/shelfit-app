import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR } from './config.js';
import { getCollection } from './tmdb.js';

// Collection detail is cached as data/cache/collections/{id}.json. Collection
// images live alongside under collections/{id}/ (served via the assets route).
const COLL_DIR = path.join(CACHE_DIR, 'collections');

function collPath(collectionId) {
  return path.join(COLL_DIR, `${collectionId}.json`);
}

export function readCollectionSync(collectionId) {
  const p = collPath(collectionId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function normalizeCollection(raw) {
  const parts = (raw.parts || [])
    .map((p) => ({
      tmdb_id: String(p.id),
      title: p.title || p.original_title || '',
      original_title: p.original_title || '',
      overview: p.overview || '',
      release_date: p.release_date || '',
      year: p.release_date ? p.release_date.slice(0, 4) : '',
      poster_path: p.poster_path || null,
    }))
    // Release order; titles without a date sort to the end.
    .sort((a, b) => {
      if (!a.release_date && !b.release_date) return 0;
      if (!a.release_date) return 1;
      if (!b.release_date) return -1;
      return a.release_date < b.release_date ? -1 : a.release_date > b.release_date ? 1 : 0;
    });

  return {
    cached_at: new Date().toISOString(),
    id: String(raw.id),
    name: raw.name || '',
    overview: raw.overview || '',
    poster_path: raw.poster_path || null,
    backdrop_path: raw.backdrop_path || null,
    parts,
  };
}

// Ensure a collection's detail is cached, fetching from TMDB only if absent.
export async function ensureCollection(collectionId, { signal } = {}) {
  const existing = readCollectionSync(collectionId);
  if (existing) return existing;
  const raw = await getCollection(collectionId, { signal });
  const norm = normalizeCollection(raw);
  await fsp.mkdir(COLL_DIR, { recursive: true });
  await fsp.writeFile(collPath(collectionId), JSON.stringify(norm, null, 2), 'utf-8');
  return norm;
}
