// The master-only gate and the per-endpoint rate caps judge the route the router
// matched, not the URL as typed. The router percent-decodes the path, so before
// this a member could reach a master-only handler by re-encoding one letter
// (`/api/%68ousehold/...`) or by appending `;` (Fastify 4 read it as the start of
// the query string).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, addUser, TEST_PASSWORD } from './helpers/harness.js';

describe('route gate', () => {
  let h;
  let master;
  let member;

  before(async () => {
    h = await startApp();
    const masterId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    const memberId = await addUser(h.db, { name: 'Giulia', password: 'member-pass-1' });
    master = client(h.app, await login(h.app, TEST_PASSWORD, masterId));
    member = client(h.app, await login(h.app, 'member-pass-1', memberId));
  });
  after(async () => {
    if (h) await h.close();
  });

  it('refuses re-encoded master-only paths to a member', async () => {
    const sneaky = [
      ['get', '/api/%68ousehold/members'],
      ['post', '/api/%68ousehold/members', { display_name: 'Intruder' }],
      ['get', '/api/household/%6dembers'],
      ['patch', '/api/settings/metadata-languag%65', { language: 'it-IT' }],
      ['get', '/api/auth/access-lo%67'],
      ['post', '/api/kodi/%69nstances', { name: 'x', host: 'y' }],
      ['patch', '/api/kodi/enable%64', { enabled: true }],
      ['get', '/api/%75sage'],
      ['del', '/api/%61dmin/cache'],
    ];
    for (const [method, url, body] of sneaky) {
      const res = await member[method](url, body);
      assert.equal(res.status, 403, `${method.toUpperCase()} ${url} -> ${res.status}`);
    }
    assert.equal(h.db.prepare("SELECT COUNT(*) AS c FROM users WHERE display_name = 'Intruder'").get().c, 0);
  });

  it('no longer cuts the path at a semicolon', async () => {
    for (const [method, url] of [
      ['patch', '/api/settings/metadata-language;'],
      ['get', '/api/household/members;x'],
      ['get', '/api/auth/access-log;'],
    ]) {
      const res = await member[method](url, { language: 'it-IT' });
      assert.ok([403, 404].includes(res.status), `${method.toUpperCase()} ${url} -> ${res.status}`);
    }
    const lang = h.db.prepare("SELECT value FROM settings WHERE key = 'tmdb_language'").get().value;
    assert.equal(lang, 'en-US', 'the metadata-language handler never ran');
  });

  it('holds HEAD to the GET rules', async () => {
    const res = await h.app.inject({ method: 'HEAD', url: '/api/auth/access-log', headers: { cookie: member.cookie } });
    assert.equal(res.statusCode, 403);
  });

  it('keeps the member exceptions and the master working', async () => {
    // Per-title cache clear stays open to members, encoded or not.
    assert.notEqual((await member.del('/api/admin/cache/m%6Fvie/603')).status, 403);
    assert.notEqual((await member.del('/api/admin/cache/movie/603')).status, 403);
    // A param that doesn't fit the exception falls back to master-only.
    assert.equal((await member.del('/api/admin/cache/a%2Fb/603')).status, 403);
    assert.equal((await master.get('/api/%68ousehold/members')).status, 200);
    assert.equal((await member.get('/api/settings/metadata-language')).status, 200);
  });

  it("keeps Kodi hosts and usernames to the master", async () => {
    const made = await master.post('/api/kodi/instances', { name: 'Living room', host: '192.168.1.50', port: 8080, username: 'kodi' });
    assert.equal(made.status, 200);
    assert.equal((await master.get('/api/kodi/config')).json.instances[0].host, '192.168.1.50');
    const seen = await member.get('/api/kodi/config');
    assert.equal(seen.status, 200);
    assert.deepEqual(seen.json.instances, []);
    assert.ok(!seen.body.includes('192.168.1.50'));
    assert.ok(!seen.body.includes('"username"'));
  });

  it('counts a re-encoded path against the endpoint cap', async () => {
    const xml = { 'content-type': 'application/xml' };
    // POST /api/library/import allows 3 an hour; the bodies are rejected, but
    // every attempt still counts.
    for (let i = 0; i < 3; i += 1) {
      assert.notEqual((await member.post('/api/library/import', '<x/>', xml)).status, 429);
    }
    assert.equal((await member.post('/api/library/im%70ort', '<x/>', xml)).status, 429);
  });
});
