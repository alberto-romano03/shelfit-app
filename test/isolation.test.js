// Two members, one instance: each library, list, Wall, stat and feed is private
// to its owner, ids of another member's rows behave like ids that don't exist,
// and the shared parts (image cache, custom artwork) stay shared.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, login, client, addUser, waitFor, TEST_PASSWORD } from './helpers/harness.js';
import { writeMovieMeta, writeShowMeta } from './helpers/fixtures.js';

const MATRIX = 603;
const FIGHT_CLUB = 550;
const BREAKING_BAD = 1396;
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64')}`;

describe('two members on one instance', () => {
  let h;
  let a; // master
  let b; // member
  const A = {};
  const B = {};

  before(async () => {
    h = await startApp();
    writeMovieMeta(h.dataDir, MATRIX, { title: 'The Matrix', year: 1999, runtime: 136, genres: ['Action'] });
    writeMovieMeta(h.dataDir, FIGHT_CLUB, { title: 'Fight Club', year: 1999, runtime: 139, genres: ['Drama'] });
    writeShowMeta(h.dataDir, BREAKING_BAD, {
      title: 'Breaking Bad',
      year: 2008,
      seasons: [[{ runtime: 50, air_date: '2008-01-20' }, { runtime: 50, air_date: '2008-01-27' }]],
    });
    // A show sharing The Matrix's TMDB id: TMDB movie and TV ids are separate.
    writeShowMeta(h.dataDir, MATRIX, {
      title: 'Same Id Show',
      year: 2010,
      seasons: [[{ runtime: 30, air_date: '2010-01-01' }]],
    });
    const masterId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    const memberId = await addUser(h.db, { name: 'Giulia', password: 'member-pass-1' });
    a = client(h.app, await login(h.app, TEST_PASSWORD, masterId));
    b = client(h.app, await login(h.app, 'member-pass-1', memberId));
  });
  after(async () => {
    if (h) await h.close();
  });

  it('gives each member their own copy of the same title', async () => {
    A.matrix = (await a.post('/api/media', { tmdb_id: MATRIX, type: 'movie', status: 'completed' })).json.id;
    B.matrix = (await b.post('/api/media', { tmdb_id: MATRIX, type: 'movie', status: 'plan_to_watch' })).json.id;
    assert.ok(A.matrix && B.matrix && A.matrix !== B.matrix);
    await a.patch(`/api/media/${A.matrix}`, { rating: 5 });
    await b.patch(`/api/media/${B.matrix}`, { rating: 2 });
    assert.equal((await a.get(`/api/media/${A.matrix}`)).json.rating, 5);
    assert.equal((await b.get(`/api/media/${B.matrix}`)).json.rating, 2);
    assert.equal((await b.get(`/api/media/${B.matrix}`)).json.status, 'plan_to_watch');
  });

  it('lets a movie and a show with the same TMDB id coexist', async () => {
    const res = await a.post('/api/media', { tmdb_id: MATRIX, type: 'show', status: 'plan_to_watch' });
    assert.equal(res.status, 201);
    assert.equal((await a.post('/api/media', { tmdb_id: MATRIX, type: 'movie' })).status, 409);
    await a.del(`/api/media/${res.json.id}`);
  });

  it('lists only the caller\'s library', async () => {
    A.fight = (await a.post('/api/media', { tmdb_id: FIGHT_CLUB, type: 'movie', status: 'completed' })).json.id;
    A.show = (await a.post('/api/media', { tmdb_id: BREAKING_BAD, type: 'show', status: 'watching' })).json.id;
    const mine = (await a.get('/api/media')).json.items.map((i) => i.id).sort();
    const theirs = (await b.get('/api/media')).json.items.map((i) => i.id);
    assert.deepEqual(mine, [A.matrix, A.fight, A.show].sort());
    assert.deepEqual(theirs, [B.matrix]);
    assert.deepEqual((await b.get('/api/media?type=movie&page=1&pageSize=10')).json.genres, ['Action']);
    assert.deepEqual(
      (await b.get('/api/plan-to-watch')).json.titles.map((t) => t.id),
      [B.matrix]
    );
    assert.deepEqual((await a.get('/api/unrated')).json.titles.map((t) => t.id).sort(), [A.fight, A.show].sort());
  });

  it("answers 404 for every route given another member's item id", async () => {
    await a.post('/api/progress', { item_id: A.show, season: 1, episode: 1 });
    const probes = [
      ['get', `/api/media/${A.matrix}`],
      ['patch', `/api/media/${A.matrix}`, { rating: 1 }],
      ['get', `/api/media/${A.show}/season/1`],
      ['get', `/api/media/${A.show}/progress`],
      ['get', `/api/media/${A.matrix}/rewatches`],
      ['post', `/api/media/${A.matrix}/rewatch`, { date: '2026-01-01' }],
      ['patch', `/api/media/${A.matrix}/watch-date`, { date: '2026-01-01' }],
      ['patch', `/api/movies/${A.matrix}/cinema`, { cinema_name: 'Odeon' }],
      ['post', '/api/progress', { item_id: A.show, season: 1, episode: 2 }],
      ['post', '/api/progress/season', { item_id: A.show, season: 1 }],
      ['post', '/api/progress/catchup', { item_id: A.show, season: 1, episode: 2 }],
      ['post', '/api/progress/rewatch', { item_id: A.show, season: 1, episode: 1 }],
      ['post', '/api/progress/set-count', { item_id: A.show, season: 1, episode: 1, watch_count: 3 }],
      ['patch', `/api/progress/${A.show}/1/1`, { notes: 'mine now' }],
      ['del', `/api/progress/${A.show}/1/1`],
      ['del', `/api/media/${A.matrix}`],
    ];
    for (const [method, url, body] of probes) {
      const res = await b[method](url, body);
      assert.equal(res.status, 404, `${method.toUpperCase()} ${url} → ${res.status}`);
    }
    // DELETE /api/progress/season takes a JSON body.
    const delSeason = await h.app.inject({
      method: 'DELETE',
      url: '/api/progress/season',
      headers: { cookie: b.cookie },
      payload: { item_id: A.show, season: 1 },
    });
    assert.equal(delSeason.statusCode, 404);

    // Nothing of A's moved.
    const matrix = (await a.get(`/api/media/${A.matrix}`)).json;
    assert.equal(matrix.rating, 5);
    assert.equal(matrix.rewatch_count, 0);
    assert.equal(matrix.cinema_name, null);
    const progress = (await a.get(`/api/media/${A.show}/progress`)).json.progress;
    assert.deepEqual(progress.map((p) => [p.season, p.episode, p.watch_count, p.notes]), [[1, 1, 1, null]]);
  });

  it('keeps lists private', async () => {
    const list = (await a.post('/api/lists', { name: 'Mine', type: 'movie' })).json.id;
    await a.post(`/api/lists/${list}/items`, { tmdbId: MATRIX });
    assert.equal((await b.get('/api/lists')).json.lists.length, 0);
    assert.equal((await b.get(`/api/lists/${list}/items`)).status, 404);
    assert.equal((await b.patch(`/api/lists/${list}`, { name: 'Taken' })).status, 404);
    assert.equal((await b.post(`/api/lists/${list}/items`, { tmdbId: FIGHT_CLUB })).status, 404);
    assert.equal((await b.del(`/api/lists/${list}/items/${MATRIX}`)).status, 404);
    assert.equal((await b.del(`/api/lists/${list}`)).status, 404);
    const items = (await a.get(`/api/lists/${list}/items`)).json.items;
    assert.deepEqual(items.map((i) => [i.tmdb_id, i.item_id]), [[String(MATRIX), A.matrix]]);
    A.list = list;
  });

  it('gives each member their own Wall', async () => {
    await a.patch(`/api/favorites/movie/${MATRIX}`);
    assert.equal((await b.get('/api/favorites')).json.movie, null);
    await b.patch(`/api/favorites/movie/${MATRIX}`);
    assert.equal((await a.get('/api/favorites')).json.movie.id, A.matrix);
    assert.equal((await b.get('/api/favorites')).json.movie.id, B.matrix);
    assert.equal((await b.patch(`/api/favorites/movie/${FIGHT_CLUB}`)).status, 404, 'not in their library');
  });

  it('computes stats, Up Next and the receipt per member', async () => {
    const statsA = await waitFor(async () => {
      const s = (await a.get('/api/stats')).json;
      return s && s.total_episodes_watched === 1 && s.total_movies_completed === 2 ? s : null;
    });
    assert.equal(statsA.total_minutes_movies, 136 + 139);
    const statsB = (await b.get('/api/stats')).json;
    assert.equal(statsB.total_movies_completed, 0);
    assert.equal(statsB.total_episodes_watched, 0);

    const nextA = (await a.get('/api/upcoming')).json.watch_next;
    assert.deepEqual(nextA.map((w) => [w.item_id, w.season, w.episode]), [[A.show, 1, 2]]);
    assert.deepEqual((await b.get('/api/upcoming')).json.watch_next, []);

    const receiptA = (await a.get('/api/receipt')).json;
    const receiptB = (await b.get('/api/receipt')).json;
    assert.equal(receiptA.movies.length, 2);
    assert.equal(receiptB.movies.length, 0);
    assert.equal(receiptB.shows.length, 0);
  });

  it('searches only the caller\'s library', async () => {
    const res = await b.get('/api/search?q=Fight&scope=library');
    assert.deepEqual(res.json.results, []);
    const mine = await a.get('/api/search?q=Fight&scope=library');
    assert.equal(mine.json.results.length, 1);
  });

  it('exports and imports backups per member', async () => {
    const xmlB = (await b.get('/api/library/export')).body;
    assert.match(xmlB, /<entry_count>1<\/entry_count>/);
    assert.doesNotMatch(xmlB, new RegExp(`tmdb_id="${FIGHT_CLUB}"`));

    // A's backup imported by B lands in B's library and never touches A's rows.
    const xmlA = (await a.get('/api/library/export')).body;
    const imp = await b.post('/api/library/import', xmlA, { 'content-type': 'application/xml' });
    assert.equal(imp.status, 200);
    assert.equal(imp.json.added, 2); // Fight Club + Breaking Bad; The Matrix merges into B's own
    const bIds = new Set((await b.get('/api/media')).json.items.map((i) => i.id));
    assert.equal(bIds.size, 3);
    for (const id of [A.matrix, A.fight, A.show]) assert.ok(!bIds.has(id));
    assert.equal((await a.get('/api/media')).json.items.length, 3);
    assert.equal((await b.get('/api/lists')).json.lists.length, 1, "B got a copy of A's list, as B's");
    assert.equal((await a.get('/api/lists')).json.lists.length, 1);
  });

  it('shares custom artwork across members', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/media/movie/${MATRIX}/images/poster`,
      headers: { cookie: b.cookie },
      payload: { image: PNG_DATA_URL },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().custom, true);
    assert.match((await a.get(`/api/media/${A.matrix}`)).json.poster_url, /\?v=\d+$/);
  });

  it('keeps the shared cache until the last member removes the title', async () => {
    const dir = path.join(h.dataDir, 'cache', 'movies', String(MATRIX));
    assert.equal((await b.del(`/api/media/${B.matrix}`)).status, 200);
    assert.ok(fs.existsSync(path.join(dir, 'meta.json')), 'A still has it');
    const listItems = (await a.get(`/api/lists/${A.list}/items`)).json.items;
    assert.equal(listItems.length, 1, "B's delete left A's list alone");
    assert.equal((await a.get(`/api/media/${A.matrix}`)).status, 200);

    assert.equal((await a.del(`/api/media/${A.matrix}`)).status, 200);
    assert.ok(!fs.existsSync(dir), 'nobody has it any more');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS c FROM title_art WHERE tmdb_id = '603'").get().c, 0);
  });

  it('keeps the push subscription with the member who enabled it', async () => {
    const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'a' } };
    assert.equal((await a.post('/api/push/subscribe', { subscription: sub })).status, 200);
    assert.equal((await a.get('/api/push/config')).json.subscribed, true);
    assert.equal((await b.get('/api/push/config')).json.subscribed, false);
    await b.post('/api/push/unsubscribe');
    assert.equal((await a.get('/api/push/config')).json.subscribed, true, "B can't remove A's");
  });

  it('removes a member and everything they own', async () => {
    const memberId = h.db.prepare("SELECT id FROM users WHERE display_name = 'Giulia'").get().id;
    h.db.prepare('DELETE FROM users WHERE id = ?').run(memberId);
    for (const table of ['items', 'lists', 'favorites', 'sessions']) {
      assert.equal(h.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id = ?`).get(memberId).c, 0, table);
    }
    assert.ok((await a.get('/api/media')).json.items.length > 0);
  });
});
