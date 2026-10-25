// Schema v0: the database as it stood before versioned migrations existed. A new
// database is built up to this shape first, and an old one created by an earlier
// build is brought up to it (the idempotent column additions and backfills below);
// after that, every change is a numbered entry in migrations.js. db.js calls this
// only while user_version is 0, so once a database has been migrated these legacy
// tables (e.g. `profile`, replaced by `users` in v1) are never recreated.

export function applyBaseline(db) {
  // --- Schema ---------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tmdb_id       TEXT NOT NULL UNIQUE,
      type          TEXT NOT NULL CHECK(type IN ('movie','show')),
      title_it      TEXT NOT NULL,
      title_orig    TEXT NOT NULL,
      status        TEXT NOT NULL CHECK(status IN (
                      'watching','completed','paused','dropped','plan_to_watch'
                    )) DEFAULT 'plan_to_watch',
      rating        INTEGER CHECK(rating BETWEEN 1 AND 5),
      notes         TEXT,
      rewatch_count INTEGER DEFAULT 0,
      added_at      TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS progress (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      season        INTEGER NOT NULL,
      episode       INTEGER NOT NULL,
      watch_count   INTEGER NOT NULL DEFAULT 1,
      watched_at    TEXT DEFAULT (datetime('now')),
      notes         TEXT,
      UNIQUE(item_id, season, episode)
    );

    -- Individual movie rewatch events (movies only; "movies" are items with
    -- type='movie'). The FIRST watch is NOT stored here — items.watch_date /
    -- updated_at represents it. Each row is one rewatch on a given date; the count
    -- of rows for a movie is kept in lockstep with items.rewatch_count (the fast
    -- display counter) inside a single transaction on every add/remove.
    CREATE TABLE IF NOT EXISTS movie_rewatches (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      watched_at    TEXT NOT NULL,          -- ISO date 'YYYY-MM-DD' (date only)
      created_at    INTEGER NOT NULL        -- server insert timestamp (ms epoch)
    );

    CREATE TABLE IF NOT EXISTS profile (
      id                INTEGER PRIMARY KEY CHECK(id = 1),
      display_name      TEXT NOT NULL DEFAULT 'My Watchlist',
      active_badge      TEXT,
      profile_image     TEXT,
      cover_image       TEXT
    );
    INSERT OR IGNORE INTO profile (id) VALUES (1);

    -- "The Wall" home section: the ONE favourite movie / show / person.
    -- Distinct from items.favorite (the per-title heart behind
    -- GET /api/profile/favorites) — this is a single pinned pick per kind.
    -- The title columns reference items(id) rather than a tmdb id so removing a
    -- title from the library clears the pick automatically (ON DELETE SET NULL);
    -- the PATCH routes accept a tmdb id and resolve it to the item.
    CREATE TABLE IF NOT EXISTS favorites (
      id             INTEGER PRIMARY KEY CHECK(id = 1),
      movie_item_id  INTEGER REFERENCES items(id) ON DELETE SET NULL,
      show_item_id   INTEGER REFERENCES items(id) ON DELETE SET NULL,
      person_tmdb_id INTEGER
    );
    INSERT OR IGNORE INTO favorites (id) VALUES (1);

    -- Lazy TMDB person cache (people have no other home in the schema).
    -- The credits column holds the combined_credits payload as JSON so the
    -- filmography rows render from cache without a second TMDB round-trip.
    CREATE TABLE IF NOT EXISTS persons (
      tmdb_id        INTEGER PRIMARY KEY,
      name           TEXT,
      biography      TEXT,
      birthday       TEXT,
      place_of_birth TEXT,
      profile_path   TEXT,
      credits        TEXT,
      cached_at      INTEGER
    );

    CREATE TABLE IF NOT EXISTS stats_cache (
      key           TEXT PRIMARY KEY,
      value         TEXT NOT NULL,
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key           TEXT PRIMARY KEY,
      value         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lists (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      type          TEXT NOT NULL CHECK(type IN ('movie','show')),
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS list_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id       INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      tmdb_id       INTEGER NOT NULL,
      added_at      INTEGER NOT NULL,
      UNIQUE(list_id, tmdb_id)
    );

    CREATE TABLE IF NOT EXISTS magic_links (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      token         TEXT NOT NULL UNIQUE,
      label         TEXT,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      last_used_at  INTEGER,
      use_count     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS kodi_instances (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      host          TEXT NOT NULL,
      port          INTEGER NOT NULL DEFAULT 8080,
      username      TEXT,
      password      TEXT,
      icon          TEXT,
      is_active     INTEGER NOT NULL DEFAULT 0
    );

    -- Minimal security audit trail for authentication events. Stores ONLY hashed
    -- identifiers (never a raw IP or user-agent) so it aids spotting suspicious
    -- activity without retaining personal data. Pruned to 90 days (see accessLog.js).
    CREATE TABLE IF NOT EXISTS access_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event           TEXT NOT NULL,
      ip_hash         TEXT NOT NULL,
      user_agent_hash TEXT NOT NULL,
      success         INTEGER NOT NULL,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_progress_item ON progress(item_id);
    CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
    CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
    CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id);
    CREATE INDEX IF NOT EXISTS idx_access_log_created ON access_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_movie_rewatches_item ON movie_rewatches(item_id);
  `);

  // --- Migrations -----------------------------------------------------------
  // Idempotent column additions for databases created by an older schema.
  function columnExists(table, column) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some((c) => c.name === column);
  }

  function ensureColumn(table, column, definition) {
    if (!columnExists(table, column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  ensureColumn('items', 'rewatch_count', 'INTEGER DEFAULT 0');
  ensureColumn('items', 'favorite', 'INTEGER NOT NULL DEFAULT 0');
  // Whether the user owns a physical copy (DVD/CD) of the title.
  ensureColumn('items', 'owned', 'INTEGER NOT NULL DEFAULT 0');
  // Cinema tracking (movies only): whether the user saw it at the cinema, and the
  // optional date/time of that screening (kept for the ticket-collection UI). The
  // columns exist on every row but are only ever written for movies.
  ensureColumn('items', 'watched_in_cinema', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('items', 'cinema_date', 'TEXT'); // ISO date 'YYYY-MM-DD', nullable
  ensureColumn('items', 'cinema_time', 'TEXT'); // 'HH:MM', nullable
  ensureColumn('items', 'cinema_name', 'TEXT'); // free text / from data/cinemas.txt, nullable
  // Artwork the user chose themselves (Detail options, "Change images"). Each
  // column holds the timestamp that slot was overridden; NULL means the image
  // still comes from TMDB / Fanart.tv and is replaced on every refresh. See
  // server/customImages.js.
  ensureColumn('items', 'custom_poster', 'TEXT');
  ensureColumn('items', 'custom_backdrop', 'TEXT');
  ensureColumn('items', 'custom_fanart', 'TEXT');
  // Denormalized copies of year + genres (genres as a JSON array string) so the
  // library list endpoint doesn't read every meta.json from disk. Backfilled
  // lazily from the cache on first read; NULL means "not yet populated".
  ensureColumn('items', 'year', 'TEXT');
  ensureColumn('items', 'genres', 'TEXT');
  // Per-instance icon (filename under client/dist/icons/kodi/); added after the
  // kodi_instances table shipped without it.
  ensureColumn('kodi_instances', 'icon', 'TEXT');
  // The season the user is currently working through for a series, updated on every
  // episode mark / rewatch. Powers What's Next rewatch resolution (see upcoming.js).
  // NULL until first set. On first add, backfill from the highest watched season so
  // existing series resolve immediately, before the next mark updates it.
  {
    const hadCurrentSeason = columnExists('items', 'current_season');
    ensureColumn('items', 'current_season', 'INTEGER');
    if (!hadCurrentSeason) {
      db.exec(`
        UPDATE items SET current_season = (
          SELECT MAX(p.season) FROM progress p WHERE p.item_id = items.id AND p.season > 0
        )
        WHERE type = 'show'
          AND EXISTS (SELECT 1 FROM progress p WHERE p.item_id = items.id AND p.season > 0)
      `);
    }
  }
  ensureColumn('progress', 'notes', 'TEXT');
  // Editable first-watch date for a movie (ISO 'YYYY-MM-DD'). NULL means "not set"
  // → consumers (receipt, XML export, detail display) fall back to date(updated_at),
  // preserving the pre-feature behaviour until the user edits the date.
  ensureColumn('items', 'watch_date', 'TEXT');
  ensureColumn('profile', 'active_badge', 'TEXT');
  ensureColumn('profile', 'profile_image', 'TEXT');
  ensureColumn('profile', 'cover_image', 'TEXT');

  // Backfill dated rewatch rows for movies that carry a rewatch_count from before
  // the movie_rewatches table existed. Each missing row is dated to the movie's
  // watched-on date (date(updated_at)). Self-healing / idempotent: add and remove
  // keep rewatch_count == row-count in lockstep, so once a movie is caught up this
  // inserts nothing on subsequent starts.
  {
    const gaps = db
      .prepare(
        `SELECT i.id AS item_id, date(i.updated_at) AS wd, i.rewatch_count AS rc,
                (SELECT COUNT(*) FROM movie_rewatches r WHERE r.item_id = i.id) AS have
           FROM items i
          WHERE i.type = 'movie' AND i.rewatch_count > 0`
      )
      .all();
    const insertBackfill = db.prepare(
      'INSERT INTO movie_rewatches (item_id, watched_at, created_at) VALUES (?, ?, ?)'
    );
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    db.transaction(() => {
      for (const g of gaps) {
        const missing = (g.rc || 0) - (g.have || 0);
        const wd = g.wd || today;
        for (let k = 0; k < missing; k++) insertBackfill.run(g.item_id, wd, now);
      }
    })();
  }
}
