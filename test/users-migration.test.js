// Upgrading a single-user database (as written by a build before accounts
// existed) to schema v1: the one profile and password become the master account
// and nothing in the library changes.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyBaseline } from '../server/schemaBaseline.js';
import { startApp, login, client } from './helpers/harness.js';

const OLD_PASSWORD = 'old-password';
const MAGIC_TOKEN = 'ab'.repeat(32);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

// The pre-v1 password format: scrypt N=16384 stored as `salt:hash`.
function legacyHash(password) {
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function plantLegacyDatabase(dataDir) {
  const db = new Database(path.join(dataDir, 'shelfit.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyBaseline(db);
  db.prepare(
    "UPDATE profile SET display_name = 'albe', active_badge = 'hp_badge.png', profile_image = 'custom', cover_image = 'movie:603' WHERE id = 1"
  ).run();
  const setting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  setting.run('auth:password_hash', legacyHash(OLD_PASSWORD));
  setting.run('auth:session_generation', '3');
  setting.run('tmdb_language', 'en-US');
  setting.run('push_enabled', '1');
  const movie = db
    .prepare("INSERT INTO items (tmdb_id, type, title_it, title_orig, status, rating) VALUES ('603', 'movie', 'The Matrix', 'The Matrix', 'completed', 5)")
    .run().lastInsertRowid;
  const show = db
    .prepare("INSERT INTO items (tmdb_id, type, title_it, title_orig, status) VALUES ('1396', 'show', 'Breaking Bad', 'Breaking Bad', 'watching')")
    .run().lastInsertRowid;
  db.prepare('INSERT INTO progress (item_id, season, episode) VALUES (?, 1, 1), (?, 1, 2)').run(show, show);
  db.prepare('UPDATE favorites SET movie_item_id = ? WHERE id = 1').run(movie);
  db.prepare(
    'INSERT INTO magic_links (token, label, created_at, expires_at, use_count) VALUES (?, ?, ?, ?, 0)'
  ).run(MAGIC_TOKEN, 'TV', Date.now(), Date.now() + 86400000);
  db.prepare(
    "INSERT INTO access_log (event, ip_hash, user_agent_hash, success, created_at) VALUES ('login', 'x', 'y', 1, ?)"
  ).run(Date.now());
  db.close();
  fs.mkdirSync(path.join(dataDir, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'profile', 'avatar.jpg'), JPEG);
}

describe('v1 migration of a single-user database', () => {
  let h;
  let cookie;

  before(async () => {
    h = await startApp({ password: null, prepare: plantLegacyDatabase });
  });
  after(async () => {
    if (h) await h.close();
  });

  it('turns the profile and password into the master account', () => {
    assert.equal(h.db.pragma('user_version', { simple: true }) >= 1, true);
    const users = h.db.prepare('SELECT * FROM users').all();
    assert.equal(users.length, 1);
    const [master] = users;
    assert.equal(master.id, 1);
    assert.equal(master.role, 'master');
    assert.equal(master.display_name, 'albe');
    assert.equal(master.active_badge, 'hp_badge.png');
    assert.equal(master.profile_image, 'custom');
    assert.equal(master.cover_image, 'movie:603');
    assert.equal(master.session_generation, 3);
    assert.doesNotMatch(master.password_hash, /^s2:/, 'the legacy hash is carried over as is');
  });

  it('drops the old profile table and auth settings, keeps everything else', () => {
    const tables = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.ok(!tables.includes('profile'));
    assert.ok(tables.includes('sessions'));
    const keys = h.db.prepare('SELECT key FROM settings').all().map((r) => r.key);
    assert.ok(!keys.some((k) => k.startsWith('auth:')));
    assert.ok(keys.includes('push_enabled'));
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM items').get().c, 2);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM progress').get().c, 2);
    assert.equal(h.db.prepare('SELECT movie_item_id FROM favorites').get().movie_item_id, 1);
    assert.equal(h.db.prepare('SELECT user_id FROM magic_links').get().user_id, 1);
    assert.equal(h.db.prepare('SELECT user_id FROM access_log').get().user_id, null);
  });

  it('took a verified backup of the old database first', () => {
    const dir = path.join(h.dataDir, 'backups');
    const files = fs.readdirSync(dir).filter((f) => /^shelfit-pre-v\d+-.*\.db$/.test(f));
    assert.equal(files.length, 1);
    const copy = new Database(path.join(dir, files[0]), { readonly: true });
    assert.equal(copy.prepare('SELECT display_name FROM profile').get().display_name, 'albe');
    assert.equal(copy.pragma('user_version', { simple: true }), 0);
    copy.close();
  });

  it('moves the profile photo into the master folder', () => {
    assert.ok(!fs.existsSync(path.join(h.dataDir, 'profile', 'avatar.jpg')));
    assert.deepEqual(fs.readFileSync(path.join(h.dataDir, 'profile', '1', 'avatar.jpg')), JPEG);
  });

  it('signs in with the old password and upgrades its hash', async () => {
    cookie = await login(h.app, OLD_PASSWORD);
    assert.match(cookie, /^shelfit_session=[a-f0-9]{64}$/);
    assert.match(h.db.prepare('SELECT password_hash FROM users WHERE id = 1').get().password_hash, /^s2:/);
    // Still the same password after the rehash.
    await login(h.app, OLD_PASSWORD, 1);

    const api = client(h.app, cookie);
    const profile = (await api.get('/api/profile')).json;
    assert.equal(profile.display_name, 'albe');
    assert.equal(profile.has_custom_photo, true);
    assert.match(profile.profile_image_url, /^\/api\/profile\/photo\?v=\d+$/);
    assert.equal((await api.get('/api/profile/photo')).status, 200);
  });

  it('stores only a hash of the session token', () => {
    const token = cookie.split('=')[1];
    const rows = h.db.prepare('SELECT token_hash FROM sessions').all().map((r) => r.token_hash);
    assert.ok(!rows.includes(token));
    assert.ok(rows.includes(crypto.createHash('sha256').update(token).digest('hex')));
  });

  it('keeps sessions valid across a restart', async () => {
    const { buildApp } = await import('../server/app.js');
    const fresh = await buildApp({ quiet: true });
    await fresh.ready();
    try {
      const res = await client(fresh, cookie).get('/api/profile');
      assert.equal(res.status, 200);
      assert.equal(res.json.display_name, 'albe');
    } finally {
      await fresh.close();
    }
  });

  it('redeems an existing magic link as the master', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/api/auth/magic/${MAGIC_TOKEN}` });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/shelfit/');
    const linkCookie = [].concat(res.headers['set-cookie'])[0].split(';')[0];
    const status = (await client(h.app, linkCookie).get('/api/auth/status')).json;
    assert.equal(status.user.id, 1);
  });
});
