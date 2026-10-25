// Profile endpoints under /api/profile, always for the signed-in member: read and
// update the display name, active badge, and profile / cover images; upload,
// serve and delete their custom profile photo; and list rated titles, favourites
// and available badges for the customization grids. Profiles live in `users`.

import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { BADGES_DIR } from '../config.js';
import { sniffMime } from '../images.js';
import {
  CUSTOM_AVATAR,
  getUser,
  customPhotoFile,
  clearCustomPhoto,
  writeCustomPhoto,
  imageTokenUrl,
} from '../users.js';

// Hard cap for the single profile photo, independent of the global bodyLimit.
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
const clearProfileImageStmt = db.prepare('UPDATE users SET profile_image = NULL WHERE id = ?');
const ratedItemsStmt = db.prepare(
  'SELECT id, tmdb_id, type, title_it, rating FROM items WHERE user_id = ? AND rating IS NOT NULL ORDER BY rating DESC, updated_at DESC'
);
const favoriteItemsStmt = db.prepare(
  'SELECT id, tmdb_id, type, title_it, rating FROM items WHERE user_id = ? AND favorite = 1 ORDER BY updated_at DESC'
);

const BADGE_EXT = new Set(['.png', '.svg', '.jpg', '.jpeg', '.webp', '.gif']);

const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const EXT_TO_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function listBadges() {
  let files = [];
  try {
    files = fs.readdirSync(BADGES_DIR);
  } catch {
    files = [];
  }
  return files
    .filter((f) => BADGE_EXT.has(path.extname(f).toLowerCase()))
    .map((filename) => ({ filename, url: `/badges/${filename}` }));
}

// Build the profile response, resolving the profile photo (custom upload or
// rated-title token) and cover to their URLs.
function buildProfileResponse(row) {
  let profileUrl = null;
  if (row.profile_image === CUSTOM_AVATAR) {
    const f = customPhotoFile(row.id);
    if (f) {
      // The readdir + stat are two syscalls; the file can vanish in between
      // (concurrent delete). Fall back to no cache-buster rather than throwing
      // an ENOENT that would 500 and leak the absolute path.
      let v = 0;
      try {
        v = Math.floor(fs.statSync(f).mtimeMs); // cache-bust on change
      } catch {
        /* file removed between readdir and stat */
      }
      profileUrl = `/api/profile/photo?v=${v}`;
    }
  } else {
    profileUrl = imageTokenUrl(row.profile_image, 'profile');
  }
  return {
    display_name: row.display_name,
    active_badge: row.active_badge,
    active_badge_url: row.active_badge ? `/badges/${row.active_badge}` : null,
    profile_image: row.profile_image,
    profile_image_url: profileUrl,
    cover_image: row.cover_image,
    cover_image_url: imageTokenUrl(row.cover_image, 'cover'),
    has_custom_photo: customPhotoFile(row.id) !== null,
  };
}

// The signed-in member's row.
function getProfileRow(request) {
  return getUser(request.user.id);
}

export default async function profileRoutes(fastify) {
  // GET /api/profile
  fastify.get('/api/profile', async (request) => buildProfileResponse(getProfileRow(request)));

  // PATCH /api/profile
  fastify.patch('/api/profile', async (request, reply) => {
    const body = request.body || {};
    const fields = [];
    const params = [];

    if (body.display_name !== undefined) {
      const name = String(body.display_name).trim();
      if (!name) {
        reply.code(400);
        return { error: 'display_name cannot be empty' };
      }
      fields.push('display_name = ?');
      params.push(name);
    }
    if (body.active_badge !== undefined) {
      // '' or null clears the badge.
      let badge = body.active_badge || null;
      if (badge) {
        const valid = listBadges().some((b) => b.filename === badge);
        if (!valid) {
          reply.code(400);
          return { error: 'badge not found' };
        }
      }
      fields.push('active_badge = ?');
      params.push(badge);
    }
    if (body.profile_image !== undefined) {
      fields.push('profile_image = ?');
      params.push(body.profile_image || null);
    }
    if (body.cover_image !== undefined) {
      fields.push('cover_image = ?');
      params.push(body.cover_image || null);
    }

    if (fields.length) {
      db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(
        ...params,
        request.user.id
      );
    }

    return buildProfileResponse(getProfileRow(request));
  });

  // POST /api/profile/photo → upload a custom profile photo (raw image body).
  // Deletes any previous photo (only one is ever kept) and stores it under a
  // fixed base name. Selecting it as the active photo is done separately via
  // PATCH /api/profile { profile_image: 'custom' } (the modal's Save).
  //
  // Raise the body cap above the global 512 KB to the photo's own MAX_PHOTO_BYTES
  // so an oversized image is rejected (413) before the whole body is buffered,
  // instead of being read into memory only to fail the length check below.
  fastify.post('/api/profile/photo', { bodyLimit: MAX_PHOTO_BYTES }, async (request, reply) => {
    const contentType = (request.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const ext = MIME_TO_EXT[contentType];
    if (!ext) {
      reply.code(415);
      return { error: 'unsupported image type (use JPEG, PNG, WebP or GIF)' };
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
    // Don't trust the declared Content-Type alone — verify the actual bytes are
    // a real image of the claimed type before writing anything to disk.
    const sniffed = sniffMime(buf.subarray(0, 12));
    if (!sniffed || sniffed !== contentType) {
      reply.code(415);
      return { error: 'file content does not match the declared image type' };
    }

    writeCustomPhoto(request.user.id, ext, buf);

    reply.code(201);
    return buildProfileResponse(getProfileRow(request));
  });

  // GET /api/profile/photo → serve the stored custom photo (no long caching;
  // the URL carries a ?v mtime buster so updates show immediately).
  fastify.get('/api/profile/photo', async (request, reply) => {
    const f = customPhotoFile(request.user.id);
    if (!f || !fs.existsSync(f)) {
      reply.code(404);
      return { error: 'no custom photo' };
    }
    const mime = EXT_TO_MIME[path.extname(f).toLowerCase()] || 'image/jpeg';
    reply
      .header('Content-Type', mime)
      .header('Cache-Control', 'no-cache, must-revalidate');
    return reply.send(fs.createReadStream(f));
  });

  // DELETE /api/profile/photo → remove the custom photo and deselect it.
  fastify.delete('/api/profile/photo', async (request) => {
    clearCustomPhoto(request.user.id);
    const row = getProfileRow(request);
    if (row.profile_image === CUSTOM_AVATAR) {
      clearProfileImageStmt.run(row.id);
    }
    return buildProfileResponse(getProfileRow(request));
  });

  // GET /api/profile/rated → rated titles for the customization grids.
  fastify.get('/api/profile/rated', async (request) => {
    const rows = ratedItemsStmt.all(request.user.id);
    const items = rows.map((r) => {
      const folder = r.type === 'movie' ? 'movies' : 'shows';
      return {
        id: r.id,
        tmdb_id: r.tmdb_id,
        type: r.type,
        title_it: r.title_it,
        rating: r.rating,
        token: `${r.type}:${r.tmdb_id}`,
        poster_url: `/assets/${folder}/${r.tmdb_id}/poster.webp`,
        backdrop_url: `/assets/${folder}/${r.tmdb_id}/backdrop.webp`,
      };
    });
    return { items };
  });

  // GET /api/profile/favorites → favourited titles, for the cover-art grid.
  fastify.get('/api/profile/favorites', async (request) => {
    const rows = favoriteItemsStmt.all(request.user.id);
    const items = rows.map((r) => {
      const folder = r.type === 'movie' ? 'movies' : 'shows';
      return {
        id: r.id,
        tmdb_id: r.tmdb_id,
        type: r.type,
        title_it: r.title_it,
        rating: r.rating,
        token: `${r.type}:${r.tmdb_id}`,
        poster_url: `/assets/${folder}/${r.tmdb_id}/poster.webp`,
        backdrop_url: `/assets/${folder}/${r.tmdb_id}/backdrop.webp`,
      };
    });
    return { items };
  });

  // GET /api/badges → list badge files placed in data/badges/.
  fastify.get('/api/badges', async () => {
    return { badges: listBadges() };
  });
}
