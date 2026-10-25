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
