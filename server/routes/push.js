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
  getReminderPrefs,
  setReminderPrefs,
  setDeviceLang,
  deviceLang,
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
    const endpoint = endpointOf(request.query.endpoint);
    const subscribed = isSubscribed(request.user.id, endpoint);
    return {
      enabled: subscribed,
      subscribed,
      lang: deviceLang(request.user.id, endpoint),
      publicKey: getVapidPublicKey(),
      reminders: getReminderPrefs(request.user.id),
    };
  });

  // POST /api/push/subscribe { subscription, lang? }: this device now notifies
  // the caller, in `lang` (the device's UI language) when given.
  fastify.post('/api/push/subscribe', async (request, reply) => {
    const sub = request.body && request.body.subscription;
    if (!validSubscription(sub)) {
      reply.code(400);
      return { error: 'invalid subscription' };
    }
    saveSubscription(request.user.id, sub, request.body.lang);
    return { ok: true };
  });

  // POST /api/push/unsubscribe { endpoint? }: stop notifying the caller on this
  // device (or, without an endpoint, on all their devices). Another member's
  // device is never touched.
  fastify.post('/api/push/unsubscribe', async (request) => {
    removeSubscription(request.user.id, endpointOf((request.body || {}).endpoint));
    return { ok: true };
  });

  // PUT /api/push/lang { endpoint, lang }: the UI language of the caller's own
  // device, so its notifications read in it.
  fastify.put('/api/push/lang', async (request, reply) => {
    const endpoint = endpointOf((request.body || {}).endpoint);
    if (!endpoint || !setDeviceLang(request.user.id, endpoint, request.body.lang)) {
      reply.code(404);
      return { error: 'no such device' };
    }
    return { ok: true };
  });

  // PUT /api/push/reminders { dusty?, cinema?, comeback? }: the caller's
  // occasional reminders on or off (all devices). Returns the full set.
  fastify.put('/api/push/reminders', async (request) => {
    return { reminders: setReminderPrefs(request.user.id, request.body || {}) };
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
