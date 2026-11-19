// Magic links: stored as a hash, opened on a confirm page (a link preview or an
// accidental open signs nobody in), signed in by the page's own POST, capped at
// 90 days, and gone after "sign out everywhere".

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, login, client, addUser } from './helpers/harness.js';

const DAY = 24 * 60 * 60 * 1000;
const FORM = { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

describe('magic link confirm', () => {
  let h;
  let api;
  let userId;

  before(async () => {
    h = await startApp();
    userId = await addUser(h.db, { name: 'Giulia <b>', password: 'giulia-pass-1' });
    api = client(h.app, await login(h.app, 'giulia-pass-1', userId));
  });
  after(async () => {
    if (h) await h.close();
  });

  async function makeLink(body = { label: 'Tablet' }) {
    const made = await api.post('/api/auth/magic', body);
    assert.equal(made.status, 201);
    return { ...made.json, token: made.json.url.split('/').pop() };
  }
  const redeem = (token, headers = FORM) =>
    h.app.inject({ method: 'POST', url: `/api/auth/magic/${token}`, headers, payload: '' });

  it('stores only a hash of the token', async () => {
    const link = await makeLink();
    const row = h.db.prepare('SELECT token_hash FROM magic_links WHERE id = ?').get(link.id);
    assert.equal(row.token_hash, sha256(link.token));
    assert.notEqual(row.token_hash, link.token);
  });

  it('opens a confirm page that signs nobody in', async () => {
    const link = await makeLink();
    const page = await h.app.inject({
      method: 'GET',
      url: `/api/auth/magic/${link.token}`,
      headers: { 'accept-language': 'it-IT,it;q=0.9', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.equal(page.headers['set-cookie'], undefined);
    assert.match(page.body, /Entra in shelfit come Giulia &lt;b&gt;/);
    assert.ok(!page.body.includes('<b>'), 'the name is escaped');
    assert.match(page.body, new RegExp(`action="/shelfit/api/auth/magic/${link.token}"`));
    assert.equal(h.db.prepare('SELECT use_count FROM magic_links WHERE id = ?').get(link.id).use_count, 0);
  });

  it('signs in on the confirm POST and counts the use', async () => {
    const link = await makeLink();
    const res = await redeem(link.token);
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/shelfit/');
    const cookie = [].concat(res.headers['set-cookie'])[0].split(';')[0];
    assert.equal((await client(h.app, cookie).get('/api/auth/status')).json.user.id, userId);
    assert.equal(h.db.prepare('SELECT use_count FROM magic_links WHERE id = ?').get(link.id).use_count, 1);
    // Still multi-use.
    assert.equal((await redeem(link.token)).statusCode, 303);
  });

  it('sends a bad token to the login page, on both steps', async () => {
    const bad = 'f'.repeat(64);
    const page = await h.app.inject({ method: 'GET', url: `/api/auth/magic/${bad}`, headers: { 'x-forwarded-for': '10.9.0.1' } });
    assert.equal(page.statusCode, 303);
    assert.equal(page.headers.location, '/shelfit/login?error=magic');
    const post = await redeem(bad, { ...FORM, 'x-forwarded-for': '10.9.0.2' });
    assert.equal(post.statusCode, 303);
    assert.equal(post.headers.location, '/shelfit/login?error=magic');
    assert.equal(post.headers['set-cookie'], undefined);
  });

  it('refuses the confirm POST from another site', async () => {
    const link = await makeLink();
    const res = await redeem(link.token, { ...FORM, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers['set-cookie'], undefined);
  });

  it('caps the lifetime at 90 days', async () => {
    const now = Date.now();
    const ninety = await makeLink({ expiry: '90d' });
    assert.ok(Math.abs(ninety.expires_at - (now + 90 * DAY)) < 60000);
    // The old one-year choice is gone: it falls back to the 30-day default.
    const year = await makeLink({ expiry: '1y' });
    assert.ok(Math.abs(year.expires_at - (now + 30 * DAY)) < 60000);
  });

  it('accepts a form body on the confirm route only', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/magic',
      headers: { ...FORM, cookie: api.cookie },
      payload: 'label=x',
    });
    assert.equal(res.statusCode, 415);
  });

  it('drops every link on sign out everywhere', async () => {
    await makeLink();
    const kept = await makeLink();
    assert.ok(h.db.prepare('SELECT COUNT(*) AS c FROM magic_links WHERE user_id = ?').get(userId).c > 0);
    assert.equal((await api.post('/api/auth/logout-all')).status, 200);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM magic_links WHERE user_id = ?').get(userId).c, 0);
    assert.equal((await redeem(kept.token, { ...FORM, 'x-forwarded-for': '10.9.0.3' })).headers.location, '/shelfit/login?error=magic');
  });
});
