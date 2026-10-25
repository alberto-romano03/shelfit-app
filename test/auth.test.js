// Household sign-in: the master created from APP_PASSWORD, the profile picker,
// per-account passwords and sessions, and the public avatar route.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, login, client, addUser, TEST_PASSWORD } from './helpers/harness.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const WEBP = Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'binary');

describe('household sign-in', () => {
  let h;
  let anon;
  let masterId;
  let memberId;
  let masterCookie;
  let memberCookie;

  before(async () => {
    h = await startApp();
    anon = client(h.app, null);
    masterId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    memberId = await addUser(h.db, { name: 'Giulia <b>', password: 'member-pass-1' });
  });
  after(async () => {
    if (h) await h.close();
  });

  it('creates the master from APP_PASSWORD on a fresh install', () => {
    const master = h.db.prepare('SELECT * FROM users WHERE id = ?').get(masterId);
    assert.equal(master.role, 'master');
    assert.equal(master.display_name, 'Admin');
    assert.match(master.password_hash, /^s2:/);
  });

  it('allows only one master', () => {
    assert.throws(
      () =>
        h.db
          .prepare("INSERT INTO users (role, display_name, created_at) VALUES ('master', 'Second', 0)")
          .run(),
      /UNIQUE/
    );
  });

  it('renders the picker with every account that can sign in, safely escaped', async () => {
    const pending = await addUser(h.db, { name: 'No password yet' });
    const disabled = await addUser(h.db, { name: 'Gone', password: 'whatever-1', disabled: 1 });
    const res = await h.app.inject({ method: 'GET', url: '/login' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.body, /"name":"Admin"/);
    assert.match(res.body, /"name":"Giulia \\u003cb>"/, 'names are escaped inside the script');
    assert.doesNotMatch(res.body, /Giulia <b>/);
    assert.doesNotMatch(res.body, /No password yet|"Gone"/);
    h.db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(pending, disabled);
  });

  it('signs each member in to their own account', async () => {
    masterCookie = await login(h.app, TEST_PASSWORD, masterId);
    memberCookie = await login(h.app, 'member-pass-1', memberId);
    const asMaster = (await client(h.app, masterCookie).get('/api/auth/status')).json;
    const asMember = (await client(h.app, memberCookie).get('/api/auth/status')).json;
    assert.deepEqual(asMaster.user, { id: masterId, display_name: 'Admin', role: 'master' });
    assert.deepEqual(asMember.user, { id: memberId, display_name: 'Giulia <b>', role: 'member' });
    const session = h.db.prepare('SELECT label FROM sessions WHERE user_id = ?').get(memberId);
    assert.equal(session.label, null, 'no user-agent, no label');
  });

  it("rejects another member's password and unknown accounts", async () => {
    const wrong = await anon.post('/api/auth/login', { user_id: memberId, password: TEST_PASSWORD });
    assert.equal(wrong.status, 401);
    const unknown = await anon.post('/api/auth/login', { user_id: 999, password: TEST_PASSWORD });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.json.error, wrong.json.error, 'same answer: no hint that an account exists');
    const attributed = h.db
      .prepare("SELECT user_id FROM access_log WHERE event = 'login' AND success = 0 ORDER BY id")
      .all()
      .map((r) => r.user_id);
    assert.deepEqual(attributed, [memberId, null]);
  });

  it('needs a user_id once more than one account exists', async () => {
    const res = await anon.post('/api/auth/login', { password: TEST_PASSWORD });
    assert.equal(res.status, 400);
  });

  it('keeps profiles separate', async () => {
    const member = client(h.app, memberCookie);
    assert.equal((await member.patch('/api/profile', { display_name: 'Giulia' })).status, 200);
    assert.equal((await member.get('/api/profile')).json.display_name, 'Giulia');
    assert.equal((await client(h.app, masterCookie).get('/api/profile')).json.display_name, 'Admin');
  });

  it('keeps profile photos separate', async () => {
    const member = client(h.app, memberCookie);
    const up = await member.post('/api/profile/photo', PNG, { 'content-type': 'image/png' });
    assert.equal(up.status, 201);
    assert.ok(fs.existsSync(path.join(h.dataDir, 'profile', String(memberId), 'avatar.png')));
    assert.equal((await client(h.app, masterCookie).get('/api/profile/photo')).status, 404);
    assert.equal((await member.get('/api/profile/photo')).status, 200);
  });

  it('serves picker avatars publicly, and nothing else', async () => {
    await client(h.app, memberCookie).patch('/api/profile', { profile_image: 'custom' });
    const photo = await anon.get(`/api/auth/profiles/${memberId}/avatar`);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers['content-type'], 'image/png');

    // A title avatar is drawn from that title's cached poster.
    const poster = path.join(h.dataDir, 'cache', 'movies', '603', 'poster.webp');
    fs.mkdirSync(path.dirname(poster), { recursive: true });
    fs.writeFileSync(poster, WEBP);
    await client(h.app, masterCookie).patch('/api/profile', { profile_image: 'movie:603' });
    const title = await anon.get(`/api/auth/profiles/${masterId}/avatar`);
    assert.equal(title.status, 200);
    assert.equal(title.headers['content-type'], 'image/webp');

    // The page links both, versioned.
    const page = await h.app.inject({ method: 'GET', url: '/login' });
    assert.match(page.body, new RegExp(`/api/auth/profiles/${memberId}/avatar\\?v=\\d+`));

    assert.equal((await anon.get('/api/auth/profiles/999/avatar')).status, 404);
    assert.equal((await anon.get('/api/auth/profiles/abc/avatar')).status, 401);
    assert.equal((await anon.get('/api/profile/photo')).status, 401);
  });

  it('signs a member out everywhere without touching anyone else', async () => {
    const second = await login(h.app, 'member-pass-1', memberId);
    const res = await client(h.app, memberCookie).post('/api/auth/logout-all');
    assert.equal(res.status, 200);
    assert.equal((await client(h.app, memberCookie).get('/api/profile')).status, 401);
    assert.equal((await client(h.app, second).get('/api/profile')).status, 401);
    assert.equal((await client(h.app, masterCookie).get('/api/profile')).status, 200);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').get(memberId).c, 0);
  });

  it('ends only the current session on logout', async () => {
    const other = await login(h.app, TEST_PASSWORD, masterId);
    await client(h.app, other).post('/api/auth/logout');
    assert.equal((await client(h.app, other).get('/api/profile')).status, 401);
    assert.equal((await client(h.app, masterCookie).get('/api/profile')).status, 200);
  });

  it('locks out a disabled account, sessions included', async () => {
    memberCookie = await login(h.app, 'member-pass-1', memberId);
    h.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(memberId);
    assert.equal((await client(h.app, memberCookie).get('/api/profile')).status, 401);
    const res = await anon.post('/api/auth/login', { user_id: memberId, password: 'member-pass-1' });
    assert.equal(res.status, 401);
    h.db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(memberId);
  });

  it('binds magic links to the member who made them', async () => {
    const member = client(h.app, (memberCookie = await login(h.app, 'member-pass-1', memberId)));
    const master = client(h.app, masterCookie);
    const made = await member.post('/api/auth/magic', { label: 'Tablet' });
    assert.equal(made.status, 201);
    assert.equal((await master.get('/api/auth/magic')).json.links.length, 0);
    assert.equal((await member.get('/api/auth/magic')).json.links.length, 1);
    assert.equal((await master.del(`/api/auth/magic/${made.json.id}`)).status, 404);

    const token = made.json.url.split('/').pop();
    const redeem = await h.app.inject({ method: 'GET', url: `/api/auth/magic/${token}` });
    assert.equal(redeem.statusCode, 302);
    const linkCookie = [].concat(redeem.headers['set-cookie'])[0].split(';')[0];
    assert.equal((await client(h.app, linkCookie).get('/api/auth/status')).json.user.id, memberId);
  });

  it('locks one account after repeated failures, from any address', async () => {
    const victim = await addUser(h.db, { name: 'Victim', password: 'victim-pass-1' });
    for (let i = 0; i < 10; i++) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': `10.0.0.${i + 1}` },
        payload: { user_id: victim, password: 'guess' },
      });
      assert.equal(res.statusCode, 401);
    }
    const locked = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '10.0.1.1' },
      payload: { user_id: victim, password: 'victim-pass-1' },
    });
    assert.equal(locked.statusCode, 429);
    // Other accounts are unaffected.
    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '10.0.1.2' },
      payload: { user_id: masterId, password: TEST_PASSWORD },
    });
    assert.equal(ok.statusCode, 200);
  });
});
