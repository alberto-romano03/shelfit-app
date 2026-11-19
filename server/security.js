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

// --- the path the router actually matched ----------------------------------
// Access rules must judge the request the way the router resolved it, never the
// raw URL text: the router percent-decodes the path (`/api/%68ousehold` reaches
// the `/api/household` handler), so a regex over request.raw.url could be
// sidestepped while the real handler still runs. This rebuilds the concrete path
// from the matched route pattern and its decoded params, e.g.
// `/api/admin/cache/:type/:tmdb_id` + { type: 'movie', tmdb_id: '603' } ->
// `/api/admin/cache/movie/603`. The pattern's literal segments always survive, so
// a prefix rule can never be dodged. Null when no route matched (404): no handler
// runs, so there is nothing to authorize. Routing is done before onRequest.
export function routePath(request) {
  const pattern = request.routeOptions && request.routeOptions.url;
  if (!pattern) return null;
  const params = request.params || {};
  const value = (name) => (params[name] === undefined ? '' : String(params[name]));
  // `:name` params, then a trailing wildcard (static files, the SPA fallback).
  return pattern.replace(/:([A-Za-z0-9_]+)/g, (_, name) => value(name)).replace(/\*$/, () => value('*'));
}

// --- cross-site requests (Fetch Metadata) ----------------------------------
// Browsers say where a request comes from in Sec-Fetch-Site. Only shelfit's own
// pages (same-origin) and things the user does directly (none: typing the URL,
// a home-screen launch, a share sheet) may call the app. From another site only
// a plain page navigation gets through (opening a magic link or a shared link
// from a chat app), and only as a GET: a cross-site form POST, fetch, image or
// script is refused. same-site is refused too: nothing legitimate is same-site
// but not same-origin. Requests without the header (curl, the health probe,
// older browsers) pass, and SameSite=Lax still covers them.
export function isAllowedFetchSite(request) {
  const site = request.headers['sec-fetch-site'];
  if (!site || site === 'same-origin' || site === 'none') return true;
  const navigation =
    request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
  return navigation && (request.method === 'GET' || request.method === 'HEAD');
}

export function registerFetchMetadataGuard(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    if (isAllowedFetchSite(request)) return;
    reply.code(403).send({ error: 'cross-site request refused' });
    return reply;
  });
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
