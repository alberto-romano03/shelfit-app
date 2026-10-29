// Custom lists: names are capped so a list fits its card on two lines.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, TEST_PASSWORD } from './helpers/harness.js';

describe('custom lists', () => {
  let h;
  let api;

  before(async () => {
    h = await startApp();
    api = client(h.app, await login(h.app, TEST_PASSWORD));
  });
  after(async () => {
    if (h) await h.close();
  });

  it('accepts a name of up to 40 characters, on create and rename', async () => {
    const ok = await api.post('/api/lists', { name: 'x'.repeat(40), type: 'movie' });
    assert.equal(ok.status, 201);
    const tooLong = await api.post('/api/lists', { name: 'x'.repeat(41), type: 'movie' });
    assert.equal(tooLong.status, 400);
    assert.equal((await api.patch(`/api/lists/${ok.json.id}`, { name: 'y'.repeat(41) })).status, 400);
    assert.equal((await api.patch(`/api/lists/${ok.json.id}`, { name: 'Sunday Night' })).status, 200);
  });

  it('counts characters, not bytes', async () => {
    const res = await api.post('/api/lists', { name: 'è'.repeat(40), type: 'show' });
    assert.equal(res.status, 201);
  });
});
