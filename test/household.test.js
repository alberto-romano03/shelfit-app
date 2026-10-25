// Phase 3: what only the master may do, the household lifecycle (add by invite,
// set your own password, rename, disable, reset, export, remove) and per-device
// sessions.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, login, client, TEST_PASSWORD } from './helpers/harness.js';
import { writeMovieMeta } from './helpers/fixtures.js';

const TOKEN_IN_URL = /\/shelfit\/login\?invite=([a-f0-9]{64})$/;
const cookieOf = (res) => [].concat(res.headers['set-cookie'] || [])[0].split(';')[0];

describe('household management', () => {
  let h;
  let anon;
  let master;
  let masterId;
  let giulia; // { id, token, password, api }

  before(async () => {
    h = await startApp();
    anon = client(h.app, null);
    masterId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    master = client(h.app, await login(h.app, TEST_PASSWORD, masterId));
    writeMovieMeta(h.dataDir, 603, { title: 'The Matrix', year: 1999, runtime: 136 });
    writeMovieMeta(h.dataDir, 550, { title: 'Fight Club', year: 1999, runtime: 139 });
  });
  after(async () => {
    if (h) await h.close();
  });

  it('defines the master-only boundary in one place', async () => {
    const { isMasterOnly } = await import('../server/auth.js');
    const yes = [
      ['GET', '/api/household/members'],
      ['DELETE', '/api/household/members/4'],
      ['GET', '/api/admin/cache/stats'],
      ['DELETE', '/api/admin/cache'],
      ['POST', '/api/admin/cache/refresh-ongoing'],
      ['GET', '/api/usage'],
      ['PATCH', '/api/usage/tmdb'],
      ['GET', '/api/import/status'],
      ['POST', '/api/import/tvtime'],
      ['PATCH', '/api/settings/metadata-language'],
      ['PATCH', '/api/kodi/enabled'],
      ['POST', '/api/kodi/instances'],
      ['DELETE', '/api/kodi/instances/2'],
      ['POST', '/api/kodi/test'],
      ['POST', '/api/kodi/sync'],
      ['GET', '/api/kodi/icons'],
      ['GET', '/api/auth/access-log'],
    ];
    const no = [
      ['POST', '/api/admin/cache/movie/603/refresh'],
      ['DELETE', '/api/admin/cache/show/1396'],
      ['GET', '/api/settings/metadata-language'],
      ['GET', '/api/kodi/config'],
      ['GET', '/api/kodi/status'],
      ['GET', '/api/kodi/now-playing'],
      ['POST', '/api/kodi/sync/claim'],
      ['POST', '/api/kodi/play'],
      ['GET', '/api/media'],
      ['GET', '/api/auth/sessions'],
      ['PUT', '/api/media/movie/603/images/poster'],
    ];
    for (const [m, p] of yes) assert.equal(isMasterOnly(m, p), true, `${m} ${p}`);
    for (const [m, p] of no) assert.equal(isMasterOnly(m, p), false, `${m} ${p}`);
  });

  it('adds a member by invite, without a password', async () => {
    const res = await master.post('/api/household/members', { display_name: '  Giulia  ' });
    assert.equal(res.status, 201);
    assert.equal(res.json.member.display_name, 'Giulia');
    assert.equal(res.json.member.has_password, false);
    assert.ok(res.json.member.invite_expires_at > Date.now());
    const m = TOKEN_IN_URL.exec(res.json.invite_url);
    assert.ok(m, res.json.invite_url);
    giulia = { id: res.json.member.id, token: m[1] };
    assert.equal(h.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(giulia.id).password_hash, null);
    assert.ok(!h.db.prepare('SELECT token_hash FROM invites').all().some((r) => r.token_hash === giulia.token));
    assert.equal((await master.post('/api/household/members', { display_name: ' ' })).status, 400);
    assert.equal((await master.post('/api/household/members', { display_name: 'x'.repeat(41) })).status, 400);
  });

  it('keeps an invited member off the picker until they choose a password', async () => {
    const picker = await h.app.inject({ method: 'GET', url: '/login' });
    assert.doesNotMatch(picker.body, /"name":"Giulia"/);
    const invite = await h.app.inject({ method: 'GET', url: `/login?invite=${giulia.token}` });
    assert.equal(invite.statusCode, 200);
    assert.match(invite.body, /var INVITE=\{"name":"Giulia"\};/);
    assert.equal(invite.headers['referrer-policy'], 'no-referrer');
    const bogus = await h.app.inject({ method: 'GET', url: `/login?invite=${'0'.repeat(64)}` });
    assert.match(bogus.body, /var INVITE=\{"invalid":true\};/);
  });

  it('lets the member choose their own password, once', async () => {
    const short = await anon.post('/api/auth/invite', { token: giulia.token, password: 'short' });
    assert.equal(short.status, 400);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/invite',
      payload: { token: giulia.token, password: 'giulia-pass-1' },
    });
    assert.equal(res.statusCode, 200);
    giulia.password = 'giulia-pass-1';
    giulia.api = client(h.app, cookieOf(res));
    const status = (await giulia.api.get('/api/auth/status')).json;
    assert.deepEqual(status.user, { id: giulia.id, display_name: 'Giulia', role: 'member' });

    const again = await anon.post('/api/auth/invite', { token: giulia.token, password: 'another-pass' });
    assert.equal(again.status, 410);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM invites').get().c, 0);
    assert.match((await h.app.inject({ method: 'GET', url: '/login' })).body, /"name":"Giulia"/);
    const log = (await master.get('/api/auth/access-log')).json.entries;
    assert.ok(log.some((e) => e.event === 'invite' && e.success && e.user === 'Giulia'));
  });

  it('refuses the instance controls to a member', async () => {
    const forbidden = [
      ['get', '/api/household/members'],
      ['post', '/api/household/members', { display_name: 'Intruder' }],
      ['get', '/api/usage'],
      ['patch', '/api/usage/tmdb', { cap: 1 }],
      ['get', '/api/admin/cache/stats'],
      ['del', '/api/admin/cache'],
      ['post', '/api/admin/cache/refresh-ongoing'],
      ['patch', '/api/settings/metadata-language', { language: 'it-IT' }],
      ['get', '/api/import/status'],
      ['patch', '/api/kodi/enabled', { enabled: true }],
      ['post', '/api/kodi/instances', { name: 'x', host: 'y' }],
      ['get', '/api/kodi/icons'],
      ['get', '/api/auth/access-log'],
    ];
    for (const [method, url, body] of forbidden) {
      const res = await giulia.api[method](url, body);
      assert.equal(res.status, 403, `${method.toUpperCase()} ${url} → ${res.status}`);
    }
    assert.equal(h.db.prepare("SELECT COUNT(*) AS c FROM users WHERE display_name = 'Intruder'").get().c, 0);
    assert.equal((await giulia.api.get('/api/kodi/config')).status, 200);
    assert.equal((await giulia.api.get('/api/settings/metadata-language')).status, 200);
    assert.equal((await master.get('/api/usage')).status, 200);
  });

  it('lists members with their state, master first', async () => {
    const members = (await master.get('/api/household/members')).json.members;
    assert.deepEqual(
      members.map((m) => [m.display_name, m.role, m.has_password, m.disabled]),
      [
        ['Admin', 'master', true, false],
        ['Giulia', 'member', true, false],
      ]
    );
    assert.equal(members[1].invite_expires_at, null);
  });

  it('renames members, the master included', async () => {
    assert.equal((await master.patch(`/api/household/members/${giulia.id}`, { display_name: 'Giulia R.' })).status, 200);
    assert.equal((await giulia.api.get('/api/profile')).json.display_name, 'Giulia R.');
    assert.equal((await master.patch(`/api/household/members/${masterId}`, { display_name: 'Alberto' })).status, 200);
    assert.equal((await master.patch(`/api/household/members/${giulia.id}`, { display_name: '' })).status, 400);
    assert.equal((await master.patch('/api/household/members/999', { display_name: 'x' })).status, 404);
  });

  it('turns sign-in off and on', async () => {
    assert.equal((await master.patch(`/api/household/members/${masterId}`, { disabled: true })).status, 400);
    assert.equal((await master.patch(`/api/household/members/${giulia.id}`, { disabled: true })).status, 200);
    assert.equal((await giulia.api.get('/api/profile')).status, 401, 'signed out at once');
    const denied = await anon.post('/api/auth/login', { user_id: giulia.id, password: giulia.password });
    assert.equal(denied.status, 401);
    assert.doesNotMatch((await h.app.inject({ method: 'GET', url: '/login' })).body, /Giulia/);
    await master.patch(`/api/household/members/${giulia.id}`, { disabled: false });
    giulia.api = client(h.app, await login(h.app, giulia.password, giulia.id));
    assert.equal((await giulia.api.get('/api/profile')).status, 200);
  });

  it('resets a password with a new invite', async () => {
    await giulia.api.post('/api/auth/magic', { label: 'Tablet' });
    assert.equal((await master.post(`/api/household/members/${masterId}/invite`)).status, 400);
    const res = await master.post(`/api/household/members/${giulia.id}/invite`);
    assert.equal(res.status, 200);
    const token = TOKEN_IN_URL.exec(res.json.invite_url)[1];
    assert.equal((await giulia.api.get('/api/profile')).status, 401, 'sessions revoked');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM magic_links WHERE user_id = ?').get(giulia.id).c, 0);
    const old = await anon.post('/api/auth/login', { user_id: giulia.id, password: giulia.password });
    assert.equal(old.status, 401, 'old password gone');
    const redeem = await h.app.inject({
      method: 'POST',
      url: '/api/auth/invite',
      payload: { token, password: 'giulia-pass-2' },
    });
    assert.equal(redeem.statusCode, 200);
    giulia.password = 'giulia-pass-2';
    giulia.api = client(h.app, cookieOf(redeem));
  });

  it('lists and signs out devices, per member', async () => {
    const second = client(h.app, await login(h.app, TEST_PASSWORD, masterId));
    const sessions = (await master.get('/api/auth/sessions')).json.sessions;
    assert.ok(sessions.length >= 2);
    assert.equal(sessions.filter((s) => s.current).length, 1);
    assert.ok(sessions.every((s) => !('token_hash' in s)));
    const fromSecond = (await second.get('/api/auth/sessions')).json.sessions;
    const secondId = fromSecond.find((s) => s.current).id;
    assert.equal((await master.del(`/api/auth/sessions/${secondId}`)).status, 200);
    assert.equal((await second.get('/api/profile')).status, 401);
    assert.equal((await master.get('/api/profile')).status, 200);

    const giuliaSession = (await giulia.api.get('/api/auth/sessions')).json.sessions[0].id;
    assert.equal((await master.del(`/api/auth/sessions/${giuliaSession}`)).status, 404, "not the master's");
    assert.equal((await giulia.api.get('/api/profile')).status, 200);
  });

  it('exports a member\'s library and removes them with everything they own', async () => {
    await master.post('/api/media', { tmdb_id: 603, type: 'movie', status: 'completed' });
    await giulia.api.post('/api/media', { tmdb_id: 603, type: 'movie', status: 'completed' });
    await giulia.api.post('/api/media', { tmdb_id: 550, type: 'movie', status: 'plan_to_watch' });
    await giulia.api.post('/api/lists', { name: 'Hers', type: 'movie' });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    await giulia.api.post('/api/profile/photo', png, { 'content-type': 'image/png' });

    const exp = await master.get(`/api/household/members/${giulia.id}/export`);
    assert.equal(exp.status, 200);
    assert.match(exp.headers['content-disposition'], /shelfit_library-giulia-r-\d{4}-\d{2}-\d{2}\.xml/);
    assert.match(exp.body, /<entry_count>2<\/entry_count>/);

    assert.equal((await master.del(`/api/household/members/${masterId}`)).status, 400);
    assert.equal((await master.del(`/api/household/members/${giulia.id}`)).status, 200);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM users WHERE id = ?').get(giulia.id).c, 0);
    for (const table of ['items', 'lists', 'sessions', 'magic_links', 'invites']) {
      assert.equal(h.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id = ?`).get(giulia.id).c, 0, table);
    }
    assert.equal((await giulia.api.get('/api/profile')).status, 401);
    assert.ok(!fs.existsSync(path.join(h.dataDir, 'profile', String(giulia.id))), 'avatar folder removed');
    assert.ok(fs.existsSync(path.join(h.dataDir, 'cache', 'movies', '603', 'meta.json')), 'the master still has 603');
    assert.ok(!fs.existsSync(path.join(h.dataDir, 'cache', 'movies', '550')), 'nobody has 550 any more');
    assert.equal((await master.get('/api/media')).json.items.length, 1);
  });
});
