// Magic links for passwordless local login.
//
// A magic link carries a 64-char random hex token (never the password) that,
// when visited, mints a session cookie identical to a normal password login.
// Tokens live in the `magic_links` table; they can be revoked or regenerated at
// any time, carry an optional device label, and expire. The token value is only
// ever returned once — at creation — and is never logged or listed afterwards.
//
// No external dependencies — Node's crypto only.

import crypto from 'node:crypto';
import db from './db.js';

const TOKEN_BYTES = 32; // → 64 hex chars
export const TOKEN_RE = /^[a-f0-9]{64}$/;

// Selectable expiries offered in the UI (label → milliseconds). The default is
// 30 days; anything not in this map falls back to it.
export const EXPIRY_OPTIONS = {
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
  '1y': 365 * 24 * 60 * 60 * 1000,
};
const DEFAULT_EXPIRY_MS = EXPIRY_OPTIONS['30d'];

export function expiryMsFor(key) {
  return EXPIRY_OPTIONS[key] || DEFAULT_EXPIRY_MS;
}

// --- Prepared statements (compiled once at module load, reused thereafter) ---
const insertLinkStmt = db.prepare(
  `INSERT INTO magic_links (token, label, created_at, expires_at, use_count, user_id)
   VALUES (?, ?, ?, ?, 0, ?)`
);
const listLinksStmt = db.prepare(
  `SELECT id, label, created_at, expires_at, last_used_at, use_count
     FROM magic_links
    WHERE expires_at > ? AND user_id = ?
    ORDER BY created_at DESC`
);
const allTokensStmt = db.prepare('SELECT id, token, expires_at, user_id FROM magic_links');
const recordUseStmt = db.prepare(
  `UPDATE magic_links SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`
);
const revokeLinkStmt = db.prepare('DELETE FROM magic_links WHERE id = ? AND user_id = ?');
const cleanupExpiredStmt = db.prepare('DELETE FROM magic_links WHERE expires_at <= ?');

// Create a link that signs in `userId`. Returns the full row INCLUDING the token,
// the only time the token is exposed. The caller turns it into a URL and never
// persists it again.
export function createMagicLink({ userId, label, expiresInMs } = {}) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const now = Date.now();
  const expires_at = now + (Number.isFinite(expiresInMs) ? expiresInMs : DEFAULT_EXPIRY_MS);
  const cleanLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, 60) : null;
  const info = insertLinkStmt.run(token, cleanLabel, now, expires_at, userId);
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

// Look up a token with a TIMING-SAFE comparison. Every stored token is compared
// with crypto.timingSafeEqual and the loop never short-circuits, so the response
// time doesn't leak which (if any) token matched or how far it matched. Returns
// the matching, non-expired row ({ id, expires_at, user_id }), or null. Malformed input returns null cheaply
// (the format is fixed and public, so rejecting it early leaks nothing).
export function redeemToken(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const now = Date.now();
  const candidate = Buffer.from(token, 'utf8');
  const rows = allTokensStmt.all();
  let match = null;
  for (const row of rows) {
    const stored = Buffer.from(row.token, 'utf8');
    const equal =
      stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
    // No early break — keep the work constant regardless of where a match is.
    if (equal && row.expires_at > now) match = { id: row.id, expires_at: row.expires_at, user_id: row.user_id };
  }
  return match;
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
