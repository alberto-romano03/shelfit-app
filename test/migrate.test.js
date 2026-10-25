// The migration runner and the backup helper, on standalone throwaway databases.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfit-migrate-'));
process.env.SHELFIT_DATA_DIR = root; // never let a default path point at real data
const { runMigrations, schemaVersion } = await import('../server/migrate.js');
const { backupDatabase } = await import('../server/backup.js');

let seq = 0;
function freshDb() {
  const file = path.join(root, `db-${++seq}.db`);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
    INSERT INTO parent (id, name) VALUES (1, 'a'), (2, 'b');
    INSERT INTO child (parent_id) VALUES (1), (2), (2);
  `);
  return db;
}

function backupsIn(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.db')) : [];
}

const addColor = { version: 1, name: 'add color', up: (db) => db.exec('ALTER TABLE parent ADD COLUMN color TEXT') };
const addSize = { version: 2, name: 'add size', up: (db) => db.exec('ALTER TABLE parent ADD COLUMN size INTEGER') };

after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('runMigrations', () => {
  it('applies pending migrations in order after one backup', () => {
    const db = freshDb();
    const dir = path.join(root, 'b1');
    const res = runMigrations(db, [addColor, addSize], {
      backup: (conn, opts) => backupDatabase(conn, { ...opts, dir }),
    });
    assert.deepEqual(res.applied, [1, 2]);
    assert.equal(schemaVersion(db), 2);
    assert.equal(backupsIn(dir).length, 1);
    assert.match(backupsIn(dir)[0], /^shelfit-pre-v2-\d{8}-\d{6}\.db$/);

    // The backup holds the database as it was BEFORE the migrations.
    const copy = new Database(res.backup, { readonly: true });
    const cols = copy.prepare('PRAGMA table_info(parent)').all().map((c) => c.name);
    assert.deepEqual(cols, ['id', 'name']);
    assert.equal(copy.pragma('user_version', { simple: true }), 0);
    copy.close();
    db.close();
  });

  it('does nothing (and takes no backup) when up to date', () => {
    const db = freshDb();
    runMigrations(db, [addColor], { backup: null });
    let called = false;
    const res = runMigrations(db, [addColor], { backup: () => { called = true; } });
    assert.deepEqual(res.applied, []);
    assert.equal(called, false);
    db.close();
  });

  it('only applies the migrations newer than the database', () => {
    const db = freshDb();
    runMigrations(db, [addColor], { backup: null });
    const res = runMigrations(db, [addColor, addSize], { backup: null });
    assert.deepEqual(res.applied, [2]);
    assert.equal(res.from, 1);
    db.close();
  });

  it('rolls back a failing migration and keeps the earlier ones', () => {
    const db = freshDb();
    const broken = {
      version: 2,
      name: 'broken',
      up: (conn) => {
        conn.exec("UPDATE parent SET name = 'changed'");
        throw new Error('boom');
      },
    };
    assert.throws(() => runMigrations(db, [addColor, broken], { backup: null }), /v2 \(broken\) failed.*boom/);
    assert.equal(schemaVersion(db), 1);
    assert.deepEqual(
      db.prepare('SELECT name FROM parent ORDER BY id').all().map((r) => r.name),
      ['a', 'b']
    );
    db.close();
  });

  it('refuses a database newer than the build', () => {
    const db = freshDb();
    db.pragma('user_version = 5');
    assert.throws(() => runMigrations(db, [addColor], { backup: null }), /schema is v5.*only knows up to v1/);
    db.close();
  });

  it('rejects gaps or disorder in the migration list', () => {
    const db = freshDb();
    assert.throws(() => runMigrations(db, [addSize], { backup: null }), /must be 1, 2, 3/);
    assert.throws(() => runMigrations(db, [addColor, addColor], { backup: null }), /must be 1, 2, 3/);
    db.close();
  });

  it('does not migrate when the backup fails', () => {
    const db = freshDb();
    const failing = () => {
      throw new Error('disk full');
    };
    assert.throws(() => runMigrations(db, [addColor], { backup: failing }), /disk full/);
    assert.equal(schemaVersion(db), 0);
    db.close();
  });

  it('rebuilds a referenced table with foreign keys off, keeping ids', () => {
    const db = freshDb();
    const rebuild = {
      version: 1,
      name: 'rebuild parent',
      foreignKeys: false,
      up: (conn) => {
        conn.exec(`
          CREATE TABLE parent_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner INTEGER NOT NULL DEFAULT 1);
          INSERT INTO parent_new (id, name) SELECT id, name FROM parent;
          DROP TABLE parent;
          ALTER TABLE parent_new RENAME TO parent;
        `);
      },
    };
    runMigrations(db, [rebuild], { backup: null });
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'enforcement is back on');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    // The child rows still resolve, and the cascade still works on the new table.
    db.prepare('DELETE FROM parent WHERE id = 2').run();
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM child').get().c, 1);
    db.close();
  });

  it('fails a foreign-keys-off migration that leaves dangling references', () => {
    const db = freshDb();
    const dangling = {
      version: 1,
      name: 'drop a parent',
      foreignKeys: false,
      up: (conn) => conn.exec('DELETE FROM parent WHERE id = 1'),
    };
    assert.throws(() => runMigrations(db, [dangling], { backup: null }), /foreign key check failed/);
    assert.equal(schemaVersion(db), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM parent').get().c, 2);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    db.close();
  });
});

describe('backupDatabase', () => {
  let db;
  let dir;
  before(() => {
    db = freshDb();
    dir = path.join(root, 'b2');
  });
  after(() => db.close());

  it('writes a verified copy that includes uncheckpointed WAL writes', () => {
    db.prepare("INSERT INTO parent (id, name) VALUES (3, 'c')").run(); // lives in the -wal file
    const { file, counts } = backupDatabase(db, { dir, label: 'manual' });
    assert.deepEqual(counts, { child: 3, parent: 3 });
    assert.equal(path.dirname(file), dir);
    const copy = new Database(file, { readonly: true });
    assert.equal(copy.prepare('SELECT name FROM parent WHERE id = 3').get().name, 'c');
    copy.close();
  });

  it('never overwrites an existing backup', () => {
    const a = backupDatabase(db, { dir, label: 'same' }).file;
    const b = backupDatabase(db, { dir, label: 'same' }).file;
    assert.notEqual(a, b);
    assert.ok(fs.existsSync(a) && fs.existsSync(b));
  });
});
