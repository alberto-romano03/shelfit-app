// Household accounts: lookups shared by the auth gate, the login page and the
// profile routes, plus where each user's avatar lives on disk.
//
// A user's avatar is either a photo they uploaded (data/profile/<id>/avatar.<ext>)
// or a title they picked, stored as a 'movie:123' / 'show:123' token and drawn
// from that title's cached poster.

import fs from 'node:fs';
import path from 'node:path';
import db from './db.js';
import { BADGES_DIR, CACHE_DIR, PROFILE_DIR } from './config.js';

// Sentinel stored in users.profile_image when the user uploaded their own photo.
export const CUSTOM_AVATAR = 'custom';
const AVATAR_BASE = 'avatar';

// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
const getUserStmt = db.prepare('SELECT * FROM users WHERE id = ?');
const getMasterStmt = db.prepare("SELECT * FROM users WHERE role = 'master'");
// Who appears on the login page: enabled accounts that can actually sign in.
const pickerUsersStmt = db.prepare(
  'SELECT * FROM users WHERE disabled = 0 AND password_hash IS NOT NULL ORDER BY sort_order, id'
);

export function getUser(id) {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? getUserStmt.get(n) || null : null;
}

export function getMaster() {
  return getMasterStmt.get() || null;
}

export function pickerUsers() {
  return pickerUsersStmt.all();
}

// The picker shows a user only when they can sign in.
export function isPickable(user) {
  return !!user && !user.disabled && !!user.password_hash;
}

// --- Avatar files ----------------------------------------------------------

export function avatarDir(userId) {
  return path.join(PROFILE_DIR, String(userId));
}

// The uploaded photo on disk (whatever format it arrived in), or null.
export function customPhotoFile(userId) {
  const dir = avatarDir(userId);
  try {
    const f = fs.readdirSync(dir).find((n) => n.startsWith(`${AVATAR_BASE}.`));
    return f ? path.join(dir, f) : null;
  } catch {
    return null;
  }
}

export function clearCustomPhoto(userId) {
  const dir = avatarDir(userId);
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${AVATAR_BASE}.`)) fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {
    /* no folder yet */
  }
}

export function writeCustomPhoto(userId, ext, buf) {
  clearCustomPhoto(userId);
  const dir = avatarDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${AVATAR_BASE}${ext}`), buf);
}

// Parse a 'movie:123' / 'show:123' token. Null for anything else, so a crafted
// value can never name a path outside the cache.
export function parseImageToken(token) {
  const m = /^(movie|show):(\d+)$/.exec(String(token || ''));
  return m ? { type: m[1], tmdbId: m[2] } : null;
}

// Browser URL of a title token's poster (kind 'profile') or backdrop ('cover').
export function imageTokenUrl(token, kind) {
  const t = parseImageToken(token);
  if (!t) return null;
  const folder = t.type === 'movie' ? 'movies' : 'shows';
  return `/assets/${folder}/${t.tmdbId}/${kind === 'cover' ? 'backdrop.webp' : 'poster.webp'}`;
}

// The file to show as this user's avatar on the login page, or null.
export function avatarFile(user) {
  if (!user) return null;
  if (user.profile_image === CUSTOM_AVATAR) return customPhotoFile(user.id);
  const t = parseImageToken(user.profile_image);
  if (!t) return null;
  const f = path.join(CACHE_DIR, t.type === 'movie' ? 'movies' : 'shows', t.tmdbId, 'poster.webp');
  return fs.existsSync(f) ? f : null;
}

// The user's chosen badge image (a file in data/badges/), or null when none is
// set or the file has since been removed.
export function badgeFile(user) {
  if (!user || !user.active_badge) return null;
  const f = path.join(BADGES_DIR, path.basename(String(user.active_badge)));
  return fs.existsSync(f) ? f : null;
}

// Cache-busting version for an avatar or badge file (its mtime), 0 when unknown.
export function fileVersion(file) {
  try {
    return Math.floor(fs.statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}
