// Phase 5: whose library a Kodi instance syncs into (and who reviews its
// discoveries), whose library a TV Time import fills, and whose name the receipt
// carries.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, login, client, addUser, TEST_PASSWORD } from './helpers/harness.js';
import { writeMovieMeta } from './helpers/fixtures.js';

describe('integrations in a household', () => {
  let h;
  let master;
  let member;
  let masterId;
  let memberId;

  before(async () => {
    h = await startApp();
    masterId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    memberId = await addUser(h.db, { name: 'Giulia', password: 'member-pass-1' });
    master = client(h.app, await login(h.app, TEST_PASSWORD, masterId));
    member = client(h.app, await login(h.app, 'member-pass-1', memberId));
    writeMovieMeta(h.dataDir, 603, { title: 'The Matrix', year: 1999, runtime: 136 });
  });
  after(async () => {
    if (h) await h.close();
  });

  it('lets the master choose whose library each Kodi instance syncs into', async () => {
    const created = await master.post('/api/kodi/instances', {
      name: 'Living room',
      host: '192.0.2.10',
      sync_user_id: memberId,
    });
    assert.equal(created.status, 200);
    const inst = created.json.instances[0];
    assert.equal(inst.sync_user_id, memberId);
    assert.equal(inst.is_active, true);

    const { syncOwnerId } = await import('../server/kodiSync.js');
    assert.equal(syncOwnerId(), memberId);

    // An unknown member falls back to the master; so does removing the member.
    await master.patch(`/api/kodi/instances/${inst.id}`, { sync_user_id: 999 });
    assert.equal((await master.get('/api/kodi/config')).json.instances[0].sync_user_id, null);
    assert.equal(syncOwnerId(), masterId);
    await master.patch(`/api/kodi/instances/${inst.id}`, { sync_user_id: memberId });
    assert.equal(syncOwnerId(), memberId);

    // Only the master configures Kodi.
    assert.equal((await member.patch(`/api/kodi/instances/${inst.id}`, { sync_user_id: memberId })).status, 403);
  });

  it('offers scheduled discoveries only to the sync owner, and commits into their library', async () => {
    const { setPending } = await import('../server/kodiSync.js');
    setPending({ discoveries: [{ tmdb_id: '603', type: 'movie', title: 'The Matrix' }] });
    assert.equal((await master.get('/api/kodi/status')).json.pending_review, 0);
    assert.equal((await member.get('/api/kodi/status')).json.pending_review, 1);
    assert.deepEqual((await master.post('/api/kodi/sync/claim')).json.discoveries, []);
    assert.equal((await member.post('/api/kodi/sync/claim')).json.discoveries.length, 1);

    assert.equal((await master.post('/api/kodi/sync/commit', { items: [{ tmdb_id: 603, type: 'movie', status: 'completed' }] })).json.added, 0);
    const commit = await member.post('/api/kodi/sync/commit', { items: [{ tmdb_id: 603, type: 'movie', status: 'completed' }] });
    assert.equal(commit.json.added, 1);
    assert.equal((await member.get('/api/media')).json.items.length, 1);
    assert.equal((await master.get('/api/media')).json.items.length, 0);
  });

  it('removing the sync owner hands the instance back to the master', async () => {
    const { syncOwnerId } = await import('../server/kodiSync.js');
    const temp = await addUser(h.db, { name: 'Temp', password: 'temp-pass-12' });
    const id = (await master.get('/api/kodi/config')).json.instances[0].id;
    await master.patch(`/api/kodi/instances/${id}`, { sync_user_id: temp });
    assert.equal(syncOwnerId(), temp);
    assert.equal((await master.del(`/api/household/members/${temp}`)).status, 200);
    assert.equal((await master.get('/api/kodi/config')).json.instances[0].sync_user_id, null);
    assert.equal(syncOwnerId(), masterId);
  });

  it('imports TV Time into the member the master picks', async () => {
    fs.writeFileSync(path.join(h.dataDir, 'import', 'tvtime_actions.csv'), 'type,entity_type\n');
    assert.equal((await master.post('/api/import/tvtime', { user_id: 999 })).status, 404);
    assert.equal((await member.post('/api/import/tvtime', { user_id: memberId })).status, 403);
    const ok = await master.post('/api/import/tvtime', { user_id: memberId });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.job_id);
  });

  it('prints the member on their receipt', async () => {
    assert.equal((await member.get('/api/receipt')).json.totals.member, 'GIULIA');
    assert.equal((await master.get('/api/receipt')).json.totals.member, 'ADMIN');
  });
});
