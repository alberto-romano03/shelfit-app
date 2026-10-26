// Person endpoints: cached TMDB person data, and the person photo (custom upload
// takes priority over the cached TMDB profile image).

import fs from 'node:fs';
import db from '../db.js';
import { sniffMime } from '../images.js';
import { tmdbGet } from '../tmdb.js';
import { getTmdbLanguage } from '../language.js';
import {
  ensurePerson,
  customPhotoPath,
  findCustomPhoto,
  removeCustomPhotos,
  tmdbPhotoPath,
  EXT_FOR_MIME,
  PERSONS_DIR,
} from '../persons.js';

// Same cap as the profile photo, independent of the global 512 KB bodyLimit.
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Which of a person's credits are already in the library, with the viewer's own
// status / rating / favourite for each, so the person page can show "you and
// them" (counts, average rating, badges on every card) without shipping the
// whole library to the browser. items.tmdb_id is TEXT.
const libraryIdsStmt = db.prepare(
  'SELECT id, tmdb_id, type, title_it, status, rating, favorite FROM items WHERE user_id = ?'
);

export default async function personRoutes(fastify) {
  // GET /api/persons/search?q= → TMDB person search for the "pick a person"
  // flow. Static segment, so it takes precedence over /api/persons/:tmdbId.
  // Returns only what the picker renders; photos still come from our own cache
  // once the person is picked (the client never touches the TMDB CDN).
  fastify.get('/api/persons/search', async (request, reply) => {
    const q = String(request.query.q || '').trim();
    if (!q) return { results: [] };
    let data;
    try {
      data = await tmdbGet('/search/person', { query: q, language: getTmdbLanguage() }, { signal: request.raw.signal });
    } catch (err) {
      reply.code(502);
      return { error: err.message || 'person search failed' };
    }
    const results = (data.results || []).slice(0, 20).map((p) => ({
      tmdb_id: p.id,
      name: p.name,
      profile_path: p.profile_path || null,
      known_for_department: p.known_for_department || '',
      known_for: (p.known_for || [])
        .map((k) => k.title || k.name)
        .filter(Boolean)
        .slice(0, 3)
        .join(', '),
    }));
    return { results };
  });

  // GET /api/persons/:tmdbId → person from the local cache, fetched from TMDB on
  // a miss (or when older than 7 days). Also reports which credits are in the
  // library, keyed "movie:123" / "show:123" like the rest of the app.
  fastify.get('/api/persons/:tmdbId', async (request, reply) => {
    let person;
    try {
      person = await ensurePerson(request.params.tmdbId, { signal: request.raw.signal });
    } catch (err) {
      reply.code(502);
      return { error: err.message || 'could not load that person' };
    }
    if (!person) {
      reply.code(404);
      return { error: 'person not found' };
    }
    const library = {};
    for (const row of libraryIdsStmt.all(request.user.id)) {
      library[`${row.type}:${row.tmdb_id}`] = {
        id: row.id,
        title: row.title_it,
        status: row.status,
        rating: row.rating || null,
        favorite: !!row.favorite,
      };
    }
    return { ...person, library };
  });

  // POST /api/persons/:tmdbId/photo → store a custom photo as
  // {tmdbId}_custom.<ext>, keeping the format it was uploaded in rather than
  // relabelling everything .jpg. The raw image content-type parser is
  // registered globally in index.js.
  fastify.post(
    '/api/persons/:tmdbId/photo',
    { bodyLimit: MAX_PHOTO_BYTES },
    async (request, reply) => {
      const id = Number(request.params.tmdbId);
      if (!Number.isInteger(id) || id <= 0) {
        reply.code(400);
        return { error: 'invalid person id' };
      }
      const contentType = (request.headers['content-type'] || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!ACCEPTED.has(contentType)) {
        reply.code(415);
        return { error: 'unsupported image type (use JPEG, PNG or WebP)' };
      }
      const buf = request.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        reply.code(400);
        return { error: 'empty upload' };
      }
      if (buf.length > MAX_PHOTO_BYTES) {
        reply.code(413);
        return { error: 'image too large (max 8 MB)' };
      }
      // Never trust the declared type — verify the actual bytes before writing.
      const sniffed = sniffMime(buf.subarray(0, 12));
      if (!sniffed || sniffed !== contentType) {
        reply.code(415);
        return { error: 'file content does not match the declared image type' };
      }

      fs.mkdirSync(PERSONS_DIR, { recursive: true });
      // Clear the other formats first: leaving an old .png beside a new .webp
      // would mean the lookup order, not the upload, decided what is served.
      removeCustomPhotos(id);
      fs.writeFileSync(customPhotoPath(id, EXT_FOR_MIME[sniffed] || '.jpg'), buf);
      reply.code(201);
      return { tmdb_id: id, has_custom_photo: true, photo_url: `/api/persons/${id}/photo` };
    }
  );

  // DELETE /api/persons/:tmdbId/photo → drop the custom photo (falls back to the
  // cached TMDB profile image).
  fastify.delete('/api/persons/:tmdbId/photo', async (request) => {
    const id = Number(request.params.tmdbId);
    if (Number.isInteger(id) && id > 0) removeCustomPhotos(id);
    return { tmdb_id: id, has_custom_photo: false, photo_url: `/api/persons/${id}/photo` };
  });

  // GET /api/persons/:tmdbId/photo → custom upload first, else the cached TMDB
  // profile image. Served here rather than via /assets/* because that route
  // rewrites .jpg → .webp and would never find the custom file.
  fastify.get('/api/persons/:tmdbId/photo', async (request, reply) => {
    const id = Number(request.params.tmdbId);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400);
      return { error: 'invalid person id' };
    }
    // A ?v stamp (added by photoUrl from the file's mtime) makes the URL identify
    // its exact bytes, so it can be cached as hard as the posters under /assets.
    // Without it we keep revalidating, so a re-upload to the bare URL still shows.
    const versioned = Boolean(request.query && request.query.v);

    const custom = findCustomPhoto(id);
    if (custom) {
      // The stored format is served as itself — a WebP announced as image/jpeg
      // relies on the browser sniffing past the header to render at all.
      reply
        .header('Content-Type', custom.mime)
        .header(
          'Cache-Control',
          versioned ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate'
        );
      return reply.send(fs.createReadStream(custom.file));
    }
    let file = tmdbPhotoPath(id);
    if (!fs.existsSync(file)) {
      // Not cached yet → fetch the person (which stores the image), then retry.
      try {
        await ensurePerson(id, { signal: request.raw.signal });
      } catch {
        /* fall through to the 404 below */
      }
    }
    if (!fs.existsSync(file)) {
      reply.code(404);
      return { error: 'no photo for this person' };
    }
    reply
      .header('Content-Type', 'image/webp')
      .header(
        'Cache-Control',
        versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=86400'
      );
    return reply.send(fs.createReadStream(file));
  });
}
