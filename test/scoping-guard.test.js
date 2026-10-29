// Static guard for per-member data: every SQL statement in server/ that touches a
// library table must be bound to a member, or be a deliberate exception listed
// below. A new query that forgets `user_id` fails this test instead of quietly
// showing one member another member's library.
//
// The rules, per SQL string literal. Any table: mentioning user_id passes, and so
// does an UPDATE ... WHERE id = ? (an update by primary key, always made after the
// row was loaded with its owner checked). Otherwise:
//   items / lists / favorites    fail;
//   progress / movie_rewatches   must filter `item_id = ?` or be an INSERT
//                                (children of an item already checked);
//   list_items                   must filter `list_id = ?` or be an INSERT.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
const SKIP = new Set(['schemaBaseline.js', 'migrations.js']); // schema definitions, not queries

// Deliberate exceptions: instance-wide work over the shared catalog, or queries
// whose WHERE clause is assembled at runtime (and always starts with user_id).
// Keyed by file, matched by a distinctive fragment of the statement.
const ALLOWED = {
  'imageRamCache.js': [
    "FROM items WHERE status = 'watching'", // warms every member's posters (shared images)
    "FROM items WHERE type = 'show' AND status = 'watching'",
    'FROM progress WHERE season > 0',
  ],
  'language.js': ['SELECT 1 FROM items LIMIT 1'], // "is this an existing install?"
  'metaBackfill.js': [
    'SELECT DISTINCT type, tmdb_id FROM items', // which titles still lack shared cache data
    'UPDATE items SET title_it = ?, title_orig = ?, year = ?, genres = ? WHERE type = ? AND tmdb_id = ?', // catalog fields
  ],
  'routes/admin.js': ['SELECT DISTINCT tmdb_id FROM items'], // refresh every ongoing title once
  'routes/settings.js': [
    'SELECT type, tmdb_id FROM items GROUP BY type, tmdb_id', // language switch: each title once
    'UPDATE items SET title_it = ?, title_orig = ? WHERE type = ? AND tmdb_id = ?',
  ],
  'routes/media.js': [
    'SELECT 1 FROM items WHERE type = ? AND tmdb_id = ? LIMIT 1', // is the shared cache still used?
    'SELECT * FROM items ${where}', // `where` always begins with user_id = ?
  ],
  'routes/household.js': [
    'SELECT 1 FROM items WHERE type = ? AND tmdb_id = ? LIMIT 1', // removing a member: is the cache still used?
  ],
  'kodi.js': [
    'SELECT title_it, title_orig, year FROM items WHERE tmdb_id = ? AND type = ? LIMIT 1', // catalog title
    'SELECT status, rewatch_count FROM items WHERE id = ?', // row already matched to the viewer
  ],
};

// Every string and template literal in a JS source, comments skipped.
function literals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      if (i < 0) break;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out.push(src.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

function sourceFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full, base);
    return e.name.endsWith('.js') ? [path.relative(base, full).split(path.sep).join('/')] : [];
  });
}

const TABLE_RE = /\b(?:FROM|INTO|UPDATE|JOIN)\s+(items|lists|favorites|progress|movie_rewatches|list_items)\b/gi;

function violation(sql) {
  const tables = new Set([...sql.matchAll(TABLE_RE)].map((m) => m[1].toLowerCase()));
  if (!tables.size || /\buser_id\b/.test(sql)) return null;
  if (/^\s*UPDATE\s+\w+\s+SET\b[\s\S]*\bWHERE\s+id\s*=\s*\?\s*$/i.test(sql)) return null;
  const insert = /^\s*INSERT\b/i.test(sql);
  for (const t of tables) {
    if (t === 'items' || t === 'lists' || t === 'favorites') {
      return t;
    } else if (t === 'list_items') {
      if (!insert && !/\blist_id\s*=\s*\?/i.test(sql)) return t;
    } else if (!insert && !/\bitem_id\s*=\s*\?/i.test(sql)) {
      return t;
    }
  }
  return null;
}

describe('per-member scoping guard', () => {
  it('flags what it should and passes what it should', () => {
    assert.equal(violation('SELECT * FROM items WHERE id = ?'), 'items');
    assert.equal(violation("SELECT id FROM items WHERE status = 'watching'"), 'items');
    assert.equal(violation('SELECT * FROM lists WHERE id = ?'), 'lists');
    assert.equal(violation('SELECT item_id, season FROM progress WHERE season > 0'), 'progress');
    assert.equal(violation('DELETE FROM list_items WHERE tmdb_id = ?'), 'list_items');
    assert.equal(violation('SELECT * FROM items WHERE id = ? AND user_id = ?'), null);
    assert.equal(violation('UPDATE items SET rating = ? WHERE id = ?'), null);
    assert.equal(violation('SELECT * FROM progress WHERE item_id = ? AND season = ?'), null);
    assert.equal(violation('INSERT INTO progress (item_id, season, episode) VALUES (?, ?, ?)'), null);
    assert.equal(violation('SELECT p.* FROM progress p JOIN items i ON i.id = p.item_id WHERE i.user_id = ?'), null);
    assert.equal(violation('SELECT value FROM settings WHERE key = ?'), null);
  });

  it('binds every library query to a member', () => {
    const problems = [];
    const usedExceptions = new Set();
    for (const file of sourceFiles(SERVER)) {
      if (SKIP.has(file)) continue;
      const src = fs.readFileSync(path.join(SERVER, file), 'utf8');
      for (const sql of literals(src)) {
        const table = violation(sql);
        if (!table) continue;
        const allowed = (ALLOWED[file] || []).find((frag) => sql.includes(frag));
        if (allowed) {
          usedExceptions.add(`${file}: ${allowed}`);
          continue;
        }
        problems.push(`${file} (${table}): ${sql.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
      }
    }
    assert.deepEqual(problems, [], `unscoped queries:\n${problems.join('\n')}`);

    // Every listed exception must still exist, so the list can't rot into a
    // blanket pass for queries nobody reviewed.
    const stale = Object.entries(ALLOWED)
      .flatMap(([file, frags]) => frags.map((f) => `${file}: ${f}`))
      .filter((k) => !usedExceptions.has(k));
    assert.deepEqual(stale, [], `exceptions that no longer match anything:\n${stale.join('\n')}`);
  });
});
