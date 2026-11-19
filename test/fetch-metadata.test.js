// The Fetch Metadata guard (server/security.js): the app's own pages, direct
// visits and non-browser clients get through; calls from other sites are refused,
// except a plain page navigation (a magic or shared link opened from a chat app).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, addUser } from './helpers/harness.js';

describe('fetch metadata guard', () => {
  let h;
  let cookie;

  before(async () => {
    h = await startApp();
    const id = await addUser(h.db, { name: 'Anna', password: 'anna-pass-123' });
    cookie = await login(h.app, 'anna-pass-123', id);
  });
  after(async () => {
    if (h) await h.close();
  });

  const call = (method, url, site, extra = {}) =>
    h.app.inject({
      method,
      url,
      headers: { cookie, 'content-type': 'application/json', ...(site ? { 'sec-fetch-site': site } : {}), ...extra },
      payload: method === 'GET' ? undefined : JSON.stringify({ list_name: 'x' }),
    });

  it('lets the app itself and non-browser clients through', async () => {
    assert.equal((await call('GET', '/api/profile', 'same-origin')).statusCode, 200);
    assert.equal((await call('GET', '/api/profile', 'none')).statusCode, 200);
    assert.equal((await call('GET', '/api/profile', null)).statusCode, 200);
  });

  it('refuses cross-site and same-site calls', async () => {
    for (const site of ['cross-site', 'same-site']) {
      assert.equal((await call('GET', '/api/profile', site, { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).statusCode, 403, site);
      assert.equal((await call('POST', '/api/lists', site, { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).statusCode, 403, site);
      assert.equal((await call('GET', '/api/profile/photo', site, { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' })).statusCode, 403, site);
    }
  });

  it('allows a plain page navigation from another site, GET only', async () => {
    const nav = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    assert.notEqual((await call('GET', '/share?text=x', 'cross-site', nav)).statusCode, 403);
    assert.equal((await call('POST', '/api/lists', 'cross-site', nav)).statusCode, 403);
  });
});
