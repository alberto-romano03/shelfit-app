import { PORT } from './config.js';
import db from './db.js'; // opens DB, creates dirs, runs migrations on import
import { migrateCacheToWebp } from './cache.js';
import { startMagicCleanup } from './magicLinks.js';
import { startAccessLogCleanup } from './accessLog.js';
import { startSessionCleanup } from './auth.js';
import { startKodiScheduler } from './kodiSync.js';
import { startPushScheduler } from './push.js';
import { imageRamCache } from './imageRamCache.js';
import { buildApp } from './app.js';

const fastify = await buildApp();

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

// Sessions idle for longer than the cookie lifetime (a year): prune now and daily.
startSessionCleanup(fastify.log);

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
