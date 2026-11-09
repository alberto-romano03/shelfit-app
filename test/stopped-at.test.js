// "Stopped at": the minute a movie or an episode was left at. Finishing it (a
// movie completed, an episode marked watched by any route) clears it.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, addUser, TEST_PASSWORD } from './helpers/harness.js';
import { writeShowMeta } from './helpers/fixtures.js';

const SHOW = 1396;

describe('stopped at', () => {
  let h;
  let a;
  let movie;
  let show;
  const detail = async (id) => (await a.get(`/api/media/${id}`)).json;
  const season = async () => (await a.get(`/api/media/${show}/season/1`)).json;
  const stop = (ep, stopped_at) => a.put(`/api/progress/${show}/1/${ep}/stop`, { stopped_at });

  before(async () => {
    h = await startApp();
    writeShowMeta(h.dataDir, SHOW, {
      title: 'A Show',
      year: 2010,
      seasons: [[
        { runtime: 40, air_date: '2010-01-01' },
        { runtime: 40, air_date: '2010-01-08' },
        { runtime: 40, air_date: '2010-01-15' },
      ]],
    });
    const masterId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    a = client(h.app, await login(h.app, TEST_PASSWORD, masterId));
    const add = h.db.prepare(
      "INSERT INTO items (user_id, tmdb_id, type, title_it, title_orig, status) VALUES (?, ?, ?, 'T', 'T', 'watching')"
    );
    movie = add.run(masterId, '550', 'movie').lastInsertRowid;
    show = add.run(masterId, String(SHOW), 'show').lastInsertRowid;
  });
  after(async () => {
    if (h) await h.close();
  });
  beforeEach(() => {
    h.db.prepare('DELETE FROM progress WHERE item_id = ?').run(show);
    h.db.prepare('DELETE FROM episode_stops').run();
    h.db.prepare("UPDATE items SET stopped_at = NULL, status = 'watching' WHERE id = ?").run(movie);
  });

  it('keeps and clears a movie minute', async () => {
    assert.equal((await a.patch(`/api/media/${movie}`, { stopped_at: 37 })).status, 200);
    assert.equal((await detail(movie)).stopped_at, 37);
    await a.patch(`/api/media/${movie}`, { stopped_at: 0 });
    assert.equal((await detail(movie)).stopped_at, null);
  });

  it('refuses a minute that is not a whole minute, and one on a series', async () => {
    assert.equal((await a.patch(`/api/media/${movie}`, { stopped_at: 12.5 })).status, 400);
    assert.equal((await a.patch(`/api/media/${movie}`, { stopped_at: -3 })).status, 400);
    assert.equal((await a.patch(`/api/media/${show}`, { stopped_at: 10 })).status, 400);
  });

  it('clears a movie minute when it is completed, keeps it when paused', async () => {
    await a.patch(`/api/media/${movie}`, { stopped_at: 37 });
    await a.patch(`/api/media/${movie}`, { status: 'paused' });
    assert.equal((await detail(movie)).stopped_at, 37);
    await a.patch(`/api/media/${movie}`, { status: 'completed' });
    assert.equal((await detail(movie)).stopped_at, null);
  });

  it('keeps an episode minute and counts only what is left of it', async () => {
    assert.equal((await stop(2, 28)).status, 200);
    const s = await season();
    assert.equal(s.episodes[1].stopped_at, 28);
    assert.equal(s.episodes[0].stopped_at, null);
    assert.equal(s.minutes_left, 40 + (40 - 28) + 40);
    await stop(2, null);
    assert.equal((await season()).episodes[1].stopped_at, null);
  });

  it('clears an episode minute when it is marked watched, by any route', async () => {
    await stop(1, 10);
    await stop(2, 20);
    await stop(3, 30);
    await a.post('/api/progress', { item_id: show, season: 1, episode: 1 });
    await a.post('/api/progress/set-count', { item_id: show, season: 1, episode: 2, watch_count: 2 });
    let s = await season();
    assert.deepEqual(s.episodes.map((e) => e.stopped_at), [null, null, 30]);
    await a.post('/api/progress/season', { item_id: show, season: 1 });
    s = await season();
    assert.deepEqual(s.episodes.map((e) => e.stopped_at), [null, null, null]);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM episode_stops').get().n, 0);
  });

  it('refuses a minute on a watched episode', async () => {
    await a.post('/api/progress', { item_id: show, season: 1, episode: 1 });
    assert.equal((await stop(1, 15)).status, 409);
  });

  it('keeps one member out of another member\'s series', async () => {
    const memberId = await addUser(h.db, { name: 'Giulia', password: 'member-pass-1' });
    const b = client(h.app, await login(h.app, 'member-pass-1', memberId));
    assert.equal((await b.put(`/api/progress/${show}/1/1/stop`, { stopped_at: 5 })).status, 404);
    assert.equal((await b.patch(`/api/media/${movie}`, { stopped_at: 5 })).status, 404);
  });
});
