import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';

import { PORT, BADGES_DIR, CLIENT_DIST, TMDB_API_KEY, PUBLIC_URL } from './config.js';
import db from './db.js'; // opens DB, creates dirs, runs migrations on import
import { migrateCacheToWebp } from './cache.js';
import { initAuthPassword, registerAuth } from './auth.js';
import { startMagicCleanup } from './magicLinks.js';
import { registerRateLimit } from './rateLimit.js';
import { startAccessLogCleanup } from './accessLog.js';

import searchRoutes from './routes/search.js';
import mediaRoutes from './routes/media.js';
import progressRoutes from './routes/progress.js';
import assetRoutes from './routes/assets.js';
import statsRoutes from './routes/stats.js';
import upcomingRoutes from './routes/upcoming.js';
import profileRoutes from './routes/profile.js';
import adminRoutes from './routes/admin.js';
import importRoutes from './routes/import.js';
import fanartRoutes from './routes/fanart.js';
import collectionRoutes from './routes/collections.js';
import discoverRoutes from './routes/discover.js';
import exploreRoutes from './routes/explore.js';
import usageRoutes from './routes/usage.js';
import listRoutes from './routes/lists.js';
import shelfRoutes from './routes/shelf.js';
import receiptRoutes from './routes/receipt.js';
import kodiRoutes from './routes/kodi.js';
import pushRoutes from './routes/push.js';
import libraryRoutes from './routes/library.js';
import shareRoutes from './routes/share.js';
import cinemaRoutes from './routes/cinema.js';
import favoriteRoutes from './routes/favorites.js';
import personRoutes from './routes/persons.js';
import { startKodiScheduler } from './kodiSync.js';
import { startPushScheduler } from './push.js';
import { imageRamCache } from './imageRamCache.js';

const fastify = Fastify({
  logger: {
    // Custom request serializer so magic-link tokens NEVER reach the logs: the
    // token segment of /api/auth/magic/<token> is redacted before pino writes
    // the request line. Otherwise mirrors Fastify's default req fields.
    serializers: {
      req(request) {
        const url = (request.url || '').replace(
          /(\/api\/auth\/magic\/)[a-f0-9]{64}/gi,
          '$1[redacted]'
        );
        return {
          method: request.method,
          url,
          hostname: request.hostname,
          remoteAddress: request.ip,
          remotePort: request.socket ? request.socket.remotePort : undefined,
        };
      },
    },
  },
  // Default cap for request bodies. Every normal endpoint sends only small JSON,
  // so keep this deliberately tight (512 KB) to blunt memory-exhaustion attempts;
  // the two endpoints that legitimately accept larger payloads (library XML
  // import, profile-photo upload) raise it per-route via their own `bodyLimit`.
  bodyLimit: 512 * 1024,
});

// --- CORS -----------------------------------------------------------------
// The SPA is served same-origin under /shelfit, so no legitimate request is
// cross-origin. Rather than reflect arbitrary origins, allow ONLY the app's own
// public origin (from PUBLIC_URL) plus localhost for development, with the
// methods/headers the app actually uses and credentials enabled for the session
// cookie. A request from any other origin simply receives no CORS headers, so
// the browser blocks it. Never a wildcard.
const ALLOWED_ORIGINS = new Set(
  [
    PUBLIC_URL || null,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173', // Vite dev server
    'http://127.0.0.1:5173',
  ].filter(Boolean)
);
await fastify.register(fastifyCors, {
  origin(origin, cb) {
    // No Origin header → a same-origin navigation or a non-browser client; it
    // needs no CORS headers, so respond without them (does not block the request).
    if (!origin) return cb(null, false);
    return cb(null, ALLOWED_ORIGINS.has(origin));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400, // cache preflight for a day
});

// --- Strip identifying response headers -----------------------------------
// Defense in depth: Fastify/Node don't set Server or X-Powered-By by default,
// but if any layer ever adds them, remove them so responses don't advertise the
// stack. (Caddy also strips its own `Server` header — see the Caddyfile.)
fastify.addHook('onSend', async (_request, reply) => {
  reply.removeHeader('Server');
  reply.removeHeader('X-Powered-By');
});

// --- Rate limiting --------------------------------------------------------
// Per-IP request ceilings for /api/*, registered before the auth gate so floods
// are shed cheaply. See rateLimit.js for the per-endpoint limits.
registerRateLimit(fastify);

// Accept raw image bodies (used by the custom profile-photo upload). Keeps the
// upload dependency-free — the client PUTs the file with its image/* type.
fastify.addContentTypeParser(
  ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  { parseAs: 'buffer' },
  (req, body, done) => done(null, body)
);

// Accept a raw XML body for the library import (the client uploads the file's
// text directly — no multipart dependency needed). Parse as a buffer and decode
// with a STRICT UTF-8 decoder so a binary or mis-encoded upload is rejected with
// a clean 400 before it ever reaches the XML parser, rather than being silently
// mangled by lossy replacement characters.
fastify.addContentTypeParser(
  ['application/xml', 'text/xml'],
  { parseAs: 'buffer' },
  (req, body, done) => {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
      done(null, text);
    } catch {
      const err = new Error('Request body is not valid UTF-8 text');
      err.statusCode = 400;
      done(err);
    }
  }
);

// --- Authentication -------------------------------------------------------
// Initialize the password from APP_PASSWORD on first boot (or reset), then gate
// every request behind a session cookie. Registered before the app routes so
// the onRequest hook covers them and the static file server.
const auth = initAuthPassword(fastify.log);
// Fail closed in production: running with no password leaves the whole library
// and every mutating API open. A warning in the boot log is too easy to miss on
// an internet-exposed host, so refuse to start unless the operator has
// explicitly opted into an unauthenticated instance with ALLOW_NO_AUTH=true.
if (!auth.configured && process.env.NODE_ENV === 'production') {
  const allowNoAuth = String(process.env.ALLOW_NO_AUTH || '').toLowerCase() === 'true';
  if (!allowNoAuth) {
    fastify.log.error(
      'Refusing to start with authentication disabled in production. ' +
        'Set APP_PASSWORD in .env to require login, or set ALLOW_NO_AUTH=true to ' +
        'intentionally run without a password.'
    );
    process.exit(1);
  }
  fastify.log.warn('AUTH DISABLED and ALLOW_NO_AUTH=true — running with no login. This instance is unprotected.');
}
registerAuth(fastify, { configured: auth.configured });

// Liveness probe for the client's server-reachability monitor. Public (allowed
// by the auth gate) and never cached by the service worker, so a failed fetch
// reliably means the backend is down.
fastify.get('/api/health', async () => ({ ok: true }));

if (!TMDB_API_KEY) {
  fastify.log.warn(
    'TMDB_API_KEY is not set — search and adding titles will fail until it is configured in .env'
  );
}

// Client disconnects (navigating away mid-request) surface as AbortError /
// ECONNRESET. These are expected — swallow them instead of logging a 500.
fastify.setErrorHandler((error, request, reply) => {
  const aborted =
    (error && (error.name === 'AbortError' || error.code === 'ECONNRESET')) ||
    (request.raw && request.raw.aborted) ||
    reply.raw.writableEnded === false && reply.raw.destroyed;
  if (aborted) {
    request.log.debug({ err: error }, 'request aborted by client');
    if (!reply.raw.headersSent) {
      try {
        reply.hijack();
      } catch {
        /* already detached */
      }
    }
    return;
  }
  request.log.error(error);
  if (!reply.sent) {
    const status = error.statusCode || 500;
    // Deliberate 4xx messages (validation, "not found", explicit route errors)
    // are safe to surface; 5xx messages are raw internals — SQLite/constraint
    // text, absolute fs paths, upstream response bodies — and must never reach
    // the client. Log the full error above; return a generic string for 5xx.
    const safe = status < 500 ? error.message || 'Bad Request' : 'Internal Server Error';
    reply.code(status).send({ error: safe });
  }
});

// --- API + asset routes ---------------------------------------------------
await fastify.register(searchRoutes);
await fastify.register(mediaRoutes);
await fastify.register(progressRoutes);
await fastify.register(assetRoutes);
await fastify.register(statsRoutes);
await fastify.register(upcomingRoutes);
await fastify.register(profileRoutes);
await fastify.register(adminRoutes);
await fastify.register(importRoutes);
await fastify.register(fanartRoutes);
await fastify.register(collectionRoutes);
await fastify.register(discoverRoutes);
await fastify.register(exploreRoutes);
await fastify.register(usageRoutes);
await fastify.register(listRoutes);
await fastify.register(shelfRoutes);
await fastify.register(receiptRoutes);
await fastify.register(kodiRoutes);
await fastify.register(pushRoutes);
await fastify.register(libraryRoutes);
await fastify.register(cinemaRoutes);
await fastify.register(favoriteRoutes);
await fastify.register(personRoutes);
// Share Target (GET /share) — an explicit route so it is matched ahead of the
// SPA static handler / not-found fallback and reaches this handler, not the shell.
await fastify.register(shareRoutes);

// --- Static: user badges --------------------------------------------------
await fastify.register(fastifyStatic, {
  root: BADGES_DIR,
  prefix: '/badges/',
  decorateReply: false,
  cacheControl: true,
  maxAge: '7d',
});

// --- Static: built client (SPA) ------------------------------------------
const hasClient = fs.existsSync(CLIENT_DIST);
if (hasClient) {
  await fastify.register(fastifyStatic, {
    root: CLIENT_DIST,
    prefix: '/',
    index: ['index.html'],
    decorateReply: true,
  });
}

// SPA fallback: any non-API GET that isn't a real file returns index.html so
// History-API client routes (e.g. /series/5) work on reload and iOS PWA.
fastify.setNotFoundHandler((request, reply) => {
  const url = request.raw.url || '';
  if (
    request.method === 'GET' &&
    !url.startsWith('/api/') &&
    !url.startsWith('/assets/') &&
    !url.startsWith('/badges/')
  ) {
    const indexFile = path.join(CLIENT_DIST, 'index.html');
    if (fs.existsSync(indexFile)) {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(fs.createReadStream(indexFile));
    }
  }
  reply.code(404);
  return reply.send({ error: 'not found' });
});

// One-time cache migration: normalize every cached image folder to a single
// .webp per image (renaming legacy .jpg files, dropping duplicates). Guarded by
// a settings flag, so it runs once and is a no-op thereafter.
try {
  const res = migrateCacheToWebp(db);
  if (res && res.renamed) fastify.log.info(`Cache migrated to WebP: ${res.renamed} file(s) normalized`);
} catch (err) {
  fastify.log.warn(`cache WebP migration skipped: ${err.message}`);
}

try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`shelfIt server listening on :${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

// Warm the in-RAM image cache with the highest-frequency images (Watching
// posters, What's Next stills, profile avatar/cover). Background + best-effort:
// it never delays startup, blocks requests, or fails the boot on missing files.
imageRamCache.warmUp(fastify.log);

// Daily Kodi library sync (22:00 server time). No-op unless the integration is
// enabled with a reachable active instance; discoveries wait for user review.
startKodiScheduler(fastify.log);

// Daily new-episode push check (~09:00 server time). No-op unless notifications
// are enabled with a stored subscription.
startPushScheduler(fastify.log);

// Magic-link housekeeping: purge expired tokens now (boot) and once daily.
startMagicCleanup(fastify.log);

// Access-log retention: prune entries older than 90 days now (boot) and daily.
startAccessLogCleanup(fastify.log);

// --- Graceful shutdown ----------------------------------------------------
// On `docker stop` (SIGTERM) or Ctrl-C (SIGINT), drain in-flight requests and
// checkpoint/close the SQLite connection cleanly instead of dying abruptly.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  fastify.log.info(`received ${signal} — shutting down`);
  try {
    await fastify.close(); // stop accepting, let in-flight requests finish
  } catch (err) {
    fastify.log.error(err);
  }
  try {
    db.close(); // flush the WAL checkpoint and release the file
  } catch (err) {
    fastify.log.error(err);
  }
  process.exit(0);
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    shutdown(sig);
  });
}

// Last-resort backstop: a single overlooked promise rejection would otherwise
// terminate the whole single-user server. Log it and keep running; the per-call
// .catch handlers throughout the codebase remain the primary defense.
process.on('unhandledRejection', (err) => {
  fastify.log.error({ err }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  fastify.log.error({ err }, 'uncaughtException');
});
