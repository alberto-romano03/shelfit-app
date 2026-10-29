// A complete backup and restore between members, and What's Next right after a
// restore. (The TV Time upload is in tvtime-upload.test.js.)

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, login, client, addUser, TEST_PASSWORD } from './helpers/harness.js';
import { writeMovieMeta, writeShowMeta } from './helpers/fixtures.js';

const PAST = (n) => ({ runtime: 45, air_date: `2020-01-0${n}` });

// Imports and uploads are rate-limited per IP: give each request its own.
let ipSeq = 0;
const asXml = () => ({ 'content-type': 'application/xml', 'x-forwarded-for': `10.0.1.${++ipSeq}` });

describe('library backup v4: a member restores a complete library', () => {
  let h;
  let master;
  let anna;
  let masterId;
  let annaId;
  let xml;

  before(async () => {
    h = await startApp();
    masterId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    annaId = await addUser(h.db, { name: 'Anna', password: 'anna-pass-123' });
    master = client(h.app, await login(h.app, TEST_PASSWORD, masterId));
    anna = client(h.app, await login(h.app, 'anna-pass-123', annaId));

    writeMovieMeta(h.dataDir, 603, { title: 'The Matrix', year: 1999, runtime: 136 });
    writeMovieMeta(h.dataDir, 550, { title: 'Fight Club', year: 1999, runtime: 139 });
    writeShowMeta(h.dataDir, 1399, { title: 'Test Show', year: 2020, seasons: [[PAST(1), PAST(2), PAST(3)]] });

    const movie = (await master.post('/api/media', { tmdb_id: 603, type: 'movie', status: 'completed' })).json.id;
    await master.post('/api/media', { tmdb_id: 550, type: 'movie', status: 'plan_to_watch' });
    const show = (await master.post('/api/media', { tmdb_id: 1399, type: 'show', status: 'watching' })).json.id;
    await master.post('/api/progress', { item_id: show, season: 1, episode: 1 });
    await master.post('/api/progress', { item_id: show, season: 1, episode: 2 });

    // Fixed, distinguishable moments to check after the round trip.
    h.db.prepare('UPDATE items SET added_at = ? WHERE id = ?').run('2024-03-01 09:30:00', movie);
    h.db.prepare('UPDATE items SET added_at = ? WHERE id = ?').run('2024-05-02 20:00:00', show);
    h.db.prepare('UPDATE progress SET watched_at = ? WHERE item_id = ? AND episode = 2').run('2025-06-07 22:15:00', show);

    const sunday = (await master.post('/api/lists', { name: 'Sunday', type: 'movie' })).json.id;
    await master.post(`/api/lists/${sunday}/items`, { tmdbId: 550 });
    await master.post(`/api/lists/${sunday}/items`, { tmdbId: 603 });
    await master.post('/api/lists', { name: 'Someday', type: 'show' }); // stays empty
    h.db
      .prepare(
        `INSERT INTO favorites (user_id, movie_item_id, show_item_id, person_tmdb_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET movie_item_id = excluded.movie_item_id,
           show_item_id = excluded.show_item_id, person_tmdb_id = excluded.person_tmdb_id`
      )
      .run(masterId, movie, show, 6384);

    const res = await master.get('/api/library/export');
    assert.equal(res.status, 200);
    xml = res.body;
  });
  after(async () => {
    if (h) await h.close();
  });

  it('exports version 4 with added dates, episode times, every list and The Wall', () => {
    assert.match(xml, /<version>4<\/version>/);
    assert.match(xml, /<added_at>2024-03-01 09:30:00<\/added_at>/);
    assert.match(xml, /watched_at="2025-06-07 22:15:00"/);
    assert.match(xml, /<list name="Someday" type="show" created_at="\d+"\/>/);
    assert.match(xml, /<wall movie="603" show="1399" person="6384"\/>/);
  });

  it("restores into an empty member library exactly, and What's Next shows it at once", async () => {
    // Opened before the restore: an empty What's Next must not stick afterwards.
    const before = (await anna.get('/api/upcoming')).json;
    assert.equal(before.watch_next.length, 0);

    const res = await anna.post('/api/library/import', xml, asXml());
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json.added, 3);

    const items = h.db.prepare('SELECT tmdb_id, added_at FROM items WHERE user_id = ? ORDER BY tmdb_id').all(annaId);
    const added = Object.fromEntries(items.map((i) => [i.tmdb_id, i.added_at]));
    assert.equal(added['603'], '2024-03-01 09:30:00');
    assert.equal(added['1399'], '2024-05-02 20:00:00');

    const ep2 = h.db
      .prepare(
        `SELECT p.watched_at FROM progress p JOIN items i ON i.id = p.item_id
          WHERE i.user_id = ? AND p.season = 1 AND p.episode = 2`
      )
      .get(annaId);
    assert.equal(ep2.watched_at, '2025-06-07 22:15:00');

    const lists = (await anna.get('/api/lists')).json.lists;
    const byName = Object.fromEntries(lists.map((l) => [l.name, l]));
    assert.equal(byName.Sunday.count, 2);
    assert.equal(byName.Someday.count, 0, 'the empty list comes back too');

    const wall = h.db.prepare('SELECT * FROM favorites WHERE user_id = ?').get(annaId);
    const annaMovie = h.db.prepare("SELECT id FROM items WHERE user_id = ? AND tmdb_id = '603'").get(annaId).id;
    assert.equal(wall.movie_item_id, annaMovie);
    assert.equal(wall.person_tmdb_id, 6384);

    const after = (await anna.get('/api/upcoming')).json;
    assert.equal(after.watch_next.length, 1);
    assert.equal(after.watch_next[0].episode, 3);
  });

  it('re-importing the same file changes nothing', async () => {
    const res = await anna.post('/api/library/import', xml, asXml());
    assert.equal(res.status, 200);
    assert.equal(res.json.added, 0);
    assert.equal(res.json.merged, 0);
    const n = h.db
      .prepare('SELECT COUNT(*) AS n FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.user_id = ?')
      .get(annaId).n;
    assert.equal(n, 2);
  });

  it('still imports a version 3 file', async () => {
    const content =
      '\n    <movie tmdb_id="550">\n      <title>Fight Club</title>\n      <status>shelved</status>\n' +
      '      <play_count>1</play_count>\n      <owned>false</owned>\n      <favorite>false</favorite>\n' +
      '      <watched_in_cinema>false</watched_in_cinema>\n      <lists>\n        <list>Old list</list>\n' +
      '      </lists>\n    </movie>\n  ';
    const v3 =
      '<?xml version="1.0" encoding="UTF-8"?>\n<shelfit_library>\n  <meta>\n    <version>3</version>\n' +
      `    <exported_at>2026-01-01T00:00:00Z</exported_at>\n    <checksum>${crypto.createHash('sha256').update(content, 'utf8').digest('hex')}</checksum>\n` +
      `    <entry_count>1</entry_count>\n  </meta>\n  <library>${content}</library>\n</shelfit_library>\n`;
    const res = await master.post('/api/library/import', v3, asXml());
    assert.equal(res.status, 200, res.body);
    const lists = (await master.get('/api/lists')).json.lists.map((l) => l.name);
    assert.ok(lists.includes('Old list'));
  });
});
