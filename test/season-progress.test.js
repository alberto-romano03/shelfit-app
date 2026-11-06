// The season page's count and time left come from the whole season, even though the page
// only fetches a slice of its episodes at a time.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, TEST_PASSWORD } from './helpers/harness.js';
import { writeShowMeta } from './helpers/fixtures.js';

const SHOW = 1396;

describe('a season page counts the whole season', () => {
  let h;
  let a;
  let id;
  const page = async (q = '?page=1&pageSize=2') => (await a.get(`/api/media/${id}/season/1${q}`)).json;

  before(async () => {
    h = await startApp();
    writeShowMeta(h.dataDir, SHOW, {
      title: 'A Show',
      year: 2010,
      seasons: [[
        { runtime: 30, air_date: '2010-01-01' },
        { runtime: 40, air_date: '2010-01-08' },
        { runtime: 50, air_date: '2010-01-15' },
        { air_date: '2010-01-22' },
      ]],
    });
    const masterId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    a = client(h.app, await login(h.app, TEST_PASSWORD, masterId));
    id = h.db
      .prepare("INSERT INTO items (user_id, tmdb_id, type, title_it, title_orig, status) VALUES (?, ?, 'show', 'A Show', 'A Show', 'watching')")
      .run(masterId, String(SHOW)).lastInsertRowid;
  });
  after(async () => {
    if (h) await h.close();
  });
  beforeEach(() => {
    h.db.prepare('DELETE FROM progress WHERE item_id = ?').run(id);
  });

  it('starts at nothing watched', async () => {
    const p = await page();
    assert.equal(p.watched_count, 0);
    assert.equal(p.total, 4);
    assert.equal(p.episodes.length, 2);
  });

  it('counts episodes outside the slice it returns', async () => {
    await a.post('/api/progress', { item_id: id, season: 1, episode: 3 });
    assert.equal((await page()).watched_count, 1);
  });

  it('adds up the time left, using the average for an episode with no runtime', async () => {
    assert.equal((await page()).minutes_left, 30 + 40 + 50 + 40);
    await a.post('/api/progress', { item_id: id, season: 1, episode: 1 });
    assert.equal((await page()).minutes_left, 40 + 50 + 40);
  });

  it('reaches nothing left once all are watched', async () => {
    await a.post('/api/progress/season', { item_id: id, season: 1 });
    const p = await page();
    assert.equal(p.watched_count, 4);
    assert.equal(p.minutes_left, 0);
  });

  it('also reports it without pagination', async () => {
    assert.equal((await page('')).watched_count, 0);
  });
});
