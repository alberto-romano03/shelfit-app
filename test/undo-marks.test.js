// Undo after marking many episodes: only what that action marked goes back. Episodes
// already watched, with their counts, notes and dates, are left exactly as they were.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, addUser, TEST_PASSWORD } from './helpers/harness.js';
import { writeShowMeta } from './helpers/fixtures.js';

const SHOW = 1396;
const EP = { runtime: 30, air_date: '2010-01-01' };

describe('undoing a bulk mark', () => {
  let h;
  let a;
  let b;
  let id;

  const rows = () => h.db
    .prepare('SELECT season, episode, watch_count, notes FROM progress WHERE item_id = ? ORDER BY season, episode')
    .all(id);
  const currentSeason = () => h.db.prepare('SELECT current_season FROM items WHERE id = ?').get(id).current_season;
  const undo = (client_, body) => client_.post('/api/progress/undo-marks', body);

  before(async () => {
    h = await startApp();
    writeShowMeta(h.dataDir, SHOW, { title: 'A Show', year: 2010, seasons: [[EP, EP, EP, EP], [EP, EP]] });
    const masterId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    const memberId = await addUser(h.db, { name: 'Giulia', password: 'member-pass-1' });
    a = client(h.app, await login(h.app, TEST_PASSWORD, masterId));
    b = client(h.app, await login(h.app, 'member-pass-1', memberId));
    id = h.db
      .prepare("INSERT INTO items (user_id, tmdb_id, type, title_it, title_orig, status) VALUES (?, ?, 'show', 'A Show', 'A Show', 'watching')")
      .run(masterId, String(SHOW)).lastInsertRowid;
  });
  after(async () => {
    if (h) await h.close();
  });
  beforeEach(() => {
    h.db.prepare('DELETE FROM progress WHERE item_id = ?').run(id);
    h.db.prepare('UPDATE items SET current_season = NULL WHERE id = ?').run(id);
  });

  it('Watched all reports only the episodes it marked', async () => {
    await a.post('/api/progress', { item_id: id, season: 1, episode: 2 });
    const res = await a.post('/api/progress/season', { item_id: id, season: 1 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.marked_episodes.map((e) => e.episode), [1, 3, 4]);
    assert.equal(res.json.previous_current_season, 1);
  });

  it('undoing it keeps what was already watched, with its count and note', async () => {
    await a.post('/api/progress', { item_id: id, season: 1, episode: 2, notes: 'keep me' });
    await a.post('/api/progress/set-count', { item_id: id, season: 1, episode: 2, watch_count: 3 });
    const before = rows();
    const res = (await a.post('/api/progress/season', { item_id: id, season: 1 })).json;
    assert.equal(rows().length, 4);
    const back = await undo(a, { item_id: id, episodes: res.marked_episodes, current_season: res.previous_current_season });
    assert.equal(back.status, 200);
    assert.deepEqual(rows(), before);
  });

  it('puts the current season back, including none at all', async () => {
    await a.post('/api/progress', { item_id: id, season: 1, episode: 1 });
    let res = (await a.post('/api/progress/season', { item_id: id, season: 2 })).json;
    assert.equal(currentSeason(), 2);
    await undo(a, { item_id: id, episodes: res.marked_episodes, current_season: res.previous_current_season });
    assert.equal(currentSeason(), 1);

    h.db.prepare('DELETE FROM progress WHERE item_id = ?').run(id);
    h.db.prepare('UPDATE items SET current_season = NULL WHERE id = ?').run(id);
    res = (await a.post('/api/progress/season', { item_id: id, season: 1 })).json;
    assert.equal(res.previous_current_season, null);
    await undo(a, { item_id: id, episodes: res.marked_episodes, current_season: null });
    assert.equal(currentSeason(), null);
    assert.deepEqual(rows(), []);
  });

  it('undoes a catch up without touching the episode that prompted it', async () => {
    await a.post('/api/progress', { item_id: id, season: 1, episode: 4 });
    const res = (await a.post('/api/progress/catchup', { item_id: id, season: 1, episode: 4 })).json;
    assert.deepEqual(res.marked_episodes.map((e) => e.episode), [1, 2, 3]);
    await undo(a, { item_id: id, episodes: res.marked_episodes, current_season: res.previous_current_season });
    assert.deepEqual(rows().map((r) => r.episode), [4]);
    assert.equal(currentSeason(), 1);
  });

  it("refuses another member's title and bad input", async () => {
    await a.post('/api/progress/season', { item_id: id, season: 1 });
    const good = [{ season: 1, episode: 1 }];
    assert.equal((await undo(b, { item_id: id, episodes: good, current_season: null })).status, 404);
    assert.equal(rows().length, 4);
    for (const episodes of ['1', [{ season: 'x', episode: 1 }], [{ season: 1 }], [{ season: 0, episode: 1 }]]) {
      assert.equal((await undo(a, { item_id: id, episodes, current_season: null })).status, 400);
    }
    assert.equal((await undo(a, { item_id: id, episodes: good, current_season: 'x' })).status, 400);
    assert.equal(rows().length, 4);
  });
});
