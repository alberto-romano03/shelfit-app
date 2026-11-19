// Served over https (PUBLIC_URL), the session cookie is always Secure and named
// __Secure-shelfit_session. A session still under the old name keeps working and
// is moved to the new name, so the rename signs nobody out.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, addUser } from './helpers/harness.js';

// Read by server/config.js when the app is loaded, so set before startApp.
process.env.PUBLIC_URL = 'https://shelfit.example.test';

const cookiesOf = (res) => [].concat(res.headers['set-cookie'] || []);
const named = (res, name) => cookiesOf(res).find((c) => c.startsWith(`${name}=`));

describe('secure session cookie', () => {
  let h;
  let userId;

  before(async () => {
    h = await startApp();
    userId = await addUser(h.db, { name: 'Anna', password: 'anna-pass-123' });
  });
  after(async () => {
    if (h) await h.close();
    delete process.env.PUBLIC_URL;
  });

  async function signIn() {
    // No X-Forwarded-Proto: the flag must not depend on the proxy saying https.
    const res = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { user_id: userId, password: 'anna-pass-123' } });
    assert.equal(res.statusCode, 200);
    return res;
  }

  it('sets __Secure-shelfit_session with Secure', async () => {
    const res = await signIn();
    const session = named(res, '__Secure-shelfit_session');
    assert.ok(session, cookiesOf(res).join(' | '));
    assert.match(session, /; Secure/);
    assert.match(session, /HttpOnly/);
    assert.match(named(res, 'shelfit_uid'), /; Secure/);
  });

  it('moves a session under the old name to the new one', async () => {
    const token = named(await signIn(), '__Secure-shelfit_session').split(';')[0].split('=')[1];
    const res = await h.app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie: `shelfit_session=${token}; shelfit_uid=${userId}` } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user.id, userId);
    assert.match(named(res, '__Secure-shelfit_session'), new RegExp(`^__Secure-shelfit_session=${token};.*Secure`));
    assert.match(named(res, 'shelfit_session'), /Max-Age=0/);
  });

  it('clears both names on sign-out', async () => {
    const token = named(await signIn(), '__Secure-shelfit_session').split(';')[0].split('=')[1];
    const res = await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: `__Secure-shelfit_session=${token}` } });
    assert.match(named(res, '__Secure-shelfit_session'), /Max-Age=0/);
    assert.match(named(res, 'shelfit_session'), /Max-Age=0/);
    const after = await h.app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie: `__Secure-shelfit_session=${token}` } });
    assert.notEqual(after.json()?.user?.id, userId);
  });
});
