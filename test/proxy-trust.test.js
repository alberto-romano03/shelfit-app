// X-Forwarded-* comes only from the reverse proxy: from any other peer (another
// container on the shared network) the client IP is the peer itself and the
// scheme is not taken on its word.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, addUser } from './helpers/harness.js';

// Read by server/security.js when the app loads.
process.env.TRUSTED_PROXY = '10.9.9.9';

const PROXY = '10.9.9.9';
const STRANGER = '172.18.0.5';

describe('reverse proxy trust', () => {
  let h;
  let userId;

  before(async () => {
    h = await startApp();
    userId = await addUser(h.db, { name: 'Anna', password: 'anna-pass-123' });
  });
  after(async () => {
    if (h) await h.close();
    delete process.env.TRUSTED_PROXY;
  });

  const tryLogin = (remoteAddress, xff, password = 'wrong-password') =>
    h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress,
      headers: { 'x-forwarded-for': xff },
      payload: { user_id: userId, password },
    });

  it('ignores a forwarded client IP from a peer that is not the proxy', async () => {
    // Five failures lock the address out; a new X-Forwarded-For each time must
    // not reset that when the stranger sets it itself.
    for (let i = 0; i < 5; i++) assert.equal((await tryLogin(STRANGER, `198.51.100.${i}`)).statusCode, 401);
    assert.equal((await tryLogin(STRANGER, '198.51.100.99', 'anna-pass-123')).statusCode, 429);
  });

  it('believes the proxy', async () => {
    // Through the proxy each forwarded address is its own caller: no lock-out
    // carried over from the stranger.
    const res = await tryLogin(PROXY, '203.0.113.7', 'anna-pass-123');
    assert.equal(res.statusCode, 200);
  });

  it('takes https from the proxy only', async () => {
    const login = (remoteAddress) =>
      h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress,
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.8' },
        payload: { user_id: userId, password: 'anna-pass-123' },
      });
    const viaProxy = [].concat((await login(PROXY)).headers['set-cookie'])[0];
    assert.match(viaProxy, /; Secure/);
    const direct = [].concat((await login('172.18.0.6')).headers['set-cookie'])[0];
    assert.doesNotMatch(direct, /; Secure/);
  });
});
