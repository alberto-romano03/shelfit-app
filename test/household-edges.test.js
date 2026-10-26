// Edge cases found in the full multi-user audit: Kodi syncing into another
// member, a disabled sync owner, the shared cache outliving a library entry while
// a list or a loan still needs it, a member's cache clear keeping the household's
// artwork, removing a member's leftovers, and what the sign-in cookies do when a
// session ends or another member signs in on the same device.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startApp, login, client, addUser, TEST_PASSWORD } from './helpers/harness.js';
import { writeMovieMeta } from './helpers/fixtures.js';

// A stand-in Kodi answering the two library calls the sync makes.
function fakeKodi(movies) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { method, id } = JSON.parse(body || '{}');
      const result =
        method === 'VideoLibrary.GetMovies' ? { movies } : method === 'VideoLibrary.GetTVShows' ? { tvshows: [] } : {};
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('household edge cases', () => {
  let h;
  let master;
  let member;
  let masterId;
  let memberId;
  let kodi;
  const movieDir = () => path.join(h.dataDir, 'cache', 'movies', '603');

  before(async () => {
    h = await startApp();
    masterId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    memberId = await addUser(h.db, { name: 'Giulia', password: 'member-pass-1' });
    master = client(h.app, await login(h.app, TEST_PASSWORD, masterId));
    member = client(h.app, await login(h.app, 'member-pass-1', memberId));
    writeMovieMeta(h.dataDir, 603, { title: 'The Matrix', year: 1999, runtime: 136 });
    kodi = await fakeKodi([{ movieid: 1, title: 'The Matrix', year: 1999, playcount: 1, uniqueid: { tmdb: '603' } }]);
  });
  after(async () => {
    if (kodi) kodi.close();
    if (h) await h.close();
  });

  it("hands a manual Kodi sync into another member to that member's review", async () => {
    const port = kodi.address().port;
    const created = await master.post('/api/kodi/instances', {
      name: 'Bedroom',
      host: '127.0.0.1',
      port,
      sync_user_id: memberId,
    });
    assert.equal(created.status, 200);
    assert.equal((await master.patch('/api/kodi/enabled', { enabled: true })).status, 200);

    const res = await master.post('/api/kodi/sync');
    assert.equal(res.status, 200);
    // The master never sees the member's titles, only who will review them.
    assert.deepEqual(res.json.discoveries, []);
    assert.equal(res.json.handedTo, 'Giulia');
    assert.equal(res.json.handedCount, 1);

    assert.equal((await master.get('/api/kodi/status')).json.pending_review, 0);
    assert.equal((await member.get('/api/kodi/status')).json.pending_review, 1);
    const claimed = (await member.post('/api/kodi/sync/claim')).json.discoveries;
    assert.equal(claimed.length, 1);
    assert.equal(String(claimed[0].tmdb_id), '603');
    const commit = await member.post('/api/kodi/sync/commit', {
      items: [{ tmdb_id: '603', type: 'movie', status: 'completed' }],
    });
    assert.equal(commit.json.added, 1);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM items WHERE user_id = ?').get(memberId).n, 1);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM items WHERE user_id = ?').get(masterId).n, 0);
  });

  it('syncs into the master while the chosen member is disabled', async () => {
    const { syncOwnerId } = await import('../server/kodiSync.js');
    assert.equal(syncOwnerId(), memberId);
    assert.equal((await master.patch(`/api/household/members/${memberId}`, { disabled: true })).status, 200);
    assert.equal(syncOwnerId(), masterId);
    // The setting itself is kept, so re-enabling restores it.
    assert.equal((await master.get('/api/kodi/config')).json.instances[0].sync_user_id, memberId);
    assert.equal((await master.patch(`/api/household/members/${memberId}`, { disabled: false })).status, 200);
    assert.equal(syncOwnerId(), memberId);
    // Disabling revoked the member's sessions.
    member = client(h.app, await login(h.app, 'member-pass-1', memberId));
  });

  it("keeps a title's cache while another member's list still holds it", async () => {
    const memberItem = h.db.prepare('SELECT id FROM items WHERE user_id = ?').get(memberId);
    assert.equal((await member.del(`/api/media/${memberItem.id}`)).status, 200);
    assert.equal(fs.existsSync(movieDir()), false); // nobody used it: reclaimed

    writeMovieMeta(h.dataDir, 603, { title: 'The Matrix', year: 1999, runtime: 136 });
    const list = (await member.post('/api/lists', { name: 'Someday', type: 'movie' })).json;
    const listId = list.id ?? list.list.id;
    assert.equal((await member.post(`/api/lists/${listId}/items`, { tmdbId: 603 })).status < 300, true);
    const added = await master.post('/api/media', { tmdb_id: 603, type: 'movie', status: 'plan_to_watch' });
    assert.equal(added.status < 300, true);
    const masterItem = h.db.prepare('SELECT id FROM items WHERE user_id = ?').get(masterId);
    assert.equal((await master.del(`/api/media/${masterItem.id}`)).status, 200);
    assert.equal(fs.existsSync(movieDir()), true); // the member's list still shows it
    const items = (await member.get(`/api/lists/${listId}/items`)).json;
    assert.match(JSON.stringify(items), /The Matrix/);

    // A pending loan keeps it too.
    assert.equal((await member.del(`/api/lists/${listId}/items/603`)).status, 200);
    await master.post('/api/media', { tmdb_id: 603, type: 'movie', status: 'plan_to_watch' });
    assert.equal((await master.post('/api/suggestions', { to_user_id: memberId, type: 'movie', tmdb_id: 603 })).status < 300, true);
    const again = h.db.prepare('SELECT id FROM items WHERE user_id = ?').get(masterId);
    await master.del(`/api/media/${again.id}`);
    assert.equal(fs.existsSync(movieDir()), true);
  });

  it("keeps the household's custom artwork when a member clears a title", async () => {
    const { setCustom } = await import('../server/customImages.js');
    fs.writeFileSync(path.join(movieDir(), 'poster.webp'), Buffer.from('custom-poster'));
    setCustom('movie', '603', 'poster');

    assert.equal((await member.del('/api/admin/cache/movie/603')).status, 200);
    assert.equal(fs.readFileSync(path.join(movieDir(), 'poster.webp'), 'utf8'), 'custom-poster');
    assert.equal(fs.existsSync(path.join(movieDir(), 'meta.json')), false); // the rest is rebuilt lazily
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM title_art WHERE tmdb_id = '603'").get().n, 1);

    // The master's clear is the full reset it always was.
    assert.equal((await master.del('/api/admin/cache/movie/603')).status, 200);
    assert.equal(fs.existsSync(movieDir()), false);
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM title_art WHERE tmdb_id = '603'").get().n, 0);
  });

  it("removes a member's cached stats with the member", async () => {
    const extra = await addUser(h.db, { name: 'Marco', password: 'member-pass-2' });
    h.db.prepare("INSERT INTO stats_cache (key, value, updated_at) VALUES (?, '{}', datetime('now'))").run(`summary:${extra}`);
    assert.equal((await master.del(`/api/household/members/${extra}`)).status, 200);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM stats_cache WHERE key = ?').get(`summary:${extra}`).n, 0);
  });

  it('drops the member hint cookie when the session is gone', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/profile',
      headers: { cookie: `shelfit_session=${'0'.repeat(64)}; shelfit_uid=${memberId}` },
    });
    assert.equal(res.statusCode, 401);
    const set = [].concat(res.headers['set-cookie'] || []).join('\n');
    assert.match(set, /shelfit_uid=;[^\n]*Max-Age=0/);
  });

  it("ends the previous session when someone else signs in on the same device", async () => {
    const masterCookie = await login(h.app, TEST_PASSWORD, masterId);
    assert.equal((await client(h.app, masterCookie).get('/api/profile')).status, 200);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { user_id: memberId, password: 'member-pass-1' },
      headers: { cookie: masterCookie },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((await client(h.app, masterCookie).get('/api/profile')).status, 401);
  });
});
