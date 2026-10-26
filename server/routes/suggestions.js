// "Suggest this title to…" under /api/suggestions: a member recommends a title
// from their library to another member, who gets a popup about it the next time
// they open the app and can add it to their library or dismiss it.
//
// Privacy, in keeping with the household rules: the sender learns nothing about
// the recipient's library. A suggestion for a title the recipient already has is
// accepted silently and simply never shown to them.

import db from '../db.js';
import { ensureCached, readMetaSync } from '../cache.js';
import { scheduleStatsRecompute } from '../stats.js';
import { getUser, isPickable } from '../users.js';

// Prepared once at module load (better-sqlite3 compiles on prepare).
const recipientsStmt = db.prepare(
  `SELECT id, display_name FROM users
    WHERE id != ? AND disabled = 0 AND password_hash IS NOT NULL
    ORDER BY sort_order, id`
);
const insertStmt = db.prepare(
  `INSERT INTO suggestions (from_user_id, to_user_id, type, tmdb_id, title, year, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(from_user_id, to_user_id, type, tmdb_id) DO NOTHING`
);
const pendingStmt = db.prepare(
  `SELECT s.id, s.type, s.tmdb_id, s.title, s.year, s.created_at, u.display_name AS from_name
     FROM suggestions s JOIN users u ON u.id = s.from_user_id
    WHERE s.to_user_id = ?
    ORDER BY s.created_at, s.id`
);
const getOwnStmt = db.prepare('SELECT * FROM suggestions WHERE id = ? AND to_user_id = ?');
const deleteStmt = db.prepare('DELETE FROM suggestions WHERE id = ? AND to_user_id = ?');
const ownedStmt = db.prepare('SELECT id FROM items WHERE user_id = ? AND type = ? AND tmdb_id = ?');
const insertItemStmt = db.prepare(
  `INSERT INTO items (user_id, tmdb_id, type, title_it, title_orig, status)
   VALUES (?, ?, ?, ?, ?, 'plan_to_watch')`
);

function posterUrl(type, tmdbId) {
  return `/assets/${type === 'movie' ? 'movies' : 'shows'}/${tmdbId}/poster.webp`;
}

export default async function suggestionRoutes(fastify) {
  // GET /api/suggestions/recipients: who the caller can suggest a title to (the
  // other members who can sign in). Names only, as on the login picker.
  fastify.get('/api/suggestions/recipients', async (request) => ({
    recipients: recipientsStmt.all(request.user.id),
  }));

  // POST /api/suggestions { to_user_id, type, tmdb_id }
  fastify.post('/api/suggestions', async (request, reply) => {
    const { to_user_id: toId, type, tmdb_id: tmdbId } = request.body || {};
    if ((type !== 'movie' && type !== 'show') || !/^\d+$/.test(String(tmdbId || ''))) {
      reply.code(400);
      return { error: 'type and tmdb_id are required' };
    }
    const to = getUser(toId);
    if (!isPickable(to) || to.id === request.user.id) {
      reply.code(404);
      return { error: 'member not found' };
    }
    const meta = readMetaSync(type, String(tmdbId));
    if (!meta) {
      reply.code(400);
      return { error: 'title not available' };
    }
    insertStmt.run(
      request.user.id,
      to.id,
      type,
      String(tmdbId),
      meta.title_it || meta.title_orig || 'Untitled',
      meta.year || null,
      Date.now()
    );
    reply.code(201);
    return { ok: true };
  });

  // GET /api/suggestions: the caller's pending suggestions, oldest first. Ones
  // for titles they already have are cleared here instead of being shown.
  fastify.get('/api/suggestions', async (request) => {
    const userId = request.user.id;
    const out = [];
    for (const s of pendingStmt.all(userId)) {
      if (ownedStmt.get(userId, s.type, s.tmdb_id)) {
        deleteStmt.run(s.id, userId);
        continue;
      }
      out.push({
        id: s.id,
        type: s.type,
        tmdb_id: s.tmdb_id,
        title: s.title,
        year: s.year || null,
        from_name: s.from_name,
        poster_url: posterUrl(s.type, s.tmdb_id),
        created_at: s.created_at,
      });
    }
    return { suggestions: out };
  });

  // POST /api/suggestions/:id/accept → the title joins the caller's library as
  // Plan to Watch (or, if it is already there, nothing changes). Returns the
  // library item id.
  fastify.post('/api/suggestions/:id/accept', async (request, reply) => {
    const userId = request.user.id;
    const s = getOwnStmt.get(request.params.id, userId);
    if (!s) {
      reply.code(404);
      return { error: 'not found' };
    }
    const owned = ownedStmt.get(userId, s.type, s.tmdb_id);
    if (owned) {
      deleteStmt.run(s.id, userId);
      return { item_id: owned.id, already: true };
    }
    let meta;
    try {
      meta = await ensureCached(s.type, s.tmdb_id);
    } catch (err) {
      fastify.log.error(err);
      reply.code(502);
      return { error: 'failed to fetch from TMDB' };
    }
    const itemId = db.transaction(() => {
      const info = insertItemStmt.run(
        userId,
        s.tmdb_id,
        s.type,
        meta.title_it || meta.title_orig || s.title,
        meta.title_orig || meta.title_it || s.title
      );
      deleteStmt.run(s.id, userId);
      return Number(info.lastInsertRowid);
    })();
    scheduleStatsRecompute(db);
    return { item_id: itemId };
  });

  // POST /api/suggestions/:id/dismiss
  fastify.post('/api/suggestions/:id/dismiss', async (request, reply) => {
    const res = deleteStmt.run(request.params.id, request.user.id);
    if (!res.changes) {
      reply.code(404);
      return { error: 'not found' };
    }
    return { ok: true };
  });
}
