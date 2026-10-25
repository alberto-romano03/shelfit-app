// Consistent point-in-time copies of the SQLite database.
//
// `VACUUM INTO` writes a complete, compacted copy through SQLite itself, so it is
// safe while the app holds the database open in WAL mode (a plain file copy could
// miss pages still sitting in the -wal file). Every copy is then reopened
// read-only and checked: integrity check plus a row count per table compared with
// the live database. A copy that fails the check is deleted and the call throws,
// so a caller (the migration runner) never proceeds on a backup it can't trust.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BACKUPS_DIR } from './config.js';

// 'YYYYMMDD-HHMMSS' in UTC, matching the existing data/backups/shelfit-<stamp>.db name.
function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

// Row count of every user table, keyed by table name.
function tableCounts(conn) {
  const names = conn
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const counts = {};
  for (const name of names) {
    counts[name] = conn.prepare(`SELECT COUNT(*) AS c FROM "${name.replace(/"/g, '""')}"`).get().c;
  }
  return counts;
}

// Write a verified copy of `db` to `<dir>/shelfit-<label>-<stamp>.db` and return
// { file, counts }. Throws (leaving no file behind) when the copy can't be
// written or doesn't match the source.
export function backupDatabase(db, { dir = BACKUPS_DIR, label = 'manual' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const base = `shelfit-${label}-${stamp()}`;
  let file = path.join(dir, `${base}.db`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base}-${n}.db`);

  db.prepare('VACUUM INTO ?').run(file);

  let copy;
  try {
    copy = new Database(file, { readonly: true, fileMustExist: true });
    const check = copy.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new Error(`integrity check failed: ${check}`);
    const expected = tableCounts(db);
    const actual = tableCounts(copy);
    for (const [name, c] of Object.entries(expected)) {
      if (actual[name] !== c) {
        throw new Error(`table ${name}: ${c} rows in the database, ${actual[name]} in the copy`);
      }
    }
    copy.close();
    return { file, counts: expected };
  } catch (err) {
    if (copy) copy.close();
    fs.rmSync(file, { force: true });
    throw new Error(`database backup failed: ${err.message}`);
  }
}
