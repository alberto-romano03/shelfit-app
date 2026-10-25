// Versioned schema migrations, tracked in PRAGMA user_version.
//
// The schema block and ensureColumn() calls in db.js are the baseline (version 0):
// every database, new or old, is brought up to it first. Changes after that are
// entries in server/migrations.js, applied here in order, each exactly once:
//
//   { version: 1, name: 'short description', up(db) { ... }, foreignKeys: false }
//
// Rules the runner enforces:
//   - versions are 1, 2, 3... with no gaps or duplicates;
//   - a database whose user_version is newer than the newest migration this build
//     knows is refused, so an older build can never run against a newer schema;
//   - before the first pending migration, a verified backup is taken (skipped for a
//     database created by this very boot, which holds nothing worth keeping);
//   - each migration runs in its own transaction together with its user_version
//     bump, so a failure leaves the database at the last good version;
//   - `foreignKeys: false` runs the migration with foreign key enforcement off (the
//     SQLite table-rebuild procedure needs it) and fails it unless
//     PRAGMA foreign_key_check comes back clean before the commit.

import { backupDatabase } from './backup.js';

export function schemaVersion(db) {
  return db.pragma('user_version', { simple: true });
}

function validate(migrations) {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`migration #${i + 1} has version ${m.version}; versions must be 1, 2, 3... in order`);
    }
    if (typeof m.up !== 'function') throw new Error(`migration v${m.version} has no up()`);
  });
}

// Bring `db` up to the newest version in `migrations`. `backup` is the snapshot
// function (null skips it). Returns { from, to, applied, backup }.
export function runMigrations(db, migrations, { backup = backupDatabase, log = () => {} } = {}) {
  validate(migrations);
  const latest = migrations.length;
  const from = schemaVersion(db);
  if (from > latest) {
    throw new Error(
      `database schema is v${from} but this build only knows up to v${latest}; ` +
        'refusing to start (restore a matching backup or run a newer build)'
    );
  }
  const pending = migrations.slice(from);
  if (!pending.length) return { from, to: from, applied: [], backup: null };

  let snapshot = null;
  if (backup) {
    snapshot = backup(db, { label: `pre-v${latest}` });
    log(`schema: backed up to ${snapshot.file} before migrating v${from} -> v${latest}`);
  }

  const applied = [];
  for (const m of pending) {
    const fkOff = m.foreignKeys === false;
    if (fkOff) db.pragma('foreign_keys = OFF'); // must be set outside the transaction
    try {
      db.transaction(() => {
        m.up(db);
        if (fkOff) {
          const broken = db.pragma('foreign_key_check');
          if (broken.length) {
            throw new Error(`foreign key check failed (${broken.length} rows, first in ${broken[0].table})`);
          }
        }
        db.pragma(`user_version = ${m.version}`);
      })();
    } catch (err) {
      throw new Error(`schema migration v${m.version} (${m.name}) failed and was rolled back: ${err.message}`);
    } finally {
      if (fkOff) db.pragma('foreign_keys = ON');
    }
    applied.push(m.version);
    log(`schema: applied v${m.version} (${m.name})`);
  }
  return { from, to: latest, applied, backup: snapshot ? snapshot.file : null };
}
