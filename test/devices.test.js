// Phase 4, server side of a shared device: the readable user-hint cookie that
// lets the client pick the right on-device cache, and push subscriptions owned
// per device by the member who enabled them.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, addUser, TEST_PASSWORD } from './helpers/harness.js';

const cookies = (res) => [].concat(res.headers['set-cookie'] || []);
const cookieNamed = (res, name) => cookies(res).find((c) => c.startsWith(`${name}=`));
const sub = (id) => ({ endpoint: `https://push.example.com/${id}`, keys: { p256dh: `p-${id}`, auth: `a-${id}` } });

async function signIn(app, userId, password) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { user_id: userId, password } });
  assert.equal(res.statusCode, 200);
  return res;
}

describe('shared devices', () => {
  let h;
  let masterId;
  let memberId;
  let master;
  let member;

  before(async () => {
    h = await startApp();
    masterId = h.db.prepare("SELECT id FROM users WHERE role = 'master'").get().id;
    memberId = await addUser(h.db, { name: 'Giulia', password: 'member-pass-1' });
    master = client(h.app, cookieNamed(await signIn(h.app, masterId, TEST_PASSWORD), 'shelfit_session').split(';')[0]);
    member = client(h.app, cookieNamed(await signIn(h.app, memberId, 'member-pass-1'), 'shelfit_session').split(';')[0]);
  });
  after(async () => {
    if (h) await h.close();
  });

  it('states whose session it is in a readable cookie at sign-in', async () => {
    const res = await signIn(h.app, memberId, 'member-pass-1');
    const uid = cookieNamed(res, 'shelfit_uid');
    assert.ok(uid, 'uid cookie set');
    assert.match(uid, new RegExp(`^shelfit_uid=${memberId};`));
    assert.match(uid, /Path=\/shelfit\//);
    assert.doesNotMatch(uid, /HttpOnly/, 'the client must be able to read it');
    assert.match(cookieNamed(res, 'shelfit_session'), /HttpOnly/);
  });

  it('restates it when a request arrives without it, or with someone else\'s', async () => {
    const bare = await member.get('/api/profile');
    assert.match(cookieNamed(bare, 'shelfit_uid') || '', new RegExp(`^shelfit_uid=${memberId};`));
    const wrong = await h.app.inject({
      method: 'GET',
      url: '/api/profile',
      headers: { cookie: `${member.cookie}; shelfit_uid=${masterId}` },
    });
    assert.match(cookieNamed(wrong, 'shelfit_uid') || '', new RegExp(`^shelfit_uid=${memberId};`));
    const right = await h.app.inject({
      method: 'GET',
      url: '/api/profile',
      headers: { cookie: `${member.cookie}; shelfit_uid=${memberId}` },
    });
    assert.equal(cookieNamed(right, 'shelfit_uid'), undefined, 'nothing to restate');
  });

  it('clears both cookies on sign-out', async () => {
    const session = cookieNamed(await signIn(h.app, memberId, 'member-pass-1'), 'shelfit_session').split(';')[0];
    const res = await client(h.app, session).post('/api/auth/logout');
    assert.match(cookieNamed(res, 'shelfit_session'), /Max-Age=0/);
    const uid = cookies(res).filter((c) => c.startsWith('shelfit_uid='));
    assert.ok(uid.length && /Max-Age=0/.test(uid[uid.length - 1]), 'the last uid cookie clears it');
  });

  it('keeps push subscriptions per device, owned by who enabled them', async () => {
    assert.equal((await master.post('/api/push/subscribe', { subscription: sub('a') })).status, 200);
    assert.equal((await member.post('/api/push/subscribe', { subscription: sub('b') })).status, 200);
    const cfg = async (c, id) => (await c.get(`/api/push/config?endpoint=${encodeURIComponent(sub(id).endpoint)}`)).json.subscribed;
    assert.equal(await cfg(master, 'a'), true);
    assert.equal(await cfg(member, 'a'), false, "another member's device");
    assert.equal(await cfg(member, 'b'), true);
    assert.equal((await master.get('/api/push/config')).json.subscribed, true, 'any device');

    // The member enables notifications in the browser the master used: it is theirs now.
    await member.post('/api/push/subscribe', { subscription: sub('a') });
    assert.equal(await cfg(master, 'a'), false);
    assert.equal(await cfg(member, 'a'), true);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions').get().c, 2);

    // Unsubscribing names a device, and only ever removes the caller's.
    await master.post('/api/push/unsubscribe', { endpoint: sub('b').endpoint });
    assert.equal(await cfg(member, 'b'), true);
    await member.post('/api/push/unsubscribe', { endpoint: sub('b').endpoint });
    assert.equal(await cfg(member, 'b'), false);
    assert.equal(await cfg(member, 'a'), true);

    assert.equal((await master.post('/api/push/test')).status, 409, 'the master has no device left');
    assert.equal((await member.post('/api/push/subscribe', { subscription: { endpoint: 'http://insecure' } })).status, 400);
  });

  it('stops a member\'s notifications everywhere when they sign out everywhere', async () => {
    await member.post('/api/push/subscribe', { subscription: sub('c') });
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?').get(memberId).c, 2);
    await master.post('/api/push/subscribe', { subscription: sub('d') });
    await member.post('/api/auth/logout-all');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?').get(memberId).c, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?').get(masterId).c, 1);
  });

  it('drops a member\'s devices when the master turns their sign-in off', async () => {
    const again = client(h.app, cookieNamed(await signIn(h.app, memberId, 'member-pass-1'), 'shelfit_session').split(';')[0]);
    await again.post('/api/push/subscribe', { subscription: sub('e') });
    await master.patch(`/api/household/members/${memberId}`, { disabled: true });
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?').get(memberId).c, 0);
  });
});
