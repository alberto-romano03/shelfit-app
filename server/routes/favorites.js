// "The Wall" favourites: the ONE pinned movie, show and person shown on the home
// screen. Distinct from items.favorite (the per-title heart behind
// GET /api/profile/favorites) — that's a many-titles list, this is one pick each.
//
// The title picks are stored as items(id) references so removing a title from the
// library clears the pick automatically (ON DELETE SET NULL). The routes still
// speak tmdb ids, resolving them to the item on write. Each member has their own
// Wall: one `favorites` row per user, created on their first pick.

import db from '../db.js';
import { readPersonSync, ensurePerson } from '../persons.js';

const getFavoritesStmt = db.prepare('SELECT * FROM favorites WHERE user_id = ?');
const upsert = (column) =>
  db.prepare(
    `INSERT INTO favorites (user_id, ${column}) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET ${column} = excluded.${column}`
  );
const setMovieStmt = upsert('movie_item_id');
const setShowStmt = upsert('show_item_id');
const setPersonStmt = upsert('person_tmdb_id');
// items.tmdb_id is TEXT: always compare with a string.
const findItemStmt = db.prepare('SELECT * FROM items WHERE user_id = ? AND tmdb_id = ? AND type = ?');
const getItemStmt = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?');

// A treated-as-cleared param: the spec's "pass null to clear".
function isClear(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === '' || s === 'null' || s === 'none' || s === '0';
}

// Minimal card payload for a pinned title (posters come from the local cache).
function titleCard(row) {
  if (!row) return null;
  const folder = row.type === 'movie' ? 'movies' : 'shows';
  return {
    id: row.id,
    tmdb_id: row.tmdb_id,
    type: row.type,
    title: row.title_it,
    year: row.year || null,
    rating: row.rating || null,
    poster_url: `/assets/${folder}/${row.tmdb_id}/poster.webp`,
  };
}

export function buildFavorites(userId) {
  const fav = getFavoritesStmt.get(userId) || {};
  const movie = fav.movie_item_id ? getItemStmt.get(fav.movie_item_id, userId) : null;
  const show = fav.show_item_id ? getItemStmt.get(fav.show_item_id, userId) : null;
  // Person is read from the local cache only — never a TMDB call just to paint
  // the home screen. It's null until the person page has been opened once.
  const person = fav.person_tmdb_id ? readPersonSync(fav.person_tmdb_id) : null;
  return {
    movie: titleCard(movie),
    show: titleCard(show),
    person: person
      ? {
          tmdb_id: person.tmdb_id,
          name: person.name,
          photo_url: person.photo_url,
          has_custom_photo: person.has_custom_photo,
        }
      : fav.person_tmdb_id
        ? { tmdb_id: fav.person_tmdb_id, name: '', photo_url: `/api/persons/${fav.person_tmdb_id}/photo`, has_custom_photo: false }
        : null,
  };
}

export default async function favoriteRoutes(fastify) {
  // GET /api/favorites → the three current picks with their basic metadata.
  fastify.get('/api/favorites', async (request) => buildFavorites(request.user.id));

  // PATCH /api/favorites/movie/:tmdbId — set (or clear with "null").
  for (const kind of ['movie', 'show']) {
    fastify.patch(`/api/favorites/${kind}/:tmdbId`, async (request, reply) => {
      const { tmdbId } = request.params;
      const userId = request.user.id;
      const stmt = kind === 'movie' ? setMovieStmt : setShowStmt;
      if (isClear(tmdbId)) {
        stmt.run(userId, null);
        return buildFavorites(userId);
      }
      const item = findItemStmt.get(userId, String(tmdbId), kind);
      if (!item) {
        reply.code(404);
        return { error: `that ${kind} is not in your library` };
      }
      stmt.run(userId, item.id);
      return buildFavorites(userId);
    });
  }

  // PATCH /api/favorites/person/:tmdbId — set (or clear with "null"). Warms the
  // person cache so The Wall can render the photo immediately after picking.
  fastify.patch('/api/favorites/person/:tmdbId', async (request, reply) => {
    const { tmdbId } = request.params;
    const userId = request.user.id;
    if (isClear(tmdbId)) {
      setPersonStmt.run(userId, null);
      return buildFavorites(userId);
    }
    const id = Number(tmdbId);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400);
      return { error: 'invalid person id' };
    }
    setPersonStmt.run(userId, id);
    try {
      await ensurePerson(id);
    } catch {
      /* the pick still stands; the person page will retry the fetch */
    }
    return buildFavorites(userId);
  });
}
