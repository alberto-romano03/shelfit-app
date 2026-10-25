// Baseline behaviour of today's single-user app. These tests pin what the current
// user sees (auth, library, progress, Up Next, stats, lists, The Wall, profile,
// backup) so the multi-user work can prove it changed nothing for them.
// The steps share one app and run in order: each builds on the previous state.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, waitFor } from './helpers/harness.js';
import { writeMovieMeta, writeShowMeta } from './helpers/fixtures.js';

const MOVIE = 603;
const SHOW = 1396;

describe('single-user baseline', () => {
  let h;
  let api;
  let movieId;
  let showId;

  before(async () => {
    h = await startApp();
    writeMovieMeta(h.dataDir, MOVIE, { title: 'The Matrix', year: 1999, runtime: 136, genres: ['Action'] });
    writeShowMeta(h.dataDir, SHOW, {
      title: 'Breaking Bad',
      year: 2008,
      runTime: 45,
      genres: ['Drama'],
      seasons: [
        [
          { runtime: 50, air_date: '2008-01-20' },
          { runtime: 40, air_date: '2008-01-27' },
          { runtime: null, air_date: '2008-02-10' },
        ],
        [
          { runtime: 47, air_date: '2009-03-08' },
          { runtime: 47, air_date: '2009-03-15' },
        ],
      ],
    });
    api = client(h.app, await login(h.app));
  });

  after(async () => {
    if (h) await h.close();
  });

  it('starts at schema version 0 with no migrations pending', () => {
    assert.equal(h.db.pragma('user_version', { simple: true }), 0);
  });

  it('gates the API and pages behind the session', async () => {
    const anon = client(h.app, null);
    assert.equal((await anon.get('/api/media')).status, 401);
    const page = await anon.get('/movies');
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/shelfit/login');
    assert.equal((await anon.get('/api/health')).status, 200);

    const wrong = await anon.post('/api/auth/login', { password: 'nope' });
    assert.equal(wrong.status, 401);

    const status = await api.get('/api/auth/status');
    assert.deepEqual(status.json, { enabled: true, authenticated: true });
  });

  it('adds titles from cached metadata', async () => {
    const m = await api.post('/api/media', { tmdb_id: MOVIE, type: 'movie', status: 'completed' });
    assert.equal(m.status, 201);
    movieId = m.json.id;

    const s = await api.post('/api/media', { tmdb_id: SHOW, type: 'show', status: 'watching' });
    assert.equal(s.status, 201);
    showId = s.json.id;

    const dup = await api.post('/api/media', { tmdb_id: MOVIE, type: 'movie' });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.item_id, movieId);

    // Not cached and no TMDB key: the add fails cleanly, nothing is inserted.
    const missing = await api.post('/api/media', { tmdb_id: 999999, type: 'movie' });
    assert.equal(missing.status, 502);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM items').get().c, 2);
  });

  it('lists the library with filters and pagination', async () => {
    const all = await api.get('/api/media');
    assert.equal(all.json.items.length, 2);

    const movies = await api.get('/api/media?type=movie');
    assert.equal(movies.json.items.length, 1);
    const [matrix] = movies.json.items;
    assert.equal(matrix.title_it, 'The Matrix');
    assert.equal(matrix.year, '1999');
    assert.deepEqual(matrix.genres, ['Action']);
    assert.equal(matrix.poster_url, `/assets/movies/${MOVIE}/poster.webp`);

    const page = await api.get('/api/media?type=show&sort=title&page=1&pageSize=1');
    assert.equal(page.json.total, 1);
    assert.equal(page.json.totalPages, 1);
    assert.deepEqual(page.json.groups, [{ key: 'B', label: 'B', count: 1 }]);
    assert.deepEqual(page.json.genres, ['Drama']);
  });

  it('updates status and rating with validation', async () => {
    assert.equal((await api.patch(`/api/media/${movieId}`, { rating: 4 })).status, 200);
    assert.equal((await api.patch(`/api/media/${movieId}`, { rating: 9 })).status, 400);
    assert.equal((await api.patch(`/api/media/${movieId}`, { status: 'bogus' })).status, 400);

    const detail = await api.get(`/api/media/${movieId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.rating, 4);
    assert.equal(detail.json.status, 'completed');
    assert.equal(detail.json.meta.runtime, 136);
    assert.equal((await api.get('/api/media/424242')).status, 404);
  });

  it('records episode progress and reports skipped episodes', async () => {
    const first = await api.post('/api/progress', { item_id: showId, season: 1, episode: 1 });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.previous_unseen, []);

    const third = await api.post('/api/progress', { item_id: showId, season: 1, episode: 3 });
    assert.deepEqual(third.json.previous_unseen, [{ season: 1, episode: 2 }]);
    assert.equal(third.json.caught_up, false);

    assert.equal((await api.post('/api/progress', { item_id: showId, season: 0, episode: 1 })).status, 400);

    const prog = await api.get(`/api/media/${showId}/progress`);
    assert.deepEqual(
      prog.json.progress.map((p) => [p.season, p.episode, p.watch_count]),
      [
        [1, 1, 1],
        [1, 3, 1],
      ]
    );

    const detail = await api.get(`/api/media/${showId}`);
    assert.equal(detail.json.progress.watched_episodes, 2);
    assert.equal(detail.json.progress.total_episodes, 5);
    assert.equal(detail.json.progress.current_season, 1);
  });

  it('resolves Up Next to the earliest unwatched aired episode', async () => {
    const res = await api.get('/api/upcoming');
    assert.equal(res.status, 200);
    const next = res.json.watch_next.find((w) => w.item_id === showId);
    assert.ok(next, 'the watching show is in Up Next');
    assert.equal(next.season, 1);
    assert.equal(next.episode, 2);
    assert.equal(next.season_watched, 2);
    assert.equal(next.season_total, 3);
  });

  it('computes lifetime stats', async () => {
    const stats = await waitFor(async () => {
      const s = (await api.get('/api/stats')).json;
      return s && s.total_episodes_watched === 2 && s.total_movies_completed === 1 ? s : null;
    });
    assert.equal(stats.total_minutes_movies, 136);
    // Episode 1 has its own runtime (50); episode 3 has none, so the series
    // runtime (45) is used.
    assert.equal(stats.total_minutes_shows, 95);
    assert.equal(stats.is_estimated, false);
  });

  it('manages custom lists', async () => {
    const created = await api.post('/api/lists', { name: 'Favs', type: 'movie' });
    assert.equal(created.status, 201);
    const add = await api.post(`/api/lists/${created.json.id}/items`, { tmdbId: MOVIE });
    assert.equal(add.status, 200);
    const lists = await api.get('/api/lists');
    const favs = lists.json.lists.find((l) => l.id === created.json.id);
    assert.equal(favs.count, 1);
  });

  it('pins a title on The Wall', async () => {
    const res = await api.patch(`/api/favorites/movie/${MOVIE}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.movie.tmdb_id, String(MOVIE));
    assert.equal((await api.get('/api/favorites')).json.movie.id, movieId);
  });

  it('updates the profile', async () => {
    assert.equal((await api.patch('/api/profile', { display_name: '  ' })).status, 400);
    assert.equal((await api.patch('/api/profile', { display_name: 'Tester' })).status, 200);
    assert.equal((await api.get('/api/profile')).json.display_name, 'Tester');
  });

  it('exports the library and re-imports it without duplicating anything', async () => {
    const exp = await api.get('/api/library/export');
    assert.equal(exp.status, 200);
    assert.match(exp.headers['content-type'], /application\/xml/);
    assert.match(exp.body, /<entry_count>2<\/entry_count>/);
    assert.match(exp.body, new RegExp(`<movie tmdb_id="${MOVIE}">`));
    assert.match(exp.body, new RegExp(`<show tmdb_id="${SHOW}">`));
    assert.match(exp.body, /<rating>4<\/rating>/);

    const imp = await api.post('/api/library/import', exp.body, { 'content-type': 'application/xml' });
    assert.equal(imp.status, 200);
    assert.equal(imp.json.added, 0);
    assert.equal(imp.json.failed, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM items').get().c, 2);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM progress').get().c, 2);
  });

  it('deletes titles with their progress and list entries', async () => {
    assert.equal((await api.del(`/api/media/${movieId}`)).status, 200);
    assert.equal((await api.get(`/api/media/${movieId}`)).status, 404);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM list_items WHERE tmdb_id = ?').get(MOVIE).c, 0);
    assert.equal((await api.get('/api/favorites')).json.movie, null);

    assert.equal((await api.del(`/api/media/${showId}`)).status, 200);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM progress').get().c, 0);
  });
});
