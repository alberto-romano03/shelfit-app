import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  DATA_DIR,
  DB_PATH,
  CACHE_DIR,
  BADGES_DIR,
  IMPORT_DIR,
  PROFILE_DIR,
} from './config.js';
import { backupDatabase } from './backup.js';
import { runMigrations, schemaVersion } from './migrate.js';
import { MIGRATIONS, relocateLegacyAvatar } from './migrations.js';
import { applyBaseline } from './schemaBaseline.js';

// Ensure all persistent directories exist before opening the database.
for (const dir of [
  DATA_DIR,
  CACHE_DIR,
  path.join(CACHE_DIR, 'movies'),
  path.join(CACHE_DIR, 'shows'),
  path.join(CACHE_DIR, 'fanart'),
  path.join(CACHE_DIR, 'collections'),
  path.join(CACHE_DIR, 'persons'),
  BADGES_DIR,
  IMPORT_DIR,
  PROFILE_DIR,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

// A database created by this boot has nothing to back up before migrating.
const isNewDatabase = !fs.existsSync(DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Wait (rather than throwing SQLITE_BUSY immediately) if the write lock is
// briefly held by an external reader/writer — a backup tool, a manual sqlite3
// session, or the WAL checkpoint. Harmless under normal single-process use.
db.pragma('busy_timeout = 5000');

// --- Prepared-statement cache ----------------------------------------------
// better-sqlite3 compiles a fresh statement on every db.prepare() call, and the
// routes call prepare() inside their handlers (~160 sites) — so every request
// re-compiled its SQL and left the old statement for the GC to finalise. Memoize
// by SQL text: each distinct query is compiled once for the life of the process.
//
// Safe here because no call site uses the stateful statement modes (.iterate(),
// .pluck(), .raw(), .expand()) — every one runs .get/.all/.run, which are
// synchronous and therefore can never overlap on a shared statement.
//
// Bounded, because a handful of queries are assembled from a variable column
// list: past the cap the least-recently-used entry is dropped (and finalised by
// the GC like any other statement).
const STMT_CACHE_MAX = 500;
const stmtCache = new Map();
const compile = db.prepare.bind(db);
db.prepare = function prepareCached(sql) {
  const hit = stmtCache.get(sql);
  if (hit) {
    stmtCache.delete(sql);
    stmtCache.set(sql, hit); // most-recently-used
    return hit;
  }
  const stmt = compile(sql);
  stmtCache.set(sql, stmt);
  while (stmtCache.size > STMT_CACHE_MAX) stmtCache.delete(stmtCache.keys().next().value);
  return stmt;
};

// --- Schema ---------------------------------------------------------------
// The v0 baseline (schemaBaseline.js) applies only to a database that has not been
// migrated yet: a brand-new file, or one from a build that predates versioning.
// Every later change lives in migrations.js and is applied here, once each,
// behind an automatic backup. A failure throws, which stops the boot with the
// database left at its last good version.
if (schemaVersion(db) === 0) applyBaseline(db);
runMigrations(db, MIGRATIONS, {
  backup: isNewDatabase ? null : backupDatabase,
  // eslint-disable-next-line no-console
  log: (msg) => console.log(msg),
});
relocateLegacyAvatar(db);

export default db;
