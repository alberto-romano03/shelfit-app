// Member badges on the login picker: a grey circle on the avatar, only for
// members who chose a badge.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, login, client, addUser, TEST_PASSWORD } from './helpers/harness.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

describe('badges on the login picker', () => {
  let h;
  let masterId;
  let memberId;

  before(async () => {
    h = await startApp();
    masterId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    memberId = await addUser(h.db, { name: 'Giulia', password: 'member-pass-1' });
    fs.writeFileSync(path.join(h.dataDir, 'badges', 'hp_badge.png'), PNG);
  });
  after(async () => {
    if (h) await h.close();
  });

  it('shows a badge only for members who chose one', async () => {
    const master = client(h.app, await login(h.app, TEST_PASSWORD, masterId));
    assert.equal((await master.patch('/api/profile', { active_badge: 'hp_badge.png' })).status, 200);
    const page = (await h.app.inject({ method: 'GET', url: '/login' })).body;
    const profiles = JSON.parse(/var PROFILES=(\[[^;]*\]);/.exec(page)[1].replace(/\\u003c/g, '<'));
    const byId = Object.fromEntries(profiles.map((p) => [p.id, p]));
    assert.match(byId[masterId].badge, new RegExp(`^/api/auth/profiles/${masterId}/badge\\?v=\\d+$`));
    assert.equal(byId[memberId].badge, null);
  });

  it('serves the badge publicly, safely, and nothing for anyone else', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/api/auth/profiles/${masterId}/badge` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/auth/profiles/${memberId}/badge` })).statusCode, 404);
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/auth/profiles/999/badge' })).statusCode, 404);

    // A badge whose file was removed is simply not shown.
    fs.rmSync(path.join(h.dataDir, 'badges', 'hp_badge.png'));
    const page = (await h.app.inject({ method: 'GET', url: '/login' })).body;
    assert.doesNotMatch(page, /\/badge\?v=/);
  });
});
