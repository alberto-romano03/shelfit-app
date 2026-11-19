// Addresses the server sends requests to on a member's say-so: a Kodi host is a
// plain host name or IPv4 address with a real port, and a push endpoint must be
// one of the browsers' push services.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client } from './helpers/harness.js';

describe('outbound addresses', () => {
  let h;
  let api;

  before(async () => {
    h = await startApp();
    api = client(h.app, await login(h.app));
  });
  after(async () => {
    if (h) await h.close();
  });

  it('accepts only a plain Kodi host and a real port', async () => {
    const { validKodiHost, validKodiPort } = await import('../server/kodi.js');
    for (const ok of ['192.168.1.50', 'kodi', 'living-room.local', 'kodi.tail1234.ts.net']) assert.ok(validKodiHost(ok), ok);
    for (const bad of ['', 'evil.test/x', 'user@evil.test', 'host?x=1', 'host#x', 'http://kodi', 'a b', '-kodi', 'kodi:8080', 'x'.repeat(254)]) {
      assert.ok(!validKodiHost(bad), bad);
    }
    for (const ok of [undefined, '', 1, 8080, '65535']) assert.ok(validKodiPort(ok), String(ok));
    for (const bad of [0, 65536, 'abc', 80.5, -1]) assert.ok(!validKodiPort(bad), String(bad));

    assert.equal((await api.post('/api/kodi/instances', { name: 'x', host: 'evil.test/steal' })).status, 400);
    assert.equal((await api.post('/api/kodi/instances', { name: 'x', host: 'kodi', port: 99999 })).status, 400);
    assert.equal((await api.post('/api/kodi/instances', { name: 'Living room', host: '192.168.1.50', port: 8080 })).status, 200);
    const id = h.db.prepare('SELECT id FROM kodi_instances').get().id;
    assert.equal((await api.patch(`/api/kodi/instances/${id}`, { host: 'a@b' })).status, 400);
    assert.equal((await api.post('/api/kodi/test', { host: 'evil.test/x' })).json.ok, false);
  });

  it('takes push subscriptions only for the push services', async () => {
    const { isPushServiceUrl } = await import('../server/routes/push.js');
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
      'https://web.push.apple.com/abc',
    ]) {
      assert.ok(isPushServiceUrl(ok), ok);
    }
    for (const bad of [
      'http://fcm.googleapis.com/x',
      'https://192.168.1.1/x',
      'https://fcm.googleapis.com.evil.test/x',
      'https://evilpush.apple.com.test/x',
      'https://user@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'not a url',
    ]) {
      assert.ok(!isPushServiceUrl(bad), bad);
    }
    const sub = (endpoint) => ({ subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });
    assert.equal((await api.post('/api/push/subscribe', sub('https://10.0.0.5/push'))).status, 400);
    assert.equal((await api.post('/api/push/subscribe', sub('https://fcm.googleapis.com/fcm/send/x'))).status, 200);
  });
});
