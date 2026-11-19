// What the service worker may cache from the server: the built JS/CSS is public
// (so a new build can be precached while signed out, instead of the login page
// arriving under a .js name), and a missing file is a 404, never the SPA shell.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client } from './helpers/harness.js';

describe('static files and the SPA fallback', () => {
  let h;
  let anon;
  let api;

  before(async () => {
    h = await startApp();
    anon = client(h.app, null);
    api = client(h.app, await login(h.app));
  });
  after(async () => {
    if (h) await h.close();
  });

  it('serves /static/* without a session, as a 404 when the file is missing', async () => {
    const res = await anon.get('/static/index-0000dead.js');
    assert.equal(res.status, 404);
    assert.ok(!String(res.headers['content-type'] || '').includes('text/html'));
  });

  it('keeps everything else behind the sign-in', async () => {
    assert.equal((await anon.get('/detail/603')).status, 302);
    assert.equal((await anon.get('/static/../index.html')).status, 302);
    assert.equal((await anon.get('/static/sub/file.js')).status, 302);
    assert.equal((await anon.get('/api/profile')).status, 401);
  });

  it('answers missing asset files with a 404, not index.html', async () => {
    for (const url of ['/static/old-1234.css', '/icons/nope.png', '/font/nope.woff2', '/whatever.js', '/x/y.webp?v=2']) {
      const res = await api.get(url);
      assert.equal(res.status, 404, url);
      assert.ok(!String(res.headers['content-type'] || '').includes('text/html'), url);
    }
  });
});
