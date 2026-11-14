// Library history that must not drift, and What's Next that must not lie:
//   • a movie keeps its first-watch day whatever its status goes through, and can
//     hold a stopped minute while it is rewatched from the shelf;
//   • a backup restores every rewatch and every stopped minute, and a merge never
//     undoes a pause, a drop or the shelf, nor moves a film into this month;
//   • marking episodes moves a series off the list, offers a shelved one back to
//     Watching, never marks what has not aired, and What's Next proposes a
//     rewatch only while one is under way;
//   • a Kodi sync acts only on a new viewing, and never on a same-named title.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp, login, client, TEST_PASSWORD } from './helpers/harness.js';
import { writeMovieMeta, writeShowMeta } from './helpers/fixtures.js';

const PAST = (n) => ({ runtime: 40, air_date: `2020-01-${String(n).padStart(2, '0')}` });
const FUTURE = (n) => ({ runtime: 40, air_date: `2099-01-${String(n).padStart(2, '0')}` });
const DAY = /^\d{4}-\d{2}-\d{2}$/;
let ipSeq = 0;
const asXml = () => ({ 'content-type': 'application/xml', 'x-forwarded-for': `10.0.2.${++ipSeq}` });

describe('library history', () => {
  let h;
  let a;
  let userId;
  const add = async (tmdb_id, type, status) => (await a.post('/api/media', { tmdb_id, type, status })).json.id;
  const item = (id) => h.db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  const mark = (id, season, episode) => a.post('/api/progress', { item_id: id, season, episode });
  const watchNext = async (id) =>
    (await a.get('/api/upcoming')).json.watch_next.find((w) => w.item_id === id) || null;

  before(async () => {
    h = await startApp();
    userId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    a = client(h.app, await login(h.app, TEST_PASSWORD, userId));
    for (const [id, title] of [[603, 'The Matrix'], [550, 'Fight Club'], [680, 'Dune'], [13, 'Forrest Gump']]) {
      writeMovieMeta(h.dataDir, id, { title, year: 1999, runtime: 130 });
    }
    for (const id of [1401, 1402, 1403, 1404, 1406, 1407, 1408]) {
      writeShowMeta(h.dataDir, id, { title: `Show ${id}`, year: 2020, seasons: [[PAST(1), PAST(2), PAST(3)], [PAST(4), PAST(5), PAST(6)]] });
    }
    writeShowMeta(h.dataDir, 1405, { title: 'Airing', year: 2020, seasons: [[PAST(1), PAST(2), FUTURE(3), FUTURE(4)]] });
  });
  after(async () => {
    if (h) await h.close();
  });

  // --- Movies -------------------------------------------------------------------

  it('keeps a movie\'s first-watch day when it leaves the shelf and comes back', async () => {
    const id = await add(603, 'movie', 'plan_to_watch');
    let r = await a.patch(`/api/media/${id}`, { status: 'completed' });
    assert.match(r.json.watch_date, DAY); // shelving stamps the day
    await a.patch(`/api/media/${id}/watch-date`, { date: '2025-03-10' });
    r = await a.patch(`/api/media/${id}`, { status: 'watching' });
    assert.equal(r.json.watch_date, '2025-03-10');
    r = await a.patch(`/api/media/${id}`, { status: 'completed' });
    assert.equal(r.json.watch_date, '2025-03-10');
    assert.equal((await a.get(`/api/media/${id}`)).json.watch_date, '2025-03-10');
  });

  it('dates a watched movie an import brings in by the day it was watched', () => {
    const info = h.db
      .prepare(
        `INSERT INTO items (user_id, tmdb_id, type, title_it, title_orig, status, updated_at)
         VALUES (?, '13', 'movie', 'Forrest Gump', 'Forrest Gump', 'completed', '2019-05-04 21:00:00')`
      )
      .run(userId);
    assert.equal(item(info.lastInsertRowid).watch_date, '2019-05-04');
    h.db.prepare('DELETE FROM items WHERE id = ?').run(info.lastInsertRowid);
  });

  it('keeps a minute on a shelved movie being rewatched, until the rewatch is recorded', async () => {
    const id = h.db.prepare("SELECT id FROM items WHERE tmdb_id = '603'").get().id;
    assert.equal(item(id).status, 'completed');
    assert.equal((await a.patch(`/api/media/${id}`, { stopped_at: 40 })).status, 200);
    assert.equal((await a.get(`/api/media/${id}`)).json.stopped_at, 40);
    assert.equal(item(id).status, 'completed');
    await a.post(`/api/media/${id}/rewatch`, { date: '2026-11-01' });
    assert.equal((await a.get(`/api/media/${id}`)).json.stopped_at, null);
  });

  // --- Backup -------------------------------------------------------------------

  it('restores every rewatch of the same day and every stopped minute', async () => {
    const movie = await add(550, 'movie', 'completed');
    for (let k = 0; k < 3; k++) await a.post(`/api/media/${movie}/rewatch`, { date: '2026-01-01' });
    await a.patch(`/api/media/${movie}`, { stopped_at: 25 });
    const show = await add(1401, 'show', 'watching');
    await mark(show, 1, 1);
    await a.put(`/api/progress/${show}/1/1/stop`, { stopped_at: 10 }); // a rewatch stopped partway
    await a.put(`/api/progress/${show}/1/2/stop`, { stopped_at: 20 }); // a first watch stopped partway
    const xml = (await a.get('/api/library/export')).body;
    assert.match(xml, /<stopped_at>25<\/stopped_at>/);
    assert.match(xml, /watched="false" stopped_at="20"/);

    await a.del(`/api/media/${movie}`);
    await a.del(`/api/media/${show}`);
    assert.equal((await a.post('/api/library/import', xml, asXml())).status, 200);
    const m = h.db.prepare("SELECT * FROM items WHERE tmdb_id = '550'").get();
    assert.equal(m.rewatch_count, 3);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM movie_rewatches WHERE item_id = ?').get(m.id).n, 3);
    assert.equal(m.stopped_at, 25);
    // (Deleting the series also dropped its cached metadata, so read the table.)
    const s = h.db.prepare("SELECT id FROM items WHERE tmdb_id = '1401'").get().id;
    const stops = h.db.prepare('SELECT episode, stopped_at FROM episode_stops WHERE item_id = ? ORDER BY episode').all(s);
    assert.deepEqual(stops.map((r) => [r.episode, r.stopped_at]), [[1, 10], [2, 20]]);
    assert.equal(h.db.prepare('SELECT watch_count FROM progress WHERE item_id = ? AND episode = 1').get(s).watch_count, 1);

    // A second restore of the same file adds nothing.
    await a.post('/api/library/import', xml, asXml());
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM movie_rewatches WHERE item_id = ?').get(m.id).n, 3);
    assert.equal(item(m.id).rewatch_count, 3);
  });

  it('merges a backup without undoing a pause or moving a film into this month', async () => {
    const paused = await add(1402, 'show', 'watching');
    const planned = await add(680, 'movie', 'completed');
    const shelved = h.db.prepare("SELECT id FROM items WHERE tmdb_id = '603'").get().id;
    h.db.prepare("UPDATE items SET notes = 'from the file' WHERE id = ?").run(shelved);
    const xml = (await a.get('/api/library/export')).body; // paused = watching, planned = shelved
    await a.patch(`/api/media/${paused}`, { status: 'paused' });
    await a.patch(`/api/media/${planned}`, { status: 'plan_to_watch' });
    h.db.prepare("UPDATE items SET updated_at = '2025-03-10 20:00:00', notes = 'mine' WHERE id = ?").run(shelved);

    await a.post('/api/library/import', xml, asXml());
    assert.equal(item(paused).status, 'paused'); // a pause is a choice: kept
    assert.equal(item(planned).status, 'completed'); // off the list: the file decides
    assert.match(item(shelved).notes, /from the file/); // the notes merged...
    assert.equal(item(shelved).updated_at, '2025-03-10 20:00:00'); // ...and nothing moved
  });

  // --- Series status ------------------------------------------------------------

  it('starts a series off the list with its first episode, and Undo puts it back', async () => {
    const id = await add(1403, 'show', 'plan_to_watch');
    const r = await mark(id, 1, 1);
    assert.equal(r.json.status_changed, 'watching');
    assert.equal(item(id).status, 'watching');

    const other = await add(1404, 'show', 'plan_to_watch');
    const season = (await a.post('/api/progress/season', { item_id: other, season: 1 })).json;
    assert.equal(season.status_changed, 'watching');
    await a.post('/api/progress/undo-marks', {
      item_id: other,
      episodes: season.marked_episodes,
      current_season: season.previous_current_season,
      restore_status: 'plan_to_watch',
    });
    assert.equal(item(other).status, 'plan_to_watch');
  });

  it('offers a shelved series back to Watching when a new episode is watched', async () => {
    const id = h.db.prepare("SELECT id FROM items WHERE tmdb_id = '1403'").get().id;
    await a.patch(`/api/media/${id}`, { status: 'completed' });
    const r = await mark(id, 1, 2);
    assert.equal(r.json.offer_watching, true);
    assert.equal(r.json.status_changed, null);
    assert.equal(item(id).status, 'completed'); // asked, not changed
    // A rewatch is not a new episode: nothing to offer.
    const again = await a.post('/api/progress/set-count', { item_id: id, season: 1, episode: 2, watch_count: 2 });
    assert.equal(again.json.status_changed, null);
  });

  it('marks only the episodes already out on "Watched all"', async () => {
    const id = await add(1405, 'show', 'watching');
    assert.equal((await a.get(`/api/media/${id}/season/1`)).json.aired_unwatched, 2);
    const r = (await a.post('/api/progress/season', { item_id: id, season: 1 })).json;
    assert.deepEqual(r.marked_episodes.map((e) => e.episode), [1, 2]);
    const s = (await a.get(`/api/media/${id}/season/1`)).json;
    assert.deepEqual(s.episodes.map((e) => e.watched), [true, true, false, false]);
    assert.equal(s.aired_unwatched, 0);
  });

  // --- What's Next ---------------------------------------------------------------

  it('keeps a caught-up series out of What\'s Next when a gap or a count is corrected', async () => {
    const id = await add(1406, 'show', 'watching');
    for (const [s, e] of [[1, 1], [1, 3], [2, 1], [2, 2], [2, 3]]) await mark(id, s, e);
    assert.equal(item(id).current_season, 2);
    await mark(id, 1, 2); // the gap in season 1
    assert.equal(item(id).current_season, 1);
    assert.equal(await watchNext(id), null);

    // Confirming or lowering a count is not a new viewing: the season stays put.
    h.db.prepare('UPDATE progress SET watch_count = 2 WHERE item_id = ? AND season = 2 AND episode = 2').run(id);
    await a.post('/api/progress/set-count', { item_id: id, season: 2, episode: 3, watch_count: 1 });
    await a.post('/api/progress/set-count', { item_id: id, season: 2, episode: 2, watch_count: 1 });
    assert.equal(item(id).current_season, 1);
    assert.equal(await watchNext(id), null);
  });

  it('follows a rewatch from the episode watched last, not an old favourite', async () => {
    const id = await add(1407, 'show', 'watching');
    for (const e of [1, 2, 3]) await mark(id, 1, e);
    for (const e of [1, 2, 3]) await mark(id, 2, e);
    h.db.prepare("UPDATE progress SET watched_at = '2025-01-01 20:00:00' WHERE item_id = ?").run(id);
    // Season 1 episode 2 was seen four times, long ago.
    h.db
      .prepare("UPDATE progress SET watch_count = 4, watched_at = '2021-01-01 20:00:00' WHERE item_id = ? AND season = 1 AND episode = 2")
      .run(id);
    // Caught up: nothing to propose.
    assert.equal(await watchNext(id), null);
    // The rewatch starts: episode 1 again. Next is episode 2, however often it was seen.
    await a.post('/api/progress/set-count', { item_id: id, season: 1, episode: 1, watch_count: 2 });
    let next = await watchNext(id);
    assert.deepEqual([next.season, next.episode], [1, 2]);
    // On to episode 3: next is season 2, not the episode after the old favourite.
    await a.post('/api/progress/set-count', { item_id: id, season: 1, episode: 3, watch_count: 2 });
    next = await watchNext(id);
    assert.deepEqual([next.season, next.episode], [2, 1]);
  });

  // --- Kodi -------------------------------------------------------------------------

  it('syncs from Kodi only what Kodi saw anew, and never a same-named film', async () => {
    const kodi = { movies: [], tvshows: [] };
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { method } = JSON.parse(body || '{}');
        const result =
          method === 'VideoLibrary.GetMovies' ? { movies: kodi.movies }
            : method === 'VideoLibrary.GetTVShows' ? { tvshows: kodi.tvshows }
              : 'pong';
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { setEnabled } = await import('../server/kodi.js');
      const { runKodiSync } = await import('../server/kodiSync.js');
      setEnabled(true);
      const created = await a.post('/api/kodi/instances', { name: 'Test', host: '127.0.0.1', port: server.address().port });
      assert.equal(created.status, 200);

      // 603 is being rewatched (set back to Watching by hand), 680 is still on the list.
      const rewatching = h.db.prepare("SELECT id FROM items WHERE tmdb_id = '603'").get().id;
      await a.patch(`/api/media/${rewatching}`, { status: 'watching' });
      const listed = h.db.prepare("SELECT id FROM items WHERE tmdb_id = '680'").get().id;
      await a.patch(`/api/media/${listed}`, { status: 'plan_to_watch' });
      const series = await add(1408, 'show', 'plan_to_watch');
      const namesake = await add(13, 'movie', 'plan_to_watch');
      const movie = (tmdb, title, playcount) => ({ title, originaltitle: title, year: 1999, playcount, uniqueid: { tmdb: String(tmdb) } });
      // Kodi's "Forrest Gump" is another film (another TMDB id) than the one on the list.
      kodi.movies = [movie(603, 'The Matrix', 1), movie(680, 'Dune', 1), movie(999999, 'Forrest Gump', 1)];
      // Kodi holds only season 1 (3 of the 6 episodes), all watched.
      kodi.tvshows = [{ title: 'Show 1408', originaltitle: 'Show 1408', year: 2020, watchedepisodes: 3, episode: 3, uniqueid: { tmdb: '1408' } }];

      await runKodiSync();
      assert.equal(item(rewatching).status, 'watching'); // first sight: a rewatch is left be
      assert.equal(item(listed).status, 'completed'); // watched in Kodi, off the list
      assert.equal(item(series).status, 'watching'); // half the series is not the series
      assert.equal(item(namesake).status, 'plan_to_watch'); // untouched: Kodi's is another film

      await runKodiSync(); // nothing new in Kodi
      assert.equal(item(rewatching).status, 'watching');
      kodi.movies[0].playcount = 2; // the rewatch finished in Kodi
      await runKodiSync();
      assert.equal(item(rewatching).status, 'completed');
    } finally {
      server.close();
    }
  });
});
