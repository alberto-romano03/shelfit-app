// "Suggest this title to…" between household members.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, addUser, TEST_PASSWORD } from './helpers/harness.js';
import { writeMovieMeta } from './helpers/fixtures.js';

describe('suggesting a title to another member', () => {
  let h;
  let master;
  let giulia;
  let marco;
  let masterId;
  let giuliaId;
  let marcoId;

  before(async () => {
    h = await startApp();
    masterId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    giuliaId = await addUser(h.db, { name: 'Giulia', password: 'giulia-pass-1' });
    marcoId = await addUser(h.db, { name: 'Marco', password: 'marco-pass-12' });
    await addUser(h.db, { name: 'Pending' }); // invited, no password yet
    master = client(h.app, await login(h.app, TEST_PASSWORD, masterId));
    giulia = client(h.app, await login(h.app, 'giulia-pass-1', giuliaId));
    marco = client(h.app, await login(h.app, 'marco-pass-12', marcoId));
    writeMovieMeta(h.dataDir, 603, { title: 'The Matrix', year: 1999, runtime: 136 });
    writeMovieMeta(h.dataDir, 550, { title: 'Fight Club', year: 1999, runtime: 139 });
    await master.post('/api/media', { tmdb_id: 603, type: 'movie', status: 'completed' });
    await master.post('/api/media', { tmdb_id: 550, type: 'movie', status: 'completed' });
  });
  after(async () => {
    if (h) await h.close();
  });

  it('offers the other members who can sign in', async () => {
    const names = (await master.get('/api/suggestions/recipients')).json.recipients.map((r) => r.display_name);
    assert.deepEqual(names, ['Giulia', 'Marco']);
    const fromGiulia = (await giulia.get('/api/suggestions/recipients')).json.recipients.map((r) => r.display_name);
    assert.deepEqual(fromGiulia, ['Admin', 'Marco']);
  });

  it('refuses bad targets and unknown titles', async () => {
    const pendingId = h.db.prepare("SELECT id FROM users WHERE display_name = 'Pending'").get().id;
    assert.equal((await master.post('/api/suggestions', { to_user_id: masterId, type: 'movie', tmdb_id: 603 })).status, 404);
    assert.equal((await master.post('/api/suggestions', { to_user_id: pendingId, type: 'movie', tmdb_id: 603 })).status, 404);
    assert.equal((await master.post('/api/suggestions', { to_user_id: 999, type: 'movie', tmdb_id: 603 })).status, 404);
    assert.equal((await master.post('/api/suggestions', { to_user_id: giuliaId, type: 'movie', tmdb_id: 424242 })).status, 400);
    assert.equal((await master.post('/api/suggestions', { to_user_id: giuliaId, type: 'book', tmdb_id: 603 })).status, 400);
  });

  it('delivers a suggestion to the recipient only, once', async () => {
    assert.equal((await master.post('/api/suggestions', { to_user_id: giuliaId, type: 'movie', tmdb_id: 603 })).status, 201);
    assert.equal((await master.post('/api/suggestions', { to_user_id: giuliaId, type: 'movie', tmdb_id: 603 })).status, 201);
    const list = (await giulia.get('/api/suggestions')).json.suggestions;
    assert.equal(list.length, 1, 'no duplicate');
    assert.deepEqual(
      { from: list[0].from_name, title: list[0].title, year: list[0].year, type: list[0].type, poster: list[0].poster_url },
      { from: 'Admin', title: 'The Matrix', year: '1999', type: 'movie', poster: '/assets/movies/603/poster.webp' }
    );
    assert.deepEqual((await master.get('/api/suggestions')).json.suggestions, []);
    assert.deepEqual((await marco.get('/api/suggestions')).json.suggestions, []);
    assert.equal((await marco.post(`/api/suggestions/${list[0].id}/accept`)).status, 404, "not Marco's");
    assert.equal((await marco.post(`/api/suggestions/${list[0].id}/dismiss`)).status, 404);
  });

  it('dismisses for good, and a new suggestion comes back', async () => {
    const [s] = (await giulia.get('/api/suggestions')).json.suggestions;
    assert.equal((await giulia.post(`/api/suggestions/${s.id}/dismiss`)).status, 200);
    assert.deepEqual((await giulia.get('/api/suggestions')).json.suggestions, []);
    await master.post('/api/suggestions', { to_user_id: giuliaId, type: 'movie', tmdb_id: 603 });
    assert.equal((await giulia.get('/api/suggestions')).json.suggestions.length, 1);
  });

  it('adds an accepted title to the recipient\'s Plan to Watch', async () => {
    const [s] = (await giulia.get('/api/suggestions')).json.suggestions;
    const res = await giulia.post(`/api/suggestions/${s.id}/accept`);
    assert.equal(res.status, 200);
    const item = (await giulia.get(`/api/media/${res.json.item_id}`)).json;
    assert.equal(item.tmdb_id, '603');
    assert.equal(item.status, 'plan_to_watch');
    assert.deepEqual((await giulia.get('/api/suggestions')).json.suggestions, []);
    assert.equal((await master.get('/api/media')).json.items.length, 2, "the sender's library is untouched");
  });

  it('never tells the sender what the recipient owns', async () => {
    // Giulia already has 603 now: suggesting it again looks exactly the same to
    // Marco, and Giulia is simply not asked.
    await marco.post('/api/media', { tmdb_id: 603, type: 'movie', status: 'completed' });
    const res = await marco.post('/api/suggestions', { to_user_id: giuliaId, type: 'movie', tmdb_id: 603 });
    assert.equal(res.status, 201);
    assert.deepEqual(res.json, { ok: true });
    assert.deepEqual((await giulia.get('/api/suggestions')).json.suggestions, []);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM suggestions WHERE to_user_id = ?').get(giuliaId).c, 0);
  });

  it('removes a member\'s suggestions with them', async () => {
    await master.post('/api/suggestions', { to_user_id: marcoId, type: 'movie', tmdb_id: 550 });
    await giulia.post('/api/suggestions', { to_user_id: marcoId, type: 'movie', tmdb_id: 603 });
    assert.equal((await master.del(`/api/household/members/${giuliaId}`)).status, 200);
    const left = (await marco.get('/api/suggestions')).json.suggestions.map((s) => s.from_name);
    assert.deepEqual(left, ['Admin']);
  });

  it("carries the sender's note: one line, capped, the latest one wins", async () => {
    const send = (message) =>
      master.post('/api/suggestions', { to_user_id: marcoId, type: 'movie', tmdb_id: 550, message });
    const note = async () => (await marco.get('/api/suggestions')).json.suggestions[0].message;

    assert.equal((await send('  I really think\n\tyou should see this  ')).status, 201);
    assert.equal(await note(), 'I really think you should see this');

    // 100 characters at most, an emoji counting once.
    await send('\u{1F3AC}' + 'x'.repeat(150));
    const capped = await note();
    assert.equal([...capped].length, 100);
    assert.ok(capped.startsWith('\u{1F3AC}x'));

    // Blank or missing means no note (the popup then says who is lending it).
    await send('   ');
    assert.equal(await note(), null);
    await send(undefined);
    assert.equal(await note(), null);
    await send(42);
    assert.equal(await note(), null);
  });
});
