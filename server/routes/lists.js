// User-defined lists under /api/lists: CRUD for lists and their members, each
// list scoped to movies or shows. List items carry cached metadata (title, year,
// poster) read from the local cache and are never re-fetched from TMDB.

import db from '../db.js';
import { readMetaSync } from '../cache.js';

// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
const itemIdStmt = db.prepare(
  'SELECT id, rating, owned, watched_in_cinema FROM items WHERE tmdb_id = ?'
);
const previewStmt = db.prepare(
  'SELECT tmdb_id FROM list_items WHERE list_id = ? ORDER BY added_at DESC LIMIT ?'
);
const containsStmt = db.prepare(
  'SELECT 1 FROM list_items WHERE list_id = ? AND tmdb_id = ?'
);
const insertListStmt = db.prepare(
  'INSERT INTO lists (name, type, created_at) VALUES (?, ?, ?)'
);
const renameListStmt = db.prepare('UPDATE lists SET name = ? WHERE id = ?');
const deleteListStmt = db.prepare('DELETE FROM lists WHERE id = ?');
const getListStmt = db.prepare('SELECT * FROM lists WHERE id = ?');
const listItemsStmt = db.prepare(
  'SELECT tmdb_id, added_at FROM list_items WHERE list_id = ? ORDER BY added_at DESC'
);
const addListItemStmt = db.prepare(
  'INSERT OR IGNORE INTO list_items (list_id, tmdb_id, added_at) VALUES (?, ?, ?)'
);
const removeListItemStmt = db.prepare(
  'DELETE FROM list_items WHERE list_id = ? AND tmdb_id = ?'
);

// Metadata for a list item, always read from the local cache — never re-fetched.
// `item_id` is the library row id when the title is in the library (so the UI
// can open its detail page), otherwise null.
function itemMeta(type, tmdbId) {
  const folder = type === 'movie' ? 'movies' : 'shows';
  const row = itemIdStmt.get(String(tmdbId));
  const item_id = row ? row.id : null;
  // Library-scoped extras (null/false when the title is only a list member and
  // not in the library): user rating + the physical/cinema badge flags. Consumed
  // by the list mosaic; ignored by the home list-card preview.
  const rating = row && row.rating ? row.rating : null;
  const owned = !!(row && row.owned);
  const watched_in_cinema = !!(row && row.watched_in_cinema);
  const meta = readMetaSync(type, String(tmdbId));
  if (!meta) {
    return {
      tmdb_id: String(tmdbId), item_id, title: null, year: '',
      poster_url: null, backdrop_url: null, genres: [], rating, owned, watched_in_cinema,
    };
  }
  return {
    tmdb_id: String(tmdbId),
    item_id,
    title: meta.title_it || meta.title_orig || '',
    year: meta.year || '',
    genres: Array.isArray(meta.genres) ? meta.genres : [],
    poster_url: `/assets/${folder}/${tmdbId}/poster.webp`,
    backdrop_url: `/assets/${folder}/${tmdbId}/backdrop.webp`,
    rating,
    owned,
    watched_in_cinema,
  };
}

const PREVIEW_LIMIT = 5;

export default async function listRoutes(fastify) {
  // GET /api/lists  (optional ?type=movie|show, ?tmdbId=<id> for membership)
  fastify.get('/api/lists', async (request) => {
    const { type, tmdbId } = request.query;
    const where = type === 'movie' || type === 'show' ? 'WHERE l.type = ?' : '';
    const rows = db
      .prepare(
        `SELECT l.id, l.name, l.type, l.created_at, COUNT(li.id) AS count
         FROM lists l LEFT JOIN list_items li ON li.list_id = l.id
         ${where}
         GROUP BY l.id
         ORDER BY l.created_at DESC`
      )
      .all(...(where ? [type] : []));

    const lists = rows.map((l) => {
      const out = {
        id: l.id,
        name: l.name,
        type: l.type,
        created_at: l.created_at,
        count: l.count,
        preview: previewStmt
          .all(l.id, PREVIEW_LIMIT)
          .map((it) => itemMeta(l.type, it.tmdb_id)),
      };
      if (tmdbId !== undefined) {
        out.contains = !!containsStmt.get(l.id, Number(tmdbId));
      }
      return out;
    });
    return { lists };
  });

  // POST /api/lists  { name, type }
  fastify.post('/api/lists', async (request, reply) => {
    const { name, type } = request.body || {};
    if (!name || !String(name).trim() || (type !== 'movie' && type !== 'show')) {
      reply.code(400);
      return { error: 'name and valid type are required' };
    }
    const info = insertListStmt.run(String(name).trim(), type, Date.now());
    reply.code(201);
    return { id: info.lastInsertRowid };
  });

  // PATCH /api/lists/:id  { name }
  fastify.patch('/api/lists/:id', async (request, reply) => {
    const { name } = request.body || {};
    if (!name || !String(name).trim()) {
      reply.code(400);
      return { error: 'name is required' };
    }
    const res = renameListStmt.run(String(name).trim(), request.params.id);
    if (!res.changes) {
      reply.code(404);
      return { error: 'not found' };
    }
    return { ok: true };
  });

  // DELETE /api/lists/:id  (cascades to list_items)
  fastify.delete('/api/lists/:id', async (request, reply) => {
    const res = deleteListStmt.run(request.params.id);
    if (!res.changes) {
      reply.code(404);
      return { error: 'not found' };
    }
    return { ok: true };
  });

  // GET /api/lists/:id/items → items with cached metadata.
  fastify.get('/api/lists/:id/items', async (request, reply) => {
    const list = getListStmt.get(request.params.id);
    if (!list) {
      reply.code(404);
      return { error: 'not found' };
    }
    const rows = listItemsStmt.all(list.id);
    return {
      id: list.id,
      name: list.name,
      type: list.type,
      items: rows.map((r) => ({ ...itemMeta(list.type, r.tmdb_id), added_at: r.added_at })),
    };
  });

  // POST /api/lists/:id/items  { tmdbId }
  fastify.post('/api/lists/:id/items', async (request, reply) => {
    const list = getListStmt.get(request.params.id);
    if (!list) {
      reply.code(404);
      return { error: 'not found' };
    }
    const idNum = Number((request.body || {}).tmdbId);
    if (!Number.isInteger(idNum)) {
      reply.code(400);
      return { error: 'tmdbId is required' };
    }
    addListItemStmt.run(list.id, idNum, Date.now());
    return { ok: true };
  });

  // DELETE /api/lists/:id/items/:tmdbId
  fastify.delete('/api/lists/:id/items/:tmdbId', async (request) => {
    const res = removeListItemStmt.run(request.params.id, Number(request.params.tmdbId));
    return { ok: res.changes > 0 };
  });
}
