// An instance with no password configured (ALLOW_NO_AUTH / development): there is
// no login gate and every request acts as the master account.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from './helpers/harness.js';

describe('no password configured', () => {
  let h;
  before(async () => {
    h = await startApp({ password: null });
  });
  after(async () => {
    if (h) await h.close();
  });

  it('leaves the master without a password', () => {
    const master = h.db.prepare("SELECT * FROM users WHERE role = 'master'").get();
    assert.equal(master.password_hash, null);
  });

  it('serves every request as the master', async () => {
    const api = client(h.app, null);
    const status = (await api.get('/api/auth/status')).json;
    assert.equal(status.enabled, false);
    assert.equal(status.user.role, 'master');
    assert.equal((await api.patch('/api/profile', { display_name: 'Home' })).status, 200);
    assert.equal((await api.get('/api/profile')).json.display_name, 'Home');
    assert.equal((await api.get('/api/media')).status, 200);
  });

  it("states the master's id in the uid hint, so the device cache works", async () => {
    const masterId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    const res = await client(h.app, null).get('/api/profile');
    assert.match([].concat(res.headers['set-cookie'] || []).join('\n'), new RegExp(`shelfit_uid=${masterId};`));
    // Already stated: not repeated on every request.
    const again = await client(h.app, `shelfit_uid=${masterId}`).get('/api/profile');
    assert.equal(again.headers['set-cookie'], undefined);
  });
});
