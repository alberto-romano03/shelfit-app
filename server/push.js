// Web Push notifications for newly aired episodes — implemented with Node's
// built-in crypto only (no web-push dependency). Covers:
//   • VAPID (RFC 8292): a P-256 keypair generated once and stored in settings,
//     plus per-request ES256 JWT signing.
//   • Message encryption (RFC 8291 / RFC 8188 "aes128gcm"): ECDH + HKDF + AES-GCM.
//   • A once-per-day check that notifies for episodes whose air_date fell between
//     the last check and now, reusing the locally-cached TMDB air dates.
//
// Exactly one push subscription is kept (in the settings table), owned by the
// member who enabled it: the daily check covers that member's series only. A
// failed delivery with 404/410 (subscription gone) auto-disables notifications.

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
const delSettingStmt = db.prepare('DELETE FROM settings WHERE key = ?');
function getSetting(key) {
  const row = getSettingStmt.get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  setSettingStmt.run(key, value);
}
function delSetting(key) {
  delSettingStmt.run(key);
}

// Started/finished shows whose new episodes we notify about (prepared once).
const activeShowsStmt = db.prepare(
  "SELECT id, tmdb_id, title_it, title_orig FROM items WHERE user_id = ? AND type = 'show' AND status IN ('watching','completed','paused')"
);
const masterIdStmt = db.prepare("SELECT id FROM users WHERE role = 'master'");

const K_VAPID = 'push_vapid';
const K_SUB = 'push_subscription';
const K_ENABLED = 'push_enabled';
const K_LAST = 'push_last_check';
const K_OWNER = 'push_user';

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:shelfit@example.com';

// --- state accessors -------------------------------------------------------
export function isPushEnabled() {
  return getSetting(K_ENABLED) === '1';
}
export function setPushEnabled(on) {
  setSetting(K_ENABLED, on ? '1' : '0');
}
export function getSubscription() {
  const raw = getSetting(K_SUB);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
export function setSubscription(sub, userId) {
  setSetting(K_SUB, JSON.stringify(sub));
  setSetting(K_OWNER, String(userId));
}
// Who the subscription belongs to. A subscription stored before accounts
// existed belongs to the master.
export function getPushOwner() {
  const id = parseInt(getSetting(K_OWNER), 10);
  if (Number.isInteger(id)) return id;
  const master = masterIdStmt.get();
  return master ? master.id : null;
}
export function clearSubscription() {
  delSetting(K_SUB);
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

// A dead subscription (404/410 Gone) → drop it and disable notifications.
function handleDelivery(status, logger) {
  if (status === 404 || status === 410) {
    clearSubscription();
    setPushEnabled(false);
    if (logger) logger.warn('push subscription gone — notifications disabled');
    return false;
  }
  return true;
}

// Send a one-off test notification (used by the Settings "test" action).
export async function sendTest(logger) {
  const sub = getSubscription();
  if (!sub || !isPushEnabled()) return { ok: false, error: 'not subscribed' };
  const status = await sendPush(
    sub,
    { title: 'shelf.it', body: 'Push notifications are working 🎬', url: '/' },
    logger
  );
  const alive = handleDelivery(status, logger);
  return { ok: status >= 200 && status < 300, status, alive };
}

// --- Daily new-episode check ----------------------------------------------
export async function checkNewEpisodes(logger) {
  if (!isPushEnabled()) return;
  const sub = getSubscription();
  if (!sub) return;

  const nowIso = new Date().toISOString();
  const lastCheck = getSetting(K_LAST);
  // First run: set the baseline so we never notify for the whole back-catalog.
  if (!lastCheck) {
    setSetting(K_LAST, nowIso);
    return;
  }

  const lastDate = lastCheck.slice(0, 10); // YYYY-MM-DD, lexical comparison
  const todayDate = nowIso.slice(0, 10);

  const shows = activeShowsStmt.all(getPushOwner());

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

  // Advance the checkpoint regardless, so a transient send failure doesn't cause
  // the same episode to re-notify every day.
  setSetting(K_LAST, nowIso);

  if (newlyAired.length === 1) {
    // Single series → point straight at it.
    const show = newlyAired[0];
    const title = show.title_it || show.title_orig;
    const status = await sendPush(
      sub,
      {
        title: 'Fresh episode alert 🍿',
        body: `${title} just dropped a new episode. Snacks ready?`,
        url: `/detail/${show.id}`,
      },
      logger
    );
    handleDelivery(status, logger);
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
    const status = await sendPush(
      sub,
      {
        title: `${newlyAired.length} shows just leveled up 📺`,
        body: `New episodes from ${list}. Your couch misses you. 🛋️`,
        url: '/upcoming',
      },
      logger
    );
    handleDelivery(status, logger);
  }
  if (newlyAired.length && logger) {
    logger.info(`push: notified ${newlyAired.length} series with new episodes`);
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
