// Web Push notifications for newly aired episodes — implemented with Node's
// built-in crypto only (no web-push dependency). Covers:
//   • VAPID (RFC 8292): a P-256 keypair generated once and stored in settings,
//     plus per-request ES256 JWT signing.
//   • Message encryption (RFC 8291 / RFC 8188 "aes128gcm"): ECDH + HKDF + AES-GCM.
//   • A once-per-day check that notifies for episodes whose air_date fell between
//     the last check and now, reusing the locally-cached TMDB air dates.
//
// Subscriptions are per device (push_subscriptions): each belongs to the member
// who enabled notifications in that browser, and gets that member's news only.
// A delivery answered 404/410 (subscription gone) drops that device's row.

import crypto from 'node:crypto';
import db from './db.js';
import { readMetaSync, readSeasonMetaSync } from './cache.js';

// --- settings helpers ------------------------------------------------------
// Prepared once at module load and reused (better-sqlite3 compiles on prepare).
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);
function getSetting(key) {
  const row = getSettingStmt.get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  setSettingStmt.run(key, value);
}

// Started/finished shows whose new episodes we notify about (prepared once).
const activeShowsStmt = db.prepare(
  "SELECT id, tmdb_id, title_it, title_orig FROM items WHERE user_id = ? AND type = 'show' AND status IN ('watching','completed','paused')"
);
const userSubsStmt = db.prepare('SELECT id, endpoint, keys FROM push_subscriptions WHERE user_id = ?');
const usersWithSubsStmt = db.prepare('SELECT DISTINCT user_id FROM push_subscriptions');
const hasSubStmt = db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? AND endpoint = ?');
// One browser, one owner: whoever enables notifications on it last.
const upsertSubStmt = db.prepare(
  `INSERT INTO push_subscriptions (user_id, endpoint, keys, created_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys`
);
const deleteSubStmt = db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?');
const deleteUserSubsStmt = db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?');
const deleteSubByIdStmt = db.prepare('DELETE FROM push_subscriptions WHERE id = ?');

const K_VAPID = 'push_vapid';
const K_LAST = 'push_last_check';

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:shelfit@example.com';

// --- subscriptions ---------------------------------------------------------
// A browser PushSubscription.toJSON(): { endpoint, keys: { p256dh, auth } }.
export function saveSubscription(userId, sub) {
  upsertSubStmt.run(userId, sub.endpoint, JSON.stringify(sub.keys), Date.now());
}
// Whether `userId` gets notifications on the device behind `endpoint` (or, with
// no endpoint, on any device).
export function isSubscribed(userId, endpoint) {
  if (endpoint) return !!hasSubStmt.get(userId, endpoint);
  return userSubsStmt.all(userId).length > 0;
}
// Stop notifications for `userId` on one device, or on all of them.
export function removeSubscription(userId, endpoint) {
  if (endpoint) deleteSubStmt.run(userId, endpoint);
  else deleteUserSubsStmt.run(userId);
}
function subscriptionsOf(userId) {
  return userSubsStmt.all(userId).map((r) => {
    let keys = {};
    try {
      keys = JSON.parse(r.keys);
    } catch {
      /* unusable row: delivery fails and it gets pruned */
    }
    return { id: r.id, endpoint: r.endpoint, keys };
  });
}

// --- VAPID keys (generated once, then persisted) ---------------------------
function generateVapidKeys() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }); // { kty, crv, x, y, d }
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const pub = Buffer.concat([Buffer.from([0x04]), x, y]); // uncompressed point
  return { publicKey: pub.toString('base64url'), jwk };
}

export function getVapid() {
  const stored = getSetting(K_VAPID);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      /* fall through and regenerate */
    }
  }
  const keys = generateVapidKeys();
  setSetting(K_VAPID, JSON.stringify(keys));
  return keys;
}

// Public VAPID key the client needs to subscribe (base64url uncompressed point).
export function getVapidPublicKey() {
  return getVapid().publicKey;
}

// --- VAPID JWT (RFC 8292) --------------------------------------------------
function signVapidJwt(audience, vapid) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ typ: 'JWT', alg: 'ES256' });
  const payload = b64({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: VAPID_SUBJECT,
  });
  const signingInput = `${header}.${payload}`;
  const privateKey = crypto.createPrivateKey({ key: vapid.jwk, format: 'jwk' });
  // ieee-p1363 → the raw r||s signature JOSE/ES256 requires (not DER).
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${sig.toString('base64url')}`;
}

// --- Payload encryption (RFC 8291 + RFC 8188 aes128gcm) --------------------
function encryptContent(subscription, payload) {
  const clientPublic = Buffer.from(subscription.keys.p256dh, 'base64url'); // 65 bytes
  const authSecret = Buffer.from(subscription.keys.auth, 'base64url'); // 16 bytes

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const serverPublic = ecdh.getPublicKey(); // 65 bytes, uncompressed
  const sharedSecret = ecdh.computeSecret(clientPublic); // 32 bytes

  // RFC 8291 §3.4: derive the input keying material from the ECDH secret,
  // keyed by the subscription's auth secret.
  const authInfo = Buffer.concat([
    Buffer.from('WebPush: info'),
    Buffer.from([0]),
    clientPublic,
    serverPublic,
  ]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, authInfo, 32));

  // RFC 8188 §2.1: content-encryption key + nonce from a fresh 16-byte salt.
  const salt = crypto.randomBytes(16);
  const cekInfo = Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([0])]);
  const nonceInfo = Buffer.concat([Buffer.from('Content-Encoding: nonce'), Buffer.from([0])]);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, cekInfo, 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, nonceInfo, 12));

  // Single record: plaintext + 0x02 delimiter (last-record marker), then AES-GCM.
  const record = Buffer.concat([payload, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  // aes128gcm content-coding header: salt(16) | rs(4) | idlen(1) | keyid | body
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  const idlen = Buffer.from([serverPublic.length]); // 65
  return Buffer.concat([salt, rs, idlen, serverPublic, ciphertext]);
}

// Send one notification. Returns the push service HTTP status (or 0 on a
// transport error). Never throws.
export async function sendPush(subscription, payloadObj, logger) {
  try {
    const vapid = getVapid();
    const audience = new URL(subscription.endpoint).origin;
    const jwt = signVapidJwt(audience, vapid);
    const body = encryptContent(subscription, Buffer.from(JSON.stringify(payloadObj), 'utf8'));
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '2419200',
        Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    return res.status;
  } catch (err) {
    if (logger) logger.warn(`push send failed: ${err.message}`);
    return 0;
  }
}

// Deliver one payload to every device of a member, dropping devices whose
// subscription is gone (404/410). Returns how many deliveries succeeded.
async function sendToUser(userId, payloadObj, logger) {
  let delivered = 0;
  for (const sub of subscriptionsOf(userId)) {
    const status = await sendPush(sub, payloadObj, logger);
    if (status === 404 || status === 410) {
      deleteSubByIdStmt.run(sub.id);
      if (logger) logger.warn(`push subscription gone for user ${userId}: device removed`);
    } else if (status >= 200 && status < 300) {
      delivered += 1;
    }
  }
  return delivered;
}

// Send a one-off test notification to the member's devices (Settings "test").
export async function sendTest(userId, logger) {
  if (!isSubscribed(userId)) return { ok: false, error: 'not subscribed' };
  const delivered = await sendToUser(
    userId,
    { title: 'shelf.it', body: 'Push notifications are working 🎬', url: '/' },
    logger
  );
  return { ok: delivered > 0, delivered };
}

// --- Daily new-episode check ----------------------------------------------
// One pass for the whole household: the checkpoint is shared, each member with
// a subscribed device hears about their own series.
export async function checkNewEpisodes(logger) {
  const nowIso = new Date().toISOString();
  const lastCheck = getSetting(K_LAST);
  // First run: set the baseline so we never notify for the whole back-catalog.
  if (!lastCheck) {
    setSetting(K_LAST, nowIso);
    return;
  }

  const lastDate = lastCheck.slice(0, 10); // YYYY-MM-DD, lexical comparison
  const todayDate = nowIso.slice(0, 10);

  // Advance the checkpoint regardless, so a transient send failure doesn't cause
  // the same episode to re-notify every day.
  setSetting(K_LAST, nowIso);

  for (const { user_id: userId } of usersWithSubsStmt.all()) {
    await notifyUser(userId, lastDate, todayDate, logger);
  }
}

async function notifyUser(userId, lastDate, todayDate, logger) {
  const shows = activeShowsStmt.all(userId);

  const newlyAired = [];
  for (const show of shows) {
    const meta = readMetaSync('show', show.tmdb_id);
    if (!meta) continue;
    let found = false;
    for (const s of meta.seasons || []) {
      if (s.season_number < 1) continue;
      const sMeta = readSeasonMetaSync(show.tmdb_id, s.season_number);
      if (!sMeta) continue;
      for (const ep of sMeta.episodes) {
        if (ep.air_date && ep.air_date > lastDate && ep.air_date <= todayDate) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (found) newlyAired.push(show);
  }

  if (newlyAired.length === 1) {
    // Single series → point straight at it.
    const show = newlyAired[0];
    const title = show.title_it || show.title_orig;
    await sendToUser(
      userId,
      {
        title: 'Fresh episode alert 🍿',
        body: `${title} just dropped a new episode. Snacks ready?`,
        url: `/detail/${show.id}`,
      },
      logger
    );
  } else if (newlyAired.length > 1) {
    // Several at once → one digest notification listing the titles.
    const names = newlyAired.map((s) => s.title_it || s.title_orig);
    let list;
    if (names.length <= 3) {
      list = names.length === 2
        ? `${names[0]} & ${names[1]}`
        : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
    } else {
      list = `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
    }
    await sendToUser(
      userId,
      {
        title: `${newlyAired.length} shows just leveled up 📺`,
        body: `New episodes from ${list}. Your couch misses you. 🛋️`,
        url: '/upcoming',
      },
      logger
    );
  }
  if (newlyAired.length && logger) {
    logger.info(`push: notified user ${userId} about ${newlyAired.length} series with new episodes`);
  }
}

// --- Scheduler (once per day, ~09:00 server time) --------------------------
export function startPushScheduler(logger) {
  const CHECK_HOUR = 9;
  let lastRunDay = null;
  const tick = async () => {
    try {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      if (now.getHours() >= CHECK_HOUR && lastRunDay !== day) {
        lastRunDay = day;
        await checkNewEpisodes(logger);
      }
    } catch (err) {
      if (logger) logger.warn(`push scheduler tick failed: ${err.message}`);
    }
  };
  const timer = setInterval(tick, 60 * 60 * 1000); // hourly
  if (timer.unref) timer.unref();
  tick();
}
