// Push-notification API. All endpoints are behind shelfIt's auth gate. The
// browser subscribes via the SW, then posts the subscription here; it is stored
// per device and belongs to the signed-in member (a browser has one owner: the
// last member who enabled notifications on it). VAPID keys never leave the
// server except the public key, which the client needs to subscribe.

import {
  getVapidPublicKey,
  saveSubscription,
  isSubscribed,
  removeSubscription,
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

function endpointOf(v) {
  return typeof v === 'string' && /^https:\/\//.test(v) ? v : null;
}

export default async function pushRoutes(fastify) {
  // GET /api/push/config?endpoint=<this browser's endpoint>
  // `subscribed`: whether this device notifies the signed-in member (without an
  // endpoint: whether any of their devices does).
  fastify.get('/api/push/config', async (request) => {
    const subscribed = isSubscribed(request.user.id, endpointOf(request.query.endpoint));
    return { enabled: subscribed, subscribed, publicKey: getVapidPublicKey() };
  });

  // POST /api/push/subscribe { subscription }: this device now notifies the caller.
  fastify.post('/api/push/subscribe', async (request, reply) => {
    const sub = request.body && request.body.subscription;
    if (!validSubscription(sub)) {
      reply.code(400);
      return { error: 'invalid subscription' };
    }
    saveSubscription(request.user.id, sub);
    return { ok: true };
  });

  // POST /api/push/unsubscribe { endpoint? }: stop notifying the caller on this
  // device (or, without an endpoint, on all their devices). Another member's
  // device is never touched.
  fastify.post('/api/push/unsubscribe', async (request) => {
    removeSubscription(request.user.id, endpointOf((request.body || {}).endpoint));
    return { ok: true };
  });

  // POST /api/push/test: a test notification to the caller's devices.
  fastify.post('/api/push/test', async (request, reply) => {
    if (!isSubscribed(request.user.id)) {
      reply.code(409);
      return { error: 'notifications are not enabled for this account' };
    }
    return sendTest(request.user.id, request.log);
  });
}
