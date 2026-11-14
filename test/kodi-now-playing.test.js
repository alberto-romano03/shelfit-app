// What Kodi's Now Playing is recognised as: the library title it matches (by id,
// or by name and year when Kodi gives no id), whether an episode can be marked
// (TMDB lists it and it is out), and whether it was already counted today.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp, login, client, TEST_PASSWORD } from './helpers/harness.js';
import { writeMovieMeta, writeShowMeta } from './helpers/fixtures.js';

const PAST = (n) => ({ runtime: 40, air_date: `2020-01-0${n}` });
const FUTURE = { runtime: 40, air_date: '2099-01-01' };
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('Kodi now playing', () => {
  let h;
  let a;
  let server;
  let playing = null; // what the fake Kodi reports: { item, show? }
  const now = async () => (await a.get('/api/kodi/now-playing')).json;
  const movie = (title, year, uniqueid = {}) => ({ item: { type: 'movie', title, label: title, year, uniqueid } });
  const episode = (showtitle, season, episode, extra = {}) => ({
    item: { type: 'episode', title: 'An episode', showtitle, season, episode, ...extra },
    show: extra.show,
  });

  before(async () => {
    h = await startApp();
    const userId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    a = client(h.app, await login(h.app, TEST_PASSWORD, userId));
    writeMovieMeta(h.dataDir, 603, { title: 'The Matrix', year: 1999, runtime: 136 });
    writeMovieMeta(h.dataDir, 841, { title: 'Dune', year: 1984, runtime: 137 });
    writeShowMeta(h.dataDir, 1399, { title: 'Test Show', year: 2020, seasons: [[PAST(1), PAST(2), FUTURE]] });

    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { method } = JSON.parse(body || '{}');
        const results = {
          'Player.GetActivePlayers': playing ? [{ playerid: 1, type: 'video' }] : [],
          'Player.GetItem': { item: playing && playing.item },
          'Player.GetProperties': { percentage: 50, time: { minutes: 30 }, totaltime: { hours: 1 }, speed: 1 },
          'XBMC.GetInfoLabels': {},
          'VideoLibrary.GetTVShowDetails': { tvshowdetails: playing && playing.show },
        };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: results[method] ?? 'pong' }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { setEnabled } = await import('../server/kodi.js');
    setEnabled(true);
    assert.equal((await a.post('/api/kodi/instances', { name: 'Living room', host: '127.0.0.1', port: server.address().port })).status, 200);
  });
  after(async () => {
    if (server) server.close();
    if (h) await h.close();
  });

  it('matches a film by its TMDB id and tells a rewatch counted today', async () => {
    const id = (await a.post('/api/media', { tmdb_id: 603, type: 'movie', status: 'completed' })).json.id;
    playing = movie('The Matrix', 1999, { tmdb: '603' });
    let np = await now();
    assert.equal(np.match.item_id, id);
    assert.equal(np.match.confidence, 'id');
    assert.equal(np.match.status, 'completed');
    assert.equal(np.match.plays, 1);
    assert.equal(np.match.done_today, true); // shelved just now: today's first watch
    h.db.prepare("UPDATE items SET watch_date = '2020-05-05' WHERE id = ?").run(id);
    assert.equal((await now()).match.done_today, false);
    const rw = (await a.post(`/api/media/${id}/rewatch`, { date: today() })).json;
    np = await now();
    assert.equal(np.match.done_today, true);
    assert.equal(np.match.rewatch_id, rw.rewatch_id);
    assert.equal(np.match.plays, 2);
  });

  it('matches by name only without an id, and only when the year agrees', async () => {
    const id = (await a.post('/api/media', { tmdb_id: 841, type: 'movie', status: 'plan_to_watch' })).json.id;
    h.db.prepare("UPDATE items SET year = '1984' WHERE id = ?").run(id);
    playing = movie('Dune', 1984);
    let np = await now();
    assert.equal(np.match.item_id, id);
    assert.equal(np.match.confidence, 'title');
    playing = movie('Dune', 2021); // another film of the same name
    np = await now();
    assert.equal(np.match, null);
    // With an id that is not in the library, the name is not tried at all.
    playing = movie('Dune', 1984, { tmdb: '438631' });
    np = await now();
    assert.equal(np.match, null);
    assert.equal(np.tmdb_id, '438631'); // the toast can offer to add it
  });

  it('marks only an episode TMDB lists and that is out', async () => {
    const id = (await a.post('/api/media', { tmdb_id: 1399, type: 'show', status: 'watching' })).json.id;
    const show = { uniqueid: { tmdb: '1399' }, title: 'Test Show' };
    playing = episode('Test Show', 1, 2, { tvshowid: 7, show });
    let np = await now();
    assert.equal(np.match.item_id, id);
    assert.equal(np.match.seen, false);
    assert.equal(np.match.uncertain, undefined);
    playing = episode('Test Show', 1, 245, { tvshowid: 7, show }); // absolute numbering
    assert.equal((await now()).match.uncertain, 'not_in_tmdb');
    playing = episode('Test Show', 1, 3, { tvshowid: 7, show }); // dated in the future
    assert.equal((await now()).match.uncertain, 'not_aired');

    await a.post('/api/progress', { item_id: id, season: 1, episode: 2 });
    playing = episode('Test Show', 1, 2, { tvshowid: 7, show });
    np = await now();
    assert.equal(np.match.seen, true);
    assert.equal(np.match.plays, 1);
    assert.equal(np.match.done_today, true);
  });

  it('never takes an episode\'s own id for its series', async () => {
    // An add-on episode of another series whose own TMDB id happens to equal a
    // series in the library.
    playing = episode('Another Show', 1, 1, { uniqueid: { tmdb: '1399' } });
    const np = await now();
    assert.equal(np.match, null);
  });
});
