// Push-notification API. All endpoints are behind shelfIt's auth gate. The
// browser subscribes via the SW, then posts the subscription here; a single
// subscription is kept (single-user). VAPID keys never leave the server except
// the public key, which the client needs to subscribe.

import {
  getVapidPublicKey,
  isPushEnabled,
  setPushEnabled,
  getSubscription,
  setSubscription,
  clearSubscription,
  getPushOwner,
  sendTest,
} from '../push.js';

// Validate the shape the browser's PushSubscription.toJSON() produces.
function validSubscription(s) {
  return (
    s &&
    typeof s.endpoint === 'string' &&
    /^https:\/\//.test(s.endpoint) &&
    s.keys &&
    typeof s.keys.p256dh === 'string' &&
    typeof s.keys.auth === 'string'
  );
}

export default async function pushRoutes(fastify) {
  // Config the client needs to render the toggle and subscribe.
  // The one subscription belongs to whoever turned notifications on: everyone
  // else sees the toggle off, as on a device that never subscribed.
  fastify.get('/api/push/config', async (request) => {
    const mine = getPushOwner() === request.user.id;
    return {
      enabled: mine && isPushEnabled(),
      subscribed: mine && !!getSubscription(),
      publicKey: getVapidPublicKey(),
    };
  });

  // Store a browser subscription and enable notifications.
  fastify.post('/api/push/subscribe', async (request, reply) => {
    const sub = request.body && request.body.subscription;
    if (!validSubscription(sub)) {
      reply.code(400);
      return { error: 'invalid subscription' };
    }
    setSubscription(sub, request.user.id);
    setPushEnabled(true);
    return { ok: true };
  });

  // Remove the subscription and disable notifications entirely.
  fastify.post('/api/push/unsubscribe', async (request) => {
    if (getPushOwner() !== request.user.id) return { ok: true }; // not theirs to remove
    clearSubscription();
    setPushEnabled(false);
    return { ok: true };
  });

  // Send a test notification so the user can confirm delivery works.
  fastify.post('/api/push/test', async (request, reply) => {
    if (getPushOwner() !== request.user.id) {
      reply.code(409);
      return { error: 'notifications are not enabled for this account' };
    }
    return sendTest(request.log);
  });
}
