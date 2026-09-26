// In-memory, per-IP request rate limiting — no external dependency.
//
// A fixed-window counter per (bucket, client-IP). Counters live only in this
// process and reset on restart, which is acceptable for a single-user self-hosted
// app. Applied as an early onRequest hook so abusive floods are rejected cheaply,
// before auth/routing work. Sensitive auth endpoints (login, magic-link redeem)
// keep their own smarter FAILURE-based limiters in auth.js and are intentionally
// left for that layer; this module adds a blanket ceiling plus tighter caps on a
// few expensive endpoints.
//
// 429 responses carry a Retry-After header and a GENERIC body — they never reveal
// the threshold or window.

import { clientIp } from './security.js';

// Per-endpoint overrides, checked in order; the first match wins. `method` is the
// HTTP method, `path` an exact pathname (query stripped before matching). Any
// /api/* request that matches nothing falls back to GLOBAL_DEFAULT.
//
// NOTE: login (POST /api/auth/login) and magic-link redeem
// (GET /api/auth/magic/:token) are deliberately absent — auth.js already limits
// them by failed-attempt count (5/15min and 10/15min) plus a global escalating
// delay, which is stricter and doesn't punish the legitimate owner's successful
// logins. They still count toward the blanket global ceiling below.
const RULES = [
  // Expensive TMDB-backed reads.
  { method: 'GET', path: '/api/search', max: 60, windowMs: 60 * 1000 },
  { method: 'GET', path: '/api/explore', max: 30, windowMs: 60 * 1000 },
  // Bulk, heavy write operations — a few per hour is plenty.
  { method: 'POST', path: '/api/library/import', max: 3, windowMs: 60 * 60 * 1000 },
  { method: 'POST', path: '/api/import/tvtime', max: 3, windowMs: 60 * 60 * 1000 },
  { method: 'POST', path: '/api/import/extras', max: 3, windowMs: 60 * 60 * 1000 },
  // Changing the metadata language re-fetches the WHOLE library from TMDB, so
  // it belongs with the bulk operations rather than the blanket default.
  { method: 'PATCH', path: '/api/settings/metadata-language', max: 4, windowMs: 60 * 60 * 1000 },
  // Image upload.
  { method: 'POST', path: '/api/profile/photo', max: 10, windowMs: 60 * 60 * 1000 },
  { method: 'POST', id: 'person-photo', match: (p) => p.startsWith('/api/persons/') && p.endsWith('/photo'), max: 10, windowMs: 60 * 60 * 1000 },
];

// Blanket default for every other /api/* request.
const GLOBAL_DEFAULT = { max: 200, windowMs: 60 * 1000 };

// Endpoints exempt from the blanket limiter: the liveness probe is polled on a
// timer by every open client and must never be throttled (a 429 there would read
// as "server down").
const EXEMPT = new Set(['/api/health']);

// bucket -> Map<ip, { count, resetAt }>
const buckets = new Map();

function hit(bucketKey, ip, max, windowMs) {
  let bucket = buckets.get(bucketKey);
  if (!bucket) {
    bucket = new Map();
    buckets.set(bucketKey, bucket);
  }
  const now = Date.now();
  let e = bucket.get(ip);
  if (!e || now >= e.resetAt) {
    e = { count: 0, resetAt: now + windowMs };
    bucket.set(ip, e);
  }
  e.count += 1;
  if (e.count > max) {
    return { limited: true, retryAfter: Math.max(1, Math.ceil((e.resetAt - now) / 1000)) };
  }
  return { limited: false };
}

// Periodically drop expired entries so the maps can't grow without bound.
const SWEEP_MS = 5 * 60 * 1000;
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    for (const [ip, e] of bucket) if (now >= e.resetAt) bucket.delete(ip);
    if (bucket.size === 0) buckets.delete(key);
  }
}, SWEEP_MS);
if (sweep.unref) sweep.unref();

// Register the limiter as an onRequest hook. Only /api/* paths are considered;
// everything else (static assets, the SPA shell) passes through untouched.
export function registerRateLimit(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    const pathname = (request.raw.url || '').split('?')[0];
    if (!pathname.startsWith('/api/') || EXEMPT.has(pathname)) return;

    const ip = clientIp(request);
    const rule = RULES.find(
      (r) => r.method === request.method && (r.match ? r.match(pathname) : r.path === pathname)
    );
    const { max, windowMs } = rule || GLOBAL_DEFAULT;
    const bucketKey = rule ? `${request.method} ${rule.path || rule.id}` : 'global';

    const res = hit(bucketKey, ip, max, windowMs);
    if (res.limited) {
      reply
        .code(429)
        .header('Retry-After', String(res.retryAfter))
        .send({ error: 'Too many requests' }); // generic — no threshold leaked
      return reply;
    }
  });
}
