// Shared security primitives used across the request pipeline: real client-IP
// extraction behind the reverse proxy, one-way hashing for the access log, and a
// path-traversal guard for file-serving routes. Node's crypto/path only — no deps.

import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import path from 'node:path';
import db from './db.js';
import { PUBLIC_URL } from './config.js';

// --- the reverse proxy -----------------------------------------------------
// X-Forwarded-For / -Proto / -Host are believed only from the proxy in front of
// the app: loopback, and the hosts named in TRUSTED_PROXY (comma separated names
// or IPs; default `caddy`, the Caddy container on the shared Docker network).
// Any other container on that network can reach the app directly, and must not
// be able to pick its own client IP (rate limits) or claim https. Names are
// resolved now, every few minutes, and again (at most every 30 s) when an
// unknown address sends forwarded headers: a recreated container gets a new IP.
const TRUSTED_PROXY = (process.env.TRUSTED_PROXY ?? 'caddy')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
let proxyIps = new Set(TRUSTED_PROXY.filter((n) => net.isIP(n)));
let lastResolve = 0;

function resolveProxies() {
  lastResolve = Date.now();
  const names = TRUSTED_PROXY.filter((n) => !net.isIP(n));
  if (!names.length) return;
  Promise.all(
    names.map(
      (name) =>
        new Promise((done) => dns.lookup(name, { all: true }, (err, addrs) => done(err ? [] : addrs.map((a) => a.address))))
    )
  ).then((lists) => {
    proxyIps = new Set([...TRUSTED_PROXY.filter((n) => net.isIP(n)), ...lists.flat()]);
  });
}
resolveProxies();
const proxyTimer = setInterval(resolveProxies, 5 * 60 * 1000);
if (proxyTimer.unref) proxyTimer.unref();

const bareIp = (ip) => String(ip || '').replace(/^::ffff:/, '');
const isLoopback = (ip) => ip === '::1' || /^127\./.test(ip);

export function fromTrustedProxy(request) {
  const peer = bareIp(request.socket ? request.socket.remoteAddress : request.ip);
  if (isLoopback(peer) || proxyIps.has(peer)) return true;
  if (request.headers['x-forwarded-for'] && Date.now() - lastResolve > 30 * 1000) resolveProxies();
  return false;
}

// The first value of a forwarded header, only when the proxy sent it.
export function forwarded(request, name) {
  if (!fromTrustedProxy(request)) return '';
  return String(request.headers[name] || '').split(',')[0].trim();
}

// --- client IP -------------------------------------------------------------
// X-Forwarded-For is "client, proxy1, proxy2…" and the client can spoof the
// left-most entries. Caddy appends the real peer IP as the LAST hop, so trust
// the right-most value (not the attacker-controlled first one), and only from
// the proxy itself (above). Kept here as the single source so the rate limiter
// and access log identify a caller the same way.
export function clientIp(request) {
  const peer = bareIp(request.ip) || 'unknown';
  if (!fromTrustedProxy(request)) return peer;
  const chain = (request.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return chain.length ? chain[chain.length - 1] : peer;
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

// --- response security headers ---------------------------------------------
// Sent by the app itself, so they hold on every path, whatever proxy is (or is
// not) in front. The Content-Security-Policy is enforced: every script is a file
// from this origin (index.html and the login page carry none inline), so script
// injection has nothing to run. Images may also come from TMDB and Fanart.tv:
// the artwork picker shows their thumbnails and crops their originals. Styles
// keep 'unsafe-inline' (style attributes are used throughout).
//
// Violations are reported to /api/csp-report (report-to where supported,
// report-uri for the rest), so a page that hits the policy is seen in the log.
const APP_BASE = '/shelfit'; // the public path prefix (Caddy handle_path, client BASE)
const CSP_REPORT_PATH = `${APP_BASE}/api/csp-report`;
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://image.tmdb.org https://assets.fanart.tv",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `report-uri ${CSP_REPORT_PATH}`,
  'report-to csp',
].join('; ');

// The Reporting API wants an absolute address: the public origin when it is
// configured, else the one this request came in on.
function reportEndpoint(request) {
  let origin = PUBLIC_URL;
  if (!origin) {
    const proto = forwarded(request, 'x-forwarded-proto') || request.protocol || 'http';
    origin = `${proto}://${request.headers.host || 'localhost'}`;
  }
  return `${origin.replace(/\/+$/, '')}${CSP_REPORT_PATH}`;
}

export function registerSecurityHeaders(fastify) {
  fastify.addHook('onSend', async (request, reply, payload) => {
    // A route with a policy of its own (the badge SVGs) keeps it.
    if (!reply.hasHeader('content-security-policy')) {
      reply.header('Content-Security-Policy', CSP);
      reply.header('Reporting-Endpoints', `csp="${reportEndpoint(request)}"`);
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    return payload;
  });
}

// POST /api/csp-report: what the browser sends when a page breaks the policy.
// Public (a report may come from the login page) and small. Only the directive
// and the blocked resource are logged, with any query string cut off, never the
// page's full address or the code sample.
const stripQuery = (u) => (typeof u === 'string' ? u.split(/[?#]/)[0].slice(0, 200) : undefined);

export function registerCspReport(fastify) {
  fastify.register(async (scope) => {
    for (const type of ['application/csp-report', 'application/reports+json']) {
      scope.addContentTypeParser(type, { parseAs: 'string', bodyLimit: 16 * 1024 }, (_req, body, done) => {
        try {
          done(null, JSON.parse(body));
        } catch {
          done(null, null);
        }
      });
    }
    scope.post('/api/csp-report', async (request, reply) => {
      const body = request.body;
      // report-uri: { "csp-report": {...} }; report-to: [{ type, body: {...} }].
      const reports = Array.isArray(body)
        ? body.filter((r) => r && r.type === 'csp-violation').map((r) => r.body || {})
        : body && body['csp-report']
          ? [body['csp-report']]
          : [];
      for (const r of reports.slice(0, 10)) {
        request.log.warn(
          {
            csp: {
              directive: r.effectiveDirective || r['effective-directive'] || r['violated-directive'],
              blocked: stripQuery(r.blockedURL || r['blocked-uri']),
              page: stripQuery(r.documentURL || r['document-uri']),
            },
          },
          'csp violation'
        );
      }
      reply.code(204);
      return null;
    });
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
