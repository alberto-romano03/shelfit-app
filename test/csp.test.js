// The app's own security headers: an enforced Content-Security-Policy with
// reporting, nosniff, COOP and CORP on every response; a login page with no
// inline script left to allow; and the public report endpoint.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client } from './helpers/harness.js';

describe('content security policy', () => {
  let h;
  let api;

  before(async () => {
    h = await startApp();
    api = client(h.app, await login(h.app));
  });
  after(async () => {
    if (h) await h.close();
  });

  it('sends the policy and the other headers on every response', async () => {
    for (const res of [
      await h.app.inject({ method: 'GET', url: '/login' }),
      await h.app.inject({ method: 'GET', url: '/api/health' }),
      await api.get('/api/profile'),
    ]) {
      const csp = res.headers['content-security-policy'];
      assert.match(csp, /script-src 'self'(;|$)/);
      assert.match(csp, /object-src 'none'/);
      assert.match(csp, /base-uri 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /report-uri \/shelfit\/api\/csp-report/);
      assert.match(csp, /report-to csp/);
      assert.match(res.headers['reporting-endpoints'], /^csp="https?:\/\/[^"]+\/shelfit\/api\/csp-report"$/);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
      assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
    }
  });

  it('serves a login page with no inline script', async () => {
    const page = (await h.app.inject({ method: 'GET', url: '/login' })).body;
    const scripts = page.match(/<script\b[^>]*>/g) || [];
    assert.ok(scripts.length >= 2, scripts.join(' '));
    for (const tag of scripts) {
      assert.ok(/\ssrc="\/shelfit\/boot\/[a-z-]+\.js"/.test(tag) || /type="application\/json"/.test(tag), tag);
    }
  });

  it('lets the boot scripts load without a session', async () => {
    for (const url of ['/boot/login.js', '/boot/login-theme.js', '/boot/head.js']) {
      const res = await h.app.inject({ method: 'GET', url });
      assert.notEqual(res.statusCode, 302, url);
      assert.notEqual(res.statusCode, 401, url);
    }
    assert.equal((await h.app.inject({ method: 'GET', url: '/boot/../index.html' })).statusCode, 302);
  });

  it('takes violation reports from anyone, in both formats', async () => {
    const legacy = await h.app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'inline', 'document-uri': 'https://x.test/shelfit/?a=1' } }),
    });
    assert.equal(legacy.statusCode, 204);
    const modern = await h.app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/reports+json' },
      payload: JSON.stringify([{ type: 'csp-violation', body: { effectiveDirective: 'img-src', blockedURL: 'https://evil.test/x.png?t=1' } }]),
    });
    assert.equal(modern.statusCode, 204);
    const junk = await h.app.inject({
      method: 'POST',
      url: '/api/csp-report',
      headers: { 'content-type': 'application/csp-report' },
      payload: '{not json',
    });
    assert.equal(junk.statusCode, 204);
  });
});
