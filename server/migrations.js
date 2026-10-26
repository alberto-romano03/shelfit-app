// Ordered schema migrations applied on top of the db.js baseline. See migrate.js
// for the contract. Append only: never edit or reorder an entry that has shipped.

import fs from 'node:fs';
import path from 'node:path';
import { PROFILE_DIR } from './config.js';
import { schemaVersion } from './migrate.js';

export const MIGRATIONS = [
  {
    // Household accounts. The single-user `profile` row and the password kept in
    // `settings` become user 1, the master account; sessions move from process
    // memory into the database so a restart no longer signs everyone out.
    version: 1,
    name: 'users and persisted sessions',
    up(db) {
      db.exec(`
        CREATE TABLE users (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          role               TEXT NOT NULL CHECK(role IN ('master','member')) DEFAULT 'member',
          display_name       TEXT NOT NULL,
          password_hash      TEXT,            -- NULL until the member sets one
          session_generation INTEGER NOT NULL DEFAULT 1,
          active_badge       TEXT,
          profile_image      TEXT,            -- 'custom' or a 'movie:123' / 'show:123' token
          cover_image        TEXT,
          avatar_color       TEXT,            -- picker tile colour when there is no image
          sort_order         INTEGER NOT NULL DEFAULT 0,
          disabled           INTEGER NOT NULL DEFAULT 0,
          created_at         INTEGER NOT NULL,
          last_login_at      INTEGER
        );
        -- Exactly one master per instance.
        CREATE UNIQUE INDEX idx_users_one_master ON users(role) WHERE role = 'master';

        -- Only a SHA-256 of the cookie token is stored, so a copy of the database
        -- cannot be replayed as a login.
        CREATE TABLE sessions (
          token_hash    TEXT PRIMARY KEY,
          user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          generation    INTEGER NOT NULL,     -- must equal users.session_generation
          created_at    INTEGER NOT NULL,
          last_seen_at  INTEGER NOT NULL,
          label         TEXT                  -- coarse device description
        );
        CREATE INDEX idx_sessions_user ON sessions(user_id);
      `);

      const setting = (key) => {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row ? row.value : null;
      };
      const profile = db.prepare('SELECT * FROM profile WHERE id = 1').get() || {};
      // The old schema defaulted the name to 'My Watchlist'; on a profile picker a
      // person's name is what belongs on the tile.
      const name =
        profile.display_name && profile.display_name !== 'My Watchlist' ? profile.display_name : 'Admin';
      const generation = parseInt(setting('auth:session_generation'), 10);
      db.prepare(
        `INSERT INTO users (id, role, display_name, password_hash, session_generation,
                            active_badge, profile_image, cover_image, created_at)
         VALUES (1, 'master', ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        name,
        setting('auth:password_hash'),
        generation > 0 ? generation : 1,
        profile.active_badge || null,
        profile.profile_image || null,
        profile.cover_image || null,
        Date.now()
      );

      // Magic links and auth events now name the account they belong to. Existing
      // links were created by the only user there was.
      db.exec('ALTER TABLE magic_links ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
      db.exec('UPDATE magic_links SET user_id = 1');
      db.exec('ALTER TABLE access_log ADD COLUMN user_id INTEGER');

      db.exec("DELETE FROM settings WHERE key IN ('auth:password_hash', 'auth:session_generation')");
      db.exec('DROP TABLE profile');
    },
  },
  {
    // Per-member libraries. Every library entry, list and Wall pick gets an owner;
    // everything that exists today belongs to the master. Item and list ids are
    // kept (progress, rewatches, list entries, client URLs and offline caches all
    // refer to them), and so is each table's AUTOINCREMENT high-water mark, so a
    // deleted id is never handed out again. Custom artwork moves out of `items`
    // into `title_art`: it is a household choice, shared like the image cache.
    version: 2,
    name: 'per-member libraries',
    foreignKeys: false,
    up(db) {
      const master = db.prepare("SELECT id FROM users WHERE role = 'master'").get();
      if (!master) throw new Error('no master account');
      const owner = master.id;
      const seqOf = (name) => {
        const row = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(name);
        return row ? row.seq : 0;
      };
      const restoreSeq = (name, oldSeq) => {
        const maxId = db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${name}`).get().m;
        db.prepare('DELETE FROM sqlite_sequence WHERE name IN (?, ?)').run(name, `${name}_new`);
        // CAST: a JS number binds as REAL, and seq is an integer column by convention.
        db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, CAST(? AS INTEGER))').run(
          name,
          Math.max(oldSeq, maxId)
        );
      };

      db.exec(`
        CREATE TABLE title_art (
          type       TEXT NOT NULL CHECK(type IN ('movie','show')),
          tmdb_id    TEXT NOT NULL,
          slot       TEXT NOT NULL CHECK(slot IN ('poster','backdrop','fanart')),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (type, tmdb_id, slot)
        ) WITHOUT ROWID;
        INSERT OR IGNORE INTO title_art SELECT type, tmdb_id, 'poster', custom_poster FROM items WHERE custom_poster IS NOT NULL;
        INSERT OR IGNORE INTO title_art SELECT type, tmdb_id, 'backdrop', custom_backdrop FROM items WHERE custom_backdrop IS NOT NULL;
        INSERT OR IGNORE INTO title_art SELECT type, tmdb_id, 'fanart', custom_fanart FROM items WHERE custom_fanart IS NOT NULL;
      `);

      // items: + user_id, UNIQUE(user_id, type, tmdb_id) replaces the global
      // UNIQUE(tmdb_id), custom_* columns dropped.
      const itemsSeq = seqOf('items');
      db.exec(`
        CREATE TABLE items_new (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          tmdb_id           TEXT NOT NULL,
          type              TEXT NOT NULL CHECK(type IN ('movie','show')),
          title_it          TEXT NOT NULL,
          title_orig        TEXT NOT NULL,
          status            TEXT NOT NULL CHECK(status IN (
                              'watching','completed','paused','dropped','plan_to_watch'
                            )) DEFAULT 'plan_to_watch',
          rating            INTEGER CHECK(rating BETWEEN 1 AND 5),
          notes             TEXT,
          rewatch_count     INTEGER DEFAULT 0,
          added_at          TEXT DEFAULT (datetime('now')),
          updated_at        TEXT DEFAULT (datetime('now')),
          favorite          INTEGER NOT NULL DEFAULT 0,
          owned             INTEGER NOT NULL DEFAULT 0,
          watched_in_cinema INTEGER NOT NULL DEFAULT 0,
          cinema_date       TEXT,
          cinema_time       TEXT,
          cinema_name       TEXT,
          year              TEXT,
          genres            TEXT,
          current_season    INTEGER,
          watch_date        TEXT,
          UNIQUE(user_id, type, tmdb_id)
        );
      `);
      const cols =
        'id, tmdb_id, type, title_it, title_orig, status, rating, notes, rewatch_count, added_at, ' +
        'updated_at, favorite, owned, watched_in_cinema, cinema_date, cinema_time, cinema_name, year, ' +
        'genres, current_season, watch_date';
      db.prepare(`INSERT INTO items_new (user_id, ${cols}) SELECT ?, ${cols} FROM items`).run(owner);
      db.exec(`
        DROP TABLE items;
        ALTER TABLE items_new RENAME TO items;
        CREATE INDEX idx_items_user_status ON items(user_id, status);
        CREATE INDEX idx_items_user_type ON items(user_id, type);
        CREATE INDEX idx_items_title ON items(type, tmdb_id);
      `);
      restoreSeq('items', itemsSeq);

      // lists: + user_id.
      const listsSeq = seqOf('lists');
      db.exec(`
        CREATE TABLE lists_new (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name       TEXT NOT NULL,
          type       TEXT NOT NULL CHECK(type IN ('movie','show')),
          created_at INTEGER NOT NULL
        );
      `);
      db.prepare(
        'INSERT INTO lists_new (id, user_id, name, type, created_at) SELECT id, ?, name, type, created_at FROM lists'
      ).run(owner);
      db.exec(`
        DROP TABLE lists;
        ALTER TABLE lists_new RENAME TO lists;
        CREATE INDEX idx_lists_user ON lists(user_id);
      `);
      restoreSeq('lists', listsSeq);

      // favorites (The Wall): one row per member instead of the id = 1 singleton.
      db.exec(`
        CREATE TABLE favorites_new (
          user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          movie_item_id  INTEGER REFERENCES items(id) ON DELETE SET NULL,
          show_item_id   INTEGER REFERENCES items(id) ON DELETE SET NULL,
          person_tmdb_id INTEGER
        );
      `);
      db.prepare(
        `INSERT INTO favorites_new (user_id, movie_item_id, show_item_id, person_tmdb_id)
         SELECT ?, movie_item_id, show_item_id, person_tmdb_id FROM favorites WHERE id = 1`
      ).run(owner);
      db.exec(`
        DROP TABLE favorites;
        ALTER TABLE favorites_new RENAME TO favorites;
      `);

      // Stats are cached per member from now on ('summary:<user id>').
      db.exec("DELETE FROM stats_cache WHERE key = 'summary'");
    },
  },
  {
    // One-time links with which a member sets their own password: when the master
    // adds them, and again whenever the master resets it. Only a SHA-256 of the
    // token is stored; a row is deleted the moment it is used.
    version: 3,
    name: 'household invites',
    up(db) {
      db.exec(`
        CREATE TABLE invites (
          token_hash TEXT PRIMARY KEY,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX idx_invites_user ON invites(user_id);
      `);
    },
  },
  {
    // Web Push per device: each browser subscription belongs to the member who
    // enabled notifications on it, replacing the single subscription kept in
    // `settings`. The existing one (if notifications were on) moves over to its
    // owner, the master for anything stored before accounts existed.
    version: 4,
    name: 'push subscriptions per device',
    up(db) {
      db.exec(`
        CREATE TABLE push_subscriptions (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          endpoint   TEXT NOT NULL UNIQUE,
          keys       TEXT NOT NULL,            -- JSON { p256dh, auth }
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_push_user ON push_subscriptions(user_id);
      `);
      const setting = (key) => {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row ? row.value : null;
      };
      let sub = null;
      try {
        sub = JSON.parse(setting('push_subscription') || 'null');
      } catch {
        sub = null;
      }
      const owner =
        parseInt(setting('push_user'), 10) || db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
      const ownerExists = !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(owner);
      if (setting('push_enabled') === '1' && sub && sub.endpoint && sub.keys && ownerExists) {
        db.prepare(
          'INSERT INTO push_subscriptions (user_id, endpoint, keys, created_at) VALUES (?, ?, ?, ?)'
        ).run(owner, sub.endpoint, JSON.stringify(sub.keys), Date.now());
      }
      db.exec("DELETE FROM settings WHERE key IN ('push_subscription', 'push_enabled', 'push_user')");
    },
  },
  {
    // Whose library a Kodi instance syncs into. Kodi tracks "watched" per Kodi
    // profile, not per person, so each instance names one member; NULL (and a
    // removed member) means the master, which is what every sync did until now.
    version: 5,
    name: 'kodi sync owner',
    up(db) {
      db.exec('ALTER TABLE kodi_instances ADD COLUMN sync_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
    },
  },
];

// Filesystem half of v1: the one custom profile photo moves from
// data/profile/avatar.<ext> into the master's own folder, data/profile/<id>/.
// The filesystem isn't transactional, so this can't live inside the migration;
// instead it runs on every boot and does nothing once the move is done. It never
// overwrites: if the master already has a photo, the legacy file is left alone.
export function relocateLegacyAvatar(db) {
  if (schemaVersion(db) < 1) return;
  let legacy;
  try {
    legacy = fs
      .readdirSync(PROFILE_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && /^avatar\.[a-z0-9]+$/i.test(e.name))
      .map((e) => e.name);
  } catch {
    return;
  }
  if (!legacy.length) return;
  const master = db.prepare("SELECT id FROM users WHERE role = 'master'").get();
  if (!master) return;
  const dest = path.join(PROFILE_DIR, String(master.id));
  fs.mkdirSync(dest, { recursive: true });
  if (fs.readdirSync(dest).some((f) => f.startsWith('avatar.'))) return;
  for (const name of legacy) fs.renameSync(path.join(PROFILE_DIR, name), path.join(dest, name));
}
