// Household invites: the one-time link a member opens to choose their own
// password. The master creates one when adding a member and again when
// resetting a member's password, so the master never learns (or sets) it.
//
// A member has at most one live invite: creating a new one replaces the old.
// Only a SHA-256 of the token is stored, and the row is deleted on use.

import crypto from 'node:crypto';
import db from './db.js';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_TOKEN_RE = /^[a-f0-9]{64}$/;

// Prepared once at module load (better-sqlite3 compiles on prepare).
const deleteForUserStmt = db.prepare('DELETE FROM invites WHERE user_id = ?');
const insertStmt = db.prepare(
  'INSERT INTO invites (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
);
const findStmt = db.prepare(
  `SELECT i.user_id, i.expires_at, u.display_name, u.disabled
     FROM invites i JOIN users u ON u.id = i.user_id
    WHERE i.token_hash = ?`
);
const pendingStmt = db.prepare('SELECT expires_at FROM invites WHERE user_id = ? AND expires_at > ?');
const pruneStmt = db.prepare('DELETE FROM invites WHERE expires_at <= ?');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// A fresh invite for `userId` (any previous one stops working). Returns the raw
// token, the only time it exists outside the hash.
export function createInvite(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.transaction(() => {
    deleteForUserStmt.run(userId);
    insertStmt.run(hashToken(token), userId, now, now + INVITE_TTL_MS);
  })();
  return { token, expires_at: now + INVITE_TTL_MS };
}

// The member a token invites ({ user_id, display_name, expires_at }), or null
// when it is malformed, unknown, expired or for a disabled account.
export function findInvite(token) {
  if (typeof token !== 'string' || !INVITE_TOKEN_RE.test(token)) return null;
  const row = findStmt.get(hashToken(token));
  if (!row || row.disabled || row.expires_at <= Date.now()) return null;
  return { user_id: row.user_id, display_name: row.display_name, expires_at: row.expires_at };
}

// Drop every invite of `userId` (used, or the member was reset/removed).
export function clearInvites(userId) {
  deleteForUserStmt.run(userId);
}

// When the member's live invite expires, or null if there is none.
export function pendingInvite(userId) {
  const row = pendingStmt.get(userId, Date.now());
  return row ? row.expires_at : null;
}

export function pruneInvites() {
  return pruneStmt.run(Date.now()).changes;
}
