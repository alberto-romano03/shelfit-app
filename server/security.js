// Shared security primitives used across the request pipeline: real client-IP
// extraction behind the reverse proxy, one-way hashing for the access log, and a
// path-traversal guard for file-serving routes. Node's crypto/path only — no deps.

import crypto from 'node:crypto';
import path from 'node:path';
import db from './db.js';

// --- client IP -------------------------------------------------------------
// X-Forwarded-For is "client, proxy1, proxy2…" and the client can spoof the
// left-most entries. Caddy appends the real peer IP as the LAST hop, so trust
// the right-most value (not the attacker-controlled first one). Mirrors the
// logic long used by the login limiter in auth.js — kept here as the single
// source so the rate limiter and access log identify a caller the same way.
export function clientIp(request) {
  const chain = (request.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return chain.length ? chain[chain.length - 1] : request.ip || 'unknown';
}

// --- one-way hashing for the access log ------------------------------------
// The access log must never store a raw IP or user-agent (privacy), yet repeated
// attempts from the same source must still be recognizable. A per-install random
// salt (persisted once in settings) makes the hashes stable across restarts and
// consistent for the same input, while defeating generic rainbow-table reversal
// of the low-entropy IP space.
const SALT_KEY = 'security:hash_salt';
let cachedSalt;
function hashSalt() {
  if (cachedSalt !== undefined) return cachedSalt;
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SALT_KEY);
    if (row && row.value) {
      cachedSalt = row.value;
    } else {
      cachedSalt = crypto.randomBytes(32).toString('hex');
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(SALT_KEY, cachedSalt);
    }
  } catch {
    // If settings is somehow unavailable, fall back to a process-lifetime salt so
    // logging still works (hashes just won't correlate across a restart).
    cachedSalt = crypto.randomBytes(32).toString('hex');
  }
  return cachedSalt;
}

export function hashValue(value) {
  return crypto
    .createHash('sha256')
    .update(hashSalt())
    .update(String(value == null ? '' : value))
    .digest('hex');
}

// --- path-traversal guard --------------------------------------------------
// Resolve `userInput` against `base` and refuse anything that escapes the base
// directory (e.g. "../../etc/passwd" or an absolute path). Used by every route
// that builds a filesystem path from request input, as a single consistent check.
export function safePath(base, userInput) {
  const root = path.resolve(base);
  const resolved = path.resolve(root, userInput == null ? '' : String(userInput));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    const err = new Error('Path traversal attempt detected');
    err.statusCode = 400;
    throw err;
  }
  return resolved;
}
