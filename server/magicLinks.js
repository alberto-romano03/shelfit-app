// Magic links for passwordless local login.
//
// A magic link carries a 64-char random hex token (never the password) that,
// when visited, mints a session cookie identical to a normal password login.
// Links live in the `magic_links` table as a SHA-256 of the token (like sessions
// and invites), so a copy of the database holds no working URL; they can be
// revoked or regenerated at any time, carry an optional device label, and expire.
// The token itself is returned once, at creation, and never logged or listed.
//
// No external dependencies — Node's crypto only.

import crypto from 'node:crypto';
import db from './db.js';

const TOKEN_BYTES = 32; // → 64 hex chars
export const TOKEN_RE = /^[a-f0-9]{64}$/;

// Selectable expiries offered in the UI (label → milliseconds). The default is
// 30 days; anything not in this map falls back to it. 90 days at most: a link is
// a standing login for whoever holds the URL.
export const EXPIRY_OPTIONS = {
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};
const DEFAULT_EXPIRY_MS = EXPIRY_OPTIONS['30d'];

export function expiryMsFor(key) {
  return EXPIRY_OPTIONS[key] || DEFAULT_EXPIRY_MS;
}

// --- Prepared statements (compiled once at module load, reused thereafter) ---
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const insertLinkStmt = db.prepare(
  `INSERT INTO magic_links (token_hash, label, created_at, expires_at, use_count, user_id)
   VALUES (?, ?, ?, ?, 0, ?)`
);
const listLinksStmt = db.prepare(
  `SELECT id, label, created_at, expires_at, last_used_at, use_count
     FROM magic_links
    WHERE expires_at > ? AND user_id = ?
    ORDER BY created_at DESC`
);
const findLinkStmt = db.prepare(
  'SELECT id, expires_at, user_id FROM magic_links WHERE token_hash = ? AND expires_at > ?'
);
const recordUseStmt = db.prepare(
  `UPDATE magic_links SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`
);
const revokeLinkStmt = db.prepare('DELETE FROM magic_links WHERE id = ? AND user_id = ?');
const cleanupExpiredStmt = db.prepare('DELETE FROM magic_links WHERE expires_at <= ?');
const deleteUserLinksStmt = db.prepare('DELETE FROM magic_links WHERE user_id = ?');

// Create a link that signs in `userId`. Returns the full row INCLUDING the token,
// the only time the token is exposed. The caller turns it into a URL and never
// persists it again.
export function createMagicLink({ userId, label, expiresInMs } = {}) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const now = Date.now();
  const expires_at = now + (Number.isFinite(expiresInMs) ? expiresInMs : DEFAULT_EXPIRY_MS);
  const cleanLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, 60) : null;
  const info = insertLinkStmt.run(hashToken(token), cleanLabel, now, expires_at, userId);
  return {
    id: info.lastInsertRowid,
    token,
    label: cleanLabel,
    created_at: now,
    expires_at,
    last_used_at: null,
    use_count: 0,
  };
}

// One user's active (non-expired) links, WITHOUT the token (write-only after create).
export function listMagicLinks(userId) {
  return listLinksStmt.all(Date.now(), userId);
}

// The live link a token opens ({ id, expires_at, user_id }), or null. Looked up
// by the token's SHA-256: the lookup's timing can only reveal something about a
// hash the caller can't steer, never about the stored tokens. Malformed input
// returns null cheaply (the format is fixed and public, so that leaks nothing).
export function redeemToken(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  return findLinkStmt.get(hashToken(token), Date.now()) || null;
}

// Record a successful use (called only after redeemToken matched).
export function recordUse(id) {
  recordUseStmt.run(Date.now(), id);
}

// Revoke (hard-delete) one of `userId`'s links by its database id. Returns true
// if a row went; another user's link id is simply not found.
export function revokeMagicLink(id, userId) {
  const info = revokeLinkStmt.run(id, userId);
  return info.changes > 0;
}

// Delete every link of `userId` (signed out everywhere, password reset, disabled).
export function deleteUserMagicLinks(userId) {
  return deleteUserLinksStmt.run(userId).changes;
}

// Delete every expired link. Returns the number removed.
export function cleanupExpired() {
  const info = cleanupExpiredStmt.run(Date.now());
  return info.changes;
}

// Run cleanup now (boot) and once daily thereafter. The interval is unref'd so
// it never keeps the process alive on its own.
const DAY_MS = 24 * 60 * 60 * 1000;
export function startMagicCleanup(logger) {
  const sweep = () => {
    try {
      const n = cleanupExpired();
      if (n && logger) logger.info(`magic-links: cleaned up ${n} expired token(s)`);
    } catch (err) {
      if (logger) logger.warn(`magic-links cleanup failed: ${err.message}`);
    }
  };
  sweep();
  const timer = setInterval(sweep, DAY_MS);
  if (timer.unref) timer.unref();
  return timer;
}
