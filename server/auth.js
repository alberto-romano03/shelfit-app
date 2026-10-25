// Household authentication for shelfIt.
//
// Every member has an account in the `users` table with their own password; one
// of them is the master, created on first boot from APP_PASSWORD in .env (hashed
// with scrypt, the plaintext is never persisted and .env is ignored afterwards).
// The login page is a profile picker: choose your tile, type your password.
//
// Sessions are random tokens carried in an HttpOnly cookie and stored in the
// `sessions` table as a SHA-256 hash, so they survive a restart and a copy of the
// database can't be replayed as a login. The gate attaches the signed-in account
// to every request as `request.user` ({ id, role }). No external dependencies:
// Node's crypto only.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import db from './db.js';
import { PUBLIC_URL } from './config.js';
import {
  createMagicLink,
  listMagicLinks,
  redeemToken,
  recordUse,
  revokeMagicLink,
  expiryMsFor,
} from './magicLinks.js';
import { clientIp } from './security.js';
import { logAccess, getRecentAccess, EVENTS } from './accessLog.js';
import { getUser, getMaster, pickerUsers, isPickable, avatarFile, fileVersion } from './users.js';
import { findInvite, clearInvites, pruneInvites } from './invites.js';

// The app is served under this sub-path by the reverse proxy (see Caddyfile),
// which STRIPS the prefix before forwarding, so incoming request paths are at
// root and the auth gate matches them unchanged. Only URLs we hand back to the
// BROWSER (the login redirect, the login page's own asset/API refs, the session
// cookie scope) must carry the prefix. Keep in sync with Caddy / client BASE.
const BASE = '/shelfit';

// --- scrypt parameters -----------------------------------------------------
// LEGACY_SCRYPT verifies hashes written by older builds (stored as `salt:hash`).
// New/reset passwords use SCRYPT (raised toward current OWASP guidance) and
// embed their own parameters in the stored value (`s2:N:r:p:salt:hash`), so the
// work factor can be tuned later without ever locking out an existing hash. A
// legacy hash is rewritten in the new format the next time its owner signs in.
const LEGACY_SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEYLEN = 64;
const SALT_BYTES = 32;

// Password length a member may choose (the master's comes from APP_PASSWORD).
export const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

const COOKIE = 'shelfit_session';
const YEAR_SECONDS = 365 * 24 * 60 * 60;
const YEAR_MS = YEAR_SECONDS * 1000;
const TOKEN_RE = /^[a-f0-9]{64}$/;

// --- Prepared statements (compiled once at module load, reused thereafter) ---
const setPasswordStmt = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
const setLastLoginStmt = db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?');
const bumpGenerationStmt = db.prepare(
  'UPDATE users SET session_generation = session_generation + 1 WHERE id = ?'
);
const insertSessionStmt = db.prepare(
  `INSERT INTO sessions (token_hash, user_id, generation, created_at, last_seen_at, label)
   SELECT ?, id, session_generation, ?, ?, ? FROM users WHERE id = ?`
);
const getSessionStmt = db.prepare(
  `SELECT s.user_id, s.generation, s.last_seen_at, u.role, u.session_generation, u.disabled
     FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`
);
const touchSessionStmt = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?');
const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
const deleteUserSessionsStmt = db.prepare('DELETE FROM sessions WHERE user_id = ?');
const pruneSessionsStmt = db.prepare('DELETE FROM sessions WHERE last_seen_at < ?');
// A member's live sessions, for Settings > Devices. rowid is the public handle;
// the token hash never leaves the server.
const listSessionsStmt = db.prepare(
  `SELECT s.rowid AS id, s.token_hash, s.label, s.created_at, s.last_seen_at
     FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.user_id = ? AND s.generation = u.session_generation
    ORDER BY s.last_seen_at DESC`
);
const getSessionByIdStmt = db.prepare('SELECT token_hash FROM sessions WHERE rowid = ? AND user_id = ?');
const deleteSessionByIdStmt = db.prepare('DELETE FROM sessions WHERE rowid = ? AND user_id = ?');
const countPasswordUsersStmt = db.prepare(
  'SELECT COUNT(*) AS c FROM users WHERE disabled = 0 AND password_hash IS NOT NULL'
);
const onlyPasswordUserStmt = db.prepare(
  'SELECT * FROM users WHERE disabled = 0 AND password_hash IS NOT NULL LIMIT 1'
);

// --- password hashing ------------------------------------------------------
function scrypt(password, salt, params) {
  return crypto.scryptSync(password, salt, KEYLEN, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  });
}

// A new stored value for `password` in the current self-describing format.
export function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = scrypt(password, salt, SCRYPT);
  return `s2:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

// Constant-time verification of a submitted password against a stored hash in
// either the `s2:N:r:p:salt:hash` format (params read from the value) or the
// legacy `salt:hash` format (verified with the original work factor).
function verifyPassword(stored, password) {
  if (!stored || typeof password !== 'string') return false;
  let salt;
  let expected;
  let params;
  if (stored.startsWith('s2:')) {
    const parts = stored.split(':');
    if (parts.length !== 6) return false;
    const [, N, r, p, saltHex, hashHex] = parts;
    params = { N: parseInt(N, 10), r: parseInt(r, 10), p: parseInt(p, 10), maxmem: SCRYPT.maxmem };
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } else {
    const sep = stored.indexOf(':');
    if (sep < 0) return false;
    salt = Buffer.from(stored.slice(0, sep), 'hex');
    expected = Buffer.from(stored.slice(sep + 1), 'hex');
    params = LEGACY_SCRYPT;
  }
  let actual;
  try {
    actual = scrypt(password, salt, params);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// True when a stored hash should be rewritten with the current parameters.
function needsRehash(stored) {
  if (!stored || !stored.startsWith('s2:')) return true;
  const [, N, r, p] = stored.split(':');
  return parseInt(N, 10) !== SCRYPT.N || parseInt(r, 10) !== SCRYPT.r || parseInt(p, 10) !== SCRYPT.p;
}

// Boot-time master password init / reset. Returns { configured }: when false,
// auth is left DISABLED so the operator isn't locked out until they set
// APP_PASSWORD. Resetting also signs the master out of every device.
export function initAuthPassword(logger) {
  const master = getMaster();
  if (!master) throw new Error('AUTH: no master account in the database');
  const existing = master.password_hash;
  const resetFlag = String(process.env.APP_PASSWORD_RESET || '').toLowerCase() === 'true';
  const pw = process.env.APP_PASSWORD || '';

  // Already initialized and not resetting: the database is the source of truth.
  if (existing && !resetFlag) return { configured: true };

  if (!pw) {
    if (existing) {
      logger.warn('AUTH: APP_PASSWORD_RESET set but APP_PASSWORD is empty, keeping the existing password.');
      return { configured: true };
    }
    logger.warn(
      'AUTH DISABLED: no password is configured. Set APP_PASSWORD in .env and restart to require login.'
    );
    return { configured: false };
  }

  setPasswordStmt.run(hashPassword(pw), master.id);
  if (existing) revokeAllSessions(master.id);
  logger.info(
    existing
      ? 'AUTH: master password reset from APP_PASSWORD and its sessions signed out. You can now remove APP_PASSWORD/APP_PASSWORD_RESET from .env.'
      : 'AUTH: master password initialized from APP_PASSWORD and hashed into the database. You can now remove APP_PASSWORD from .env.'
  );
  return { configured: true };
}

// --- sessions --------------------------------------------------------------
// A session is valid while its row exists, its generation matches the user's
// current session_generation and the user isn't disabled. Bumping the generation
// (sign out all devices, password reset) invalidates every session of that user
// at once; the rows are deleted too so they don't linger.
//
// last_seen_at is refreshed at most every few minutes (not on every request), and
// sessions idle for longer than the cookie lifetime are pruned daily.
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Coarse "Browser on OS" description for the sessions list, never the raw
// user-agent string.
function deviceLabel(ua) {
  const s = String(ua || '');
  const os = /iPad/.test(s)
    ? 'iPad'
    : /iPhone|iPod/.test(s)
      ? 'iPhone'
      : /Android/.test(s)
        ? 'Android'
        : /Windows/.test(s)
          ? 'Windows'
          : /Macintosh|Mac OS X/.test(s)
            ? 'Mac'
            : /Linux/.test(s)
              ? 'Linux'
              : '';
  const browser = /Edg\//.test(s)
    ? 'Edge'
    : /Firefox\//.test(s)
      ? 'Firefox'
      : /Chrome\//.test(s)
        ? 'Chrome'
        : /Safari\//.test(s)
          ? 'Safari'
          : '';
  return [browser, os].filter(Boolean).join(' on ') || null;
}

function createSession(userId, request) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  insertSessionStmt.run(hashToken(token), now, now, deviceLabel(request.headers['user-agent']), userId);
  return token;
}

function sessionTokenFrom(request) {
  const value = parseCookies(request.headers.cookie)[COOKIE];
  return value && TOKEN_RE.test(value) ? value : null;
}

// The account behind the request's session cookie ({ id, role }), or null.
function sessionUser(request) {
  const token = sessionTokenFrom(request);
  if (!token) return null;
  const hash = hashToken(token);
  const row = getSessionStmt.get(hash);
  if (!row || row.disabled || row.generation !== row.session_generation) return null;
  const now = Date.now();
  if (now - row.last_seen_at > TOUCH_INTERVAL_MS) touchSessionStmt.run(now, hash);
  return { id: row.user_id, role: row.role };
}

function destroySession(request) {
  const token = sessionTokenFrom(request);
  if (token) deleteSessionStmt.run(hashToken(token));
}

// Sign `userId` out everywhere: no existing token can match again.
export function revokeAllSessions(userId) {
  db.transaction(() => {
    bumpGenerationStmt.run(userId);
    deleteUserSessionsStmt.run(userId);
  })();
}

// Prune idle sessions and expired invites now (boot) and once daily. The
// interval is unref'd so it never keeps the process alive on its own.
export function startSessionCleanup(logger) {
  const sweep = () => {
    try {
      const n = pruneSessionsStmt.run(Date.now() - YEAR_MS).changes;
      if (n && logger) logger.info(`sessions: pruned ${n} idle session(s)`);
      const i = pruneInvites();
      if (i && logger) logger.info(`invites: pruned ${i} expired invite(s)`);
    } catch (err) {
      if (logger) logger.warn(`session cleanup failed: ${err.message}`);
    }
  };
  sweep();
  const timer = setInterval(sweep, 24 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

// --- cookies ---------------------------------------------------------------
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    try {
      out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      /* malformed escape: ignore that cookie */
    }
  }
  return out;
}
// Behind Caddy the app sees HTTP; the Secure flag must follow the *external*
// scheme, which Caddy reports via X-Forwarded-Proto.
function isHttps(request) {
  return (request.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function buildSessionCookie(value, { maxAge, secure }) {
  // Scope the cookie to the app's sub-path so it isn't sent to sibling apps
  // hosted under other prefixes on the same hostname.
  //
  // SameSite=Lax (not Strict): a magic link is typically opened by tapping it
  // from another app (a message, email, notes), which is a cross-site-initiated
  // top-level navigation. Under Strict the browser withholds the freshly-set
  // session cookie on the redirect into the app, so the user lands unauthenticated
  // (this broke magic-link auto-login on Android/Chrome). Lax still sends it on
  // top-level GET navigations while withholding it from cross-site POST/fetch, so
  // state-changing requests stay CSRF-safe.
  const parts = [`${COOKIE}=${value}`, `Path=${BASE}/`, 'HttpOnly', 'SameSite=Lax'];
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
function setSessionCookie(reply, request, token) {
  reply.header('Set-Cookie', buildSessionCookie(token, { maxAge: YEAR_SECONDS, secure: isHttps(request) }));
}
function clearSessionCookie(reply, request) {
  reply.header('Set-Cookie', buildSessionCookie('', { maxAge: 0, secure: isHttps(request) }));
}

// --- rate limiting (per IP, 5 failures / 15 min, in-memory) ----------------
const RL_MAX = 5;
const RL_WINDOW = 15 * 60 * 1000;
const attempts = new Map(); // ip -> { count, resetAt }

function isRateLimited(ip) {
  const e = attempts.get(ip);
  return !!e && Date.now() < e.resetAt && e.count >= RL_MAX;
}
function recordFailure(ip) {
  const now = Date.now();
  let e = attempts.get(ip);
  if (!e || now >= e.resetAt) {
    e = { count: 0, resetAt: now + RL_WINDOW };
    attempts.set(ip, e);
  }
  e.count += 1;
}
function clearFailures(ip) {
  attempts.delete(ip);
}

// Per-account limit (10 failures / 15 min), independent of the source IP, so
// one member's password can't be guessed from many addresses. Like the per-IP
// limit it only counts failures, so a correct password is never slowed.
const USER_RL_MAX = 10;
const userAttempts = new Map(); // user id -> { count, resetAt }
function isUserLocked(userId) {
  const e = userAttempts.get(userId);
  return !!e && Date.now() < e.resetAt && e.count >= USER_RL_MAX;
}
function recordUserFailure(userId) {
  const now = Date.now();
  let e = userAttempts.get(userId);
  if (!e || now >= e.resetAt) {
    e = { count: 0, resetAt: now + RL_WINDOW };
    userAttempts.set(userId, e);
  }
  e.count += 1;
}

// Global, IP-independent throttle. The per-IP limiter above can be sidestepped
// by rotating X-Forwarded-For (LAN/direct mode) or by using many source IPs
// (distributed guessing). This adds a small, escalating delay to every FAILED
// attempt across all IPs, so aggregate guessing rate is capped regardless of
// source. The delay is bounded (never a hard lock) and only ever applies to a
// wrong password, so a member's correct login is always instant.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GLOBAL_WINDOW = 15 * 60 * 1000;
const GLOBAL_DELAY_STEP_MS = 150; // added latency per recent global failure
const GLOBAL_MAX_DELAY_MS = 3000; // cap so a real user is never locked out
let globalFails = 0;
let globalResetAt = 0;
function recordGlobalFailure() {
  const now = Date.now();
  if (now >= globalResetAt) {
    globalFails = 0;
    globalResetAt = now + GLOBAL_WINDOW;
  }
  globalFails += 1;
}
function globalDelayMs() {
  if (Date.now() >= globalResetAt) return 0;
  return Math.min(GLOBAL_MAX_DELAY_MS, globalFails * GLOBAL_DELAY_STEP_MS);
}
function clearGlobalFailures() {
  globalFails = 0;
}

// Periodically drop expired windows so the maps can't grow without bound.
const attemptsSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of attempts) if (now >= e.resetAt) attempts.delete(ip);
  for (const [id, e] of userAttempts) if (now >= e.resetAt) userAttempts.delete(id);
}, RL_WINDOW);
if (attemptsSweep.unref) attemptsSweep.unref();

// --- magic-link rate limiting (per IP, 10 FAILED redeems / 15 min) ---------
// Only failed redeems count, so a genuine owner clicking their valid link is
// never throttled, while token guessing (every guess fails) is capped hard.
const MAGIC_RL_MAX = 10;
const MAGIC_RL_WINDOW = 15 * 60 * 1000;
const magicAttempts = new Map(); // ip -> { count, resetAt }
function isMagicRateLimited(ip) {
  const e = magicAttempts.get(ip);
  return !!e && Date.now() < e.resetAt && e.count >= MAGIC_RL_MAX;
}
function recordMagicFailure(ip) {
  const now = Date.now();
  let e = magicAttempts.get(ip);
  if (!e || now >= e.resetAt) {
    e = { count: 0, resetAt: now + MAGIC_RL_WINDOW };
    magicAttempts.set(ip, e);
  }
  e.count += 1;
}
function clearMagicFailures(ip) {
  magicAttempts.delete(ip);
}
const magicSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of magicAttempts) if (now >= e.resetAt) magicAttempts.delete(ip);
}, MAGIC_RL_WINDOW);
if (magicSweep.unref) magicSweep.unref();

// --- login page (standalone, self-contained) -------------------------------
// The profiles a visitor can choose from, rendered into the page so the picker
// paints at once with no extra request. Names only, plus an avatar URL served by
// the public avatar route below; never anything from a library.
function pickerProfiles() {
  return pickerUsers().map((u) => {
    const f = avatarFile(u);
    return {
      id: u.id,
      name: u.display_name,
      avatar: f ? `/api/auth/profiles/${u.id}/avatar?v=${fileVersion(f)}` : null,
    };
  });
}

// JSON safe to place inside a <script> element.
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// The logo is the same file as the favicon, linked rather than inlined: /icons/*
// is public (see isPublic), so it loads without a session, and as a separate URL
// it is downloaded once and browser-cached (Caddy sends a week's max-age) instead
// of riding along, base64-inflated, in every no-store copy of this page.
//
// `invite` is null, { name } for a valid invite (the page opens on "choose your
// password"), or { invalid: true } (the picker shows a notice instead).
function loginPageHtml(profiles, invite = null) {
  const logoTag = `<img class="logo" src="${BASE}/icons/shelf-iticon-browser.png" alt="" width="56" height="56">`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0a0a0a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="shelfit">
<link rel="apple-touch-icon" sizes="180x180" href="${BASE}/icons/apple-touch-icon.png">
<link rel="icon" type="image/png" href="${BASE}/icons/shelf-iticon-browser.png">
<link rel="manifest" href="${BASE}/manifest.json">
<title data-it="Accedi · shelfit" data-en="Sign in · shelfit">Sign in · shelfit</title>
<script>
  // Theme, before first paint: the app's stored choice (theme.js, 'shelfit-theme').
  // 'system' or nothing leaves the attribute off and the media query decides.
  (function(){
    var root=document.documentElement,t=null;
    try{t=localStorage.getItem('shelfit-theme');}catch(e){}
    if(t==='light'||t==='dark')root.setAttribute('data-theme',t);
    var light=t==='light'||(t!=='dark'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches);
    var meta=document.querySelector('meta[name="theme-color"]');
    if(meta)meta.setAttribute('content',light?'#f5f5f5':'#0a0a0a');
  })();
</script>
<style>
  :root{
    --bg:#0a0a0a;--surface:#1a1a1a;--surface-elevated:#2a2a2a;
    --text-primary:#fff;--text-secondary:#999;--accent:#e5a00d;
    --danger:#e5484d;--border:rgba(255,255,255,.08);--shadow:rgba(0,0,0,.5);
    /* Same shape and motion tokens as client/src/styles.css. */
    --r-md:12px;--r-lg:16px;--r-pill:999px;
    --dur-short:180ms;--ease-state:ease;
  }
  :root[data-theme=light]{
    --bg:#f5f5f5;--surface:#fff;--surface-elevated:#eee;
    --text-primary:#111;--text-secondary:#666;--accent:#c8890a;
    --danger:#d33;--border:rgba(0,0,0,.1);--shadow:rgba(0,0,0,.15);
  }
  @media (prefers-color-scheme: light){
    :root:not([data-theme=dark]){
      --bg:#f5f5f5;--surface:#fff;--surface-elevated:#eee;
      --text-primary:#111;--text-secondary:#666;--accent:#c8890a;
      --danger:#d33;--border:rgba(0,0,0,.1);--shadow:rgba(0,0,0,.15);
    }
  }
  *{box-sizing:border-box}
  html,body{margin:0;min-height:100%}
  body{
    background:var(--bg);color:var(--text-primary);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    min-height:100vh;min-height:100dvh;
    display:flex;align-items:center;justify-content:center;padding:24px 16px;
  }
  .card{width:100%;max-width:560px;text-align:center}
  .logo{border-radius:var(--r-md);margin-bottom:10px}
  h1{font-size:22px;margin:0 0 28px;letter-spacing:-.5px}
  h1 span{color:var(--accent)}
  h2{font-size:20px;font-weight:600;margin:0 0 24px}
  .view[hidden]{display:none}
  /* Profile tiles: the app's avatar (84px circle on surface-elevated, initial in
     the accent colour), with the name underneath. */
  .profiles{display:flex;flex-wrap:wrap;justify-content:center;gap:24px 20px;margin:0;padding:0;list-style:none}
  .profile{
    display:flex;flex-direction:column;align-items:center;gap:10px;width:100px;padding:0;
    background:none;border:none;color:var(--text-secondary);font:inherit;font-size:14px;cursor:pointer;
    transition:color var(--dur-short) var(--ease-state);
  }
  .profile .name{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .profile:hover,.profile:focus-visible{color:var(--text-primary);outline:none}
  .avatar{
    width:84px;height:84px;border-radius:50%;overflow:hidden;flex-shrink:0;
    display:flex;align-items:center;justify-content:center;
    background:var(--surface-elevated);color:var(--accent);font-size:34px;font-weight:700;
    box-shadow:0 0 0 0 transparent;
    transition:box-shadow var(--dur-short) var(--ease-state),transform var(--dur-short) var(--ease-state);
  }
  .avatar img{width:100%;height:100%;object-fit:cover;display:block}
  .profile:hover .avatar,.profile:focus-visible .avatar{box-shadow:0 0 0 3px var(--accent)}
  .profile:active .avatar{transform:scale(.96)}
  .who{display:flex;flex-direction:column;align-items:center;gap:10px;margin-bottom:6px}
  .who .avatar{width:96px;height:96px;font-size:38px}
  .who .name{font-size:20px;font-weight:700;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sub{color:var(--text-secondary);font-size:14px;margin:0 0 20px}
  form{display:flex;flex-direction:column;gap:12px;max-width:320px;margin:0 auto}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0}
  /* The app's text field: 12px radius, focus as a border swap + outside ring so
     nothing shifts. */
  input[type=password]{
    width:100%;padding:13px 14px;font:inherit;font-size:16px;border-radius:var(--r-md);
    border:1px solid var(--border);background:var(--surface);color:var(--text-primary);
    transition:border-color var(--dur-short) var(--ease-state),box-shadow var(--dur-short) var(--ease-state);
  }
  input[type=password]:focus{
    outline:none;border-color:var(--accent);
    box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent);
  }
  /* The app's primary .btn: a pill with the verb's glyph left of the label. */
  .primary{
    display:inline-flex;align-items:center;justify-content:center;gap:8px;
    width:100%;min-height:48px;padding:13px;font:inherit;font-size:16px;font-weight:600;
    border:none;border-radius:var(--r-pill);background:var(--accent);color:#000;cursor:pointer;
    transition:opacity var(--dur-short) var(--ease-state),transform var(--dur-short) var(--ease-state);
  }
  .primary svg{width:18px;height:18px;flex-shrink:0}
  .primary:active:not(:disabled){transform:scale(.97)}
  .primary:disabled{opacity:.4;cursor:default}
  .primary:focus-visible,.link:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  .link{
    align-self:center;min-height:44px;padding:10px 16px;border:none;border-radius:var(--r-pill);
    background:none;color:var(--text-secondary);font:inherit;font-size:14px;cursor:pointer;
    transition:color var(--dur-short) var(--ease-state);
  }
  .link:hover{color:var(--text-primary)}
  .link[hidden]{display:none}
  .error{color:var(--danger);font-size:14px;min-height:18px;margin-top:4px}
  .notice{color:var(--danger);font-size:14px;margin:-8px 0 20px}
  .notice[hidden]{display:none}
</style>
</head>
<body>
  <main class="card">
    ${logoTag}
    <h1>shelf<span>it</span></h1>

    <section class="view" id="picker" hidden>
      <h2 data-it="Chi sta guardando?" data-en="Who's watching?">Who's watching?</h2>
      <p class="notice" id="notice" role="alert" hidden
        data-it="Questo invito non è più valido. Chiedine uno nuovo."
        data-en="This invite is no longer valid. Ask for a new one.">This invite is no longer valid. Ask for a new one.</p>
      <ul class="profiles" id="profiles"></ul>
    </section>

    <section class="view" id="signin" hidden>
      <div class="who" id="who"></div>
      <p class="sub" data-it="Inserisci la password per continuare" data-en="Enter your password to continue">Enter your password to continue</p>
      <form id="f" autocomplete="on">
        <input id="uname" class="sr-only" type="text" name="username" autocomplete="username" tabindex="-1" aria-hidden="true" readonly>
        <input id="pw" type="password" name="password" placeholder="Password" autocomplete="current-password" aria-label="Password">
        <button id="btn" class="primary" type="submit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7"/></svg><span data-it="Entra" data-en="Come inside">Come inside</span></button>
        <div class="error" id="err" role="alert"
          data-it-magic="Questo link di accesso non è più valido. Inserisci la password."
          data-en-magic="That sign-in link is no longer valid. Enter your password."
          data-it-limit="Troppi tentativi. Riprova più tardi."
          data-en-limit="Too many attempts. Try again later."
          data-it-wrong="Password errata"
          data-en-wrong="Wrong password"
          data-it-network="Errore di rete. Riprova."
          data-en-network="Network error. Try again."></div>
        <button id="back" class="link" type="button" data-it="Non sei tu?" data-en="Not you?" hidden>Not you?</button>
      </form>
    </section>

    <section class="view" id="invite" hidden>
      <div class="who" id="iwho"></div>
      <h2 data-it="Scegli la tua password" data-en="Choose your password">Choose your password</h2>
      <p class="sub" data-it="La conoscerai solo tu: è quella con cui entrerai in shelfit." data-en="Only you will know it: it's how you'll sign in to shelfit.">Only you will know it: it's how you'll sign in to shelfit.</p>
      <form id="fi" autocomplete="on">
        <input id="iuname" class="sr-only" type="text" name="username" autocomplete="username" tabindex="-1" aria-hidden="true" readonly>
        <input id="ipw" type="password" name="new-password" autocomplete="new-password"
          data-it-placeholder="Nuova password (almeno 8 caratteri)" data-en-placeholder="New password (at least 8 characters)"
          placeholder="New password (at least 8 characters)">
        <input id="ipw2" type="password" autocomplete="new-password"
          data-it-placeholder="Ripeti la password" data-en-placeholder="Repeat the password"
          placeholder="Repeat the password">
        <button id="ibtn" class="primary" type="submit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg><span data-it="Salva ed entra" data-en="Save and come inside">Save and come inside</span></button>
        <div class="error" id="ierr" role="alert"
          data-it-short="La password deve avere almeno 8 caratteri."
          data-en-short="The password needs at least 8 characters."
          data-it-mismatch="Le due password non coincidono."
          data-en-mismatch="The two passwords don't match."
          data-it-invalid="Questo invito non è più valido. Chiedine uno nuovo."
          data-en-invalid="This invite is no longer valid. Ask for a new one."
          data-it-limit="Troppi tentativi. Riprova più tardi."
          data-en-limit="Too many attempts. Try again later."
          data-it-network="Errore di rete. Riprova."
          data-en-network="Network error. Try again."></div>
      </form>
    </section>
  </main>
<script>
  (function(){
    var BASE='${BASE}';
    var PROFILES=${scriptJson(profiles)};
    var INVITE=${scriptJson(invite)};
    // Language: the app's stored choice, else the browser's. Both languages ship
    // in data attributes; fill every translatable node from its own.
    var lang='en';
    try{lang=localStorage.getItem('shelfit:lang');}catch(e){}
    if(lang!=='it'&&lang!=='en')lang=(navigator.language||'').slice(0,2).toLowerCase()==='it'?'it':'en';
    document.documentElement.setAttribute('lang',lang);
    var nodes=document.querySelectorAll('[data-'+lang+']');
    for(var i=0;i<nodes.length;i++)nodes[i].textContent=nodes[i].getAttribute('data-'+lang);
    var phs=document.querySelectorAll('[data-'+lang+'-placeholder]');
    for(var k=0;k<phs.length;k++)phs[k].setAttribute('placeholder',phs[k].getAttribute('data-'+lang+'-placeholder'));

    var picker=document.getElementById('picker'),signin=document.getElementById('signin'),
        list=document.getElementById('profiles'),who=document.getElementById('who'),
        f=document.getElementById('f'),pw=document.getElementById('pw'),uname=document.getElementById('uname'),
        btn=document.getElementById('btn'),back=document.getElementById('back'),err=document.getElementById('err');
    var selected=null;
    function msg(key){return err.getAttribute('data-'+lang+'-'+key)||'';}

    // An avatar circle: the chosen image, else the name's first letter. Names are
    // only ever set as text, never as HTML.
    function avatar(p){
      var el=document.createElement('span');
      el.className='avatar';
      el.setAttribute('aria-hidden','true');
      function initial(){el.textContent=(Array.from(p.name||'?')[0]||'?').toUpperCase();}
      if(p.avatar){
        var img=document.createElement('img');
        img.alt='';img.decoding='async';
        img.onerror=function(){img.remove();initial();};
        img.src=BASE+p.avatar;
        el.appendChild(img);
      }else initial();
      return el;
    }
    function nameEl(p){
      var n=document.createElement('span');
      n.className='name';n.textContent=p.name;
      return n;
    }

    function showPicker(){
      selected=null;err.textContent='';
      signin.hidden=true;picker.hidden=false;
      var first=list.querySelector('button');
      if(first)first.focus();
    }
    function choose(p){
      selected=p;err.textContent='';pw.value='';
      who.textContent='';who.appendChild(avatar(p));who.appendChild(nameEl(p));
      uname.value=p.name; // lets password managers keep one entry per member
      back.hidden=PROFILES.length<2;
      picker.hidden=true;signin.hidden=false;
      pw.focus();
    }

    PROFILES.forEach(function(p){
      var li=document.createElement('li');
      var b=document.createElement('button');
      b.type='button';b.className='profile';
      b.appendChild(avatar(p));b.appendChild(nameEl(p));
      b.addEventListener('click',function(){choose(p);});
      li.appendChild(b);list.appendChild(li);
    });
    back.addEventListener('click',showPicker);
    document.addEventListener('keydown',function(ev){
      if(ev.key==='Escape'&&!signin.hidden&&PROFILES.length>1)showPicker();
    });

    // An invite link: read the token, then drop it from the address bar so it
    // doesn't linger in history. A valid one opens "choose your password".
    var inviteToken=null;
    if(INVITE){
      try{
        inviteToken=new URLSearchParams(window.location.search).get('invite');
        history.replaceState(null,'',BASE+'/login');
      }catch(e){}
    }
    if(INVITE&&!INVITE.invalid&&inviteToken){
      var inviteView=document.getElementById('invite'),fi=document.getElementById('fi'),
          ipw=document.getElementById('ipw'),ipw2=document.getElementById('ipw2'),
          ibtn=document.getElementById('ibtn'),ierr=document.getElementById('ierr');
      var imsg=function(key){return ierr.getAttribute('data-'+lang+'-'+key)||'';};
      var iwho=document.getElementById('iwho');
      iwho.appendChild(avatar({name:INVITE.name}));iwho.appendChild(nameEl({name:INVITE.name}));
      document.getElementById('iuname').value=INVITE.name;
      inviteView.hidden=false;
      ipw.focus();
      fi.addEventListener('submit',function(ev){
        ev.preventDefault();
        ierr.textContent='';
        if(ipw.value.length<8){ierr.textContent=imsg('short');ipw.focus();return;}
        if(ipw.value!==ipw2.value){ierr.textContent=imsg('mismatch');ipw2.focus();ipw2.select();return;}
        ibtn.disabled=true;
        fetch(BASE+'/api/auth/invite',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({token:inviteToken,password:ipw.value})
        }).then(function(r){
          if(r.ok){window.location.replace(BASE+'/');return;}
          ibtn.disabled=false;
          ierr.textContent = r.status===410 ? imsg('invalid') : r.status===429 ? imsg('limit') : imsg('short');
        }).catch(function(){
          ibtn.disabled=false;ierr.textContent=imsg('network');
        });
      });
      return; // the picker stays hidden while choosing a password
    }
    if(INVITE&&INVITE.invalid)document.getElementById('notice').hidden=false;

    if(PROFILES.length===1&&!(INVITE&&INVITE.invalid))choose(PROFILES[0]);else showPicker();

    // Generic message when arriving from an invalid/expired magic link: never
    // says why (expired vs unknown vs revoked vs rate-limited).
    try{
      if(/[?&]error=/.test(window.location.search)){
        if(signin.hidden&&PROFILES.length)choose(PROFILES[0]);
        err.textContent=msg('magic');
        history.replaceState(null,'',BASE+'/login');
      }
    }catch(e){}

    f.addEventListener('submit',function(ev){
      ev.preventDefault();
      if(!selected)return;
      err.textContent='';btn.disabled=true;
      fetch(BASE+'/api/auth/login',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({user_id:selected.id,password:pw.value})
      }).then(function(r){
        if(r.ok){window.location.replace(BASE+'/');return;}
        btn.disabled=false;
        err.textContent = r.status===429 ? msg('limit') : msg('wrong');
        pw.focus();pw.select();
      }).catch(function(){
        btn.disabled=false;err.textContent=msg('network');
      });
    });
  })();
</script>
</body>
</html>`;
}

const AVATAR_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// --- roles -----------------------------------------------------------------
// Routes only the master may call: running the instance (household accounts,
// cache and API budgets, metadata language, imports from the server folder, the
// Kodi configuration) and the instance-wide access log. Everything else is open to
// any member and already scoped to the caller's own data. Kept as one list,
// enforced by the gate, so the boundary can be read (and tested) in one place.
//
// [method or null for any, path pattern, optional exception]
const MASTER_ONLY = [
  [null, /^\/api\/household(\/|$)/],
  // Per-title refresh / clear (Detail options) stay open: the cache is shared
  // and lazily rebuilt, so neither can hurt anyone's data.
  [null, /^\/api\/admin\//, (p) => /^\/api\/admin\/cache\/[a-z]+\/\d+(\/refresh)?$/.test(p)],
  [null, /^\/api\/usage(\/|$)/],
  [null, /^\/api\/import(\/|$)/],
  ['PATCH', /^\/api\/settings\/metadata-language$/],
  ['PATCH', /^\/api\/kodi\/enabled$/],
  [null, /^\/api\/kodi\/instances(\/|$)/],
  ['POST', /^\/api\/kodi\/(test|sync)$/],
  ['GET', /^\/api\/kodi\/icons$/],
  ['GET', /^\/api\/auth\/access-log$/],
];
export function isMasterOnly(method, p) {
  return MASTER_ONLY.some(
    ([m, re, except]) => (!m || m === method) && re.test(p) && !(except && except(p))
  );
}

// Which account a login attempt targets. Without a user_id the request is
// accepted only while a single account can sign in (the single-user case, and
// API clients written before profiles existed); otherwise it is ambiguous.
function loginTarget(userId) {
  if (userId === undefined || userId === null || userId === '') {
    if (countPasswordUsersStmt.get().c !== 1) return { ambiguous: true };
    return { user: onlyPasswordUserStmt.get() };
  }
  return { user: getUser(userId) };
}

// --- registration ----------------------------------------------------------
// Registers the global auth gate, the /login page, and the auth API routes.
export function registerAuth(fastify, { configured }) {
  fastify.decorateRequest('user', null);

  // Paths reachable WITHOUT a session (login page + login submit + logout).
  function isPublic(request) {
    const p = (request.raw.url || '').split('?')[0];
    if (request.method === 'GET' && (p === '/login' || p === '/login.html')) return true;
    if (request.method === 'GET' && p === '/api/health') return true; // liveness probe
    // PWA branding shell: pure static assets, no user data. These MUST be
    // reachable without a session: iOS fetches the apple-touch-icon (often
    // cookieless) when adding to the home screen, and 302-ing it to the HTML
    // login page makes iOS fall back to a blank/generic icon.
    if (
      request.method === 'GET' &&
      (p === '/manifest.json' || p === '/sw.js' || p.startsWith('/icons/'))
    ) {
      return true;
    }
    // The picker's avatars, shown before anyone has signed in.
    if (request.method === 'GET' && /^\/api\/auth\/profiles\/\d+\/avatar$/.test(p)) return true;
    if (request.method === 'POST' && p === '/api/auth/login') return true;
    if (request.method === 'POST' && p === '/api/auth/invite') return true; // set a password from an invite
    if (request.method === 'POST' && p === '/api/auth/logout') return true; // just clears a cookie
    // The magic-link REDEEM endpoint is itself an auth mechanism, so it must be
    // reachable without a session. Only the token URL is public; the management
    // routes (list/create/revoke) stay behind the gate.
    if (
      request.method === 'GET' &&
      /^\/api\/auth\/magic\/[a-f0-9]{64}$/.test(p)
    ) {
      return true;
    }
    return false;
  }

  fastify.addHook('onRequest', async (request, reply) => {
    if (!configured) {
      // No password set: auth disabled (operator warned at boot), and every
      // request acts as the master account.
      const master = getMaster();
      request.user = master ? { id: master.id, role: master.role } : null;
      return;
    }
    if (isPublic(request)) return;
    const p = (request.raw.url || '').split('?')[0];
    const user = sessionUser(request);
    if (user) {
      request.user = user;
      if (user.role !== 'master' && isMasterOnly(request.method, p)) {
        reply.code(403).send({ error: 'forbidden' });
        return reply;
      }
      return;
    }

    if (p.startsWith('/api/') || p.startsWith('/assets/') || p.startsWith('/badges/')) {
      reply.code(401).send({ error: 'unauthorized' });
    } else {
      reply.redirect(`${BASE}/login`); // 302 for page navigations (browser-facing)
    }
    return reply; // halt the pipeline
  });

  // Standalone login page: the profile picker. With ?invite=<token> it opens on
  // "choose your password" for the invited member instead (or, when the invite
  // is no longer valid, on the picker with a notice saying so). The invite lives
  // under /login on purpose: the service worker never answers /login from its
  // cache, so the link works on a device that already has the app installed.
  fastify.get('/login', async (request, reply) => {
    let invite = null;
    const token = request.query && request.query.invite;
    if (typeof token === 'string' && token) {
      const found = findInvite(token);
      invite = found ? { name: found.display_name } : { invalid: true };
    }
    reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer') // keep an invite token out of any Referer
      .send(loginPageHtml(pickerProfiles(), invite));
  });

  // POST /api/auth/invite { token, password }: a member sets their own password
  // from an invite, and is signed in. Token guessing is capped by the same
  // per-IP failure limit as magic links (only failures count).
  fastify.post('/api/auth/invite', async (request, reply) => {
    const ip = clientIp(request);
    if (isMagicRateLimited(ip)) {
      reply.code(429);
      return { error: 'Too many attempts. Try again later.' };
    }
    const body = request.body || {};
    const invite = findInvite(body.token);
    if (!invite) {
      recordMagicFailure(ip);
      logAccess(EVENTS.INVITE, request, false);
      reply.code(410);
      return { error: 'invite_invalid' };
    }
    const password = body.password;
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      reply.code(400);
      return { error: 'password_length' };
    }
    clearMagicFailures(ip);
    db.transaction(() => {
      setPasswordStmt.run(hashPassword(password), invite.user_id);
      clearInvites(invite.user_id);
      setLastLoginStmt.run(Date.now(), invite.user_id);
    })();
    logAccess(EVENTS.INVITE, request, true, invite.user_id);
    setSessionCookie(reply, request, createSession(invite.user_id, request));
    return { ok: true };
  });

  // GET /api/auth/sessions: the caller's signed-in devices, newest activity first.
  fastify.get('/api/auth/sessions', async (request) => {
    const token = sessionTokenFrom(request);
    const current = token ? hashToken(token) : null;
    return {
      sessions: listSessionsStmt.all(request.user.id).map((s) => ({
        id: s.id,
        label: s.label,
        created_at: s.created_at,
        last_seen_at: s.last_seen_at,
        current: s.token_hash === current,
      })),
    };
  });

  // DELETE /api/auth/sessions/:id: sign one of the caller's devices out.
  fastify.delete('/api/auth/sessions/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const row = Number.isInteger(id) ? getSessionByIdStmt.get(id, request.user.id) : null;
    if (!row) {
      reply.code(404);
      return { error: 'not found' };
    }
    deleteSessionByIdStmt.run(id, request.user.id);
    const token = sessionTokenFrom(request);
    if (token && hashToken(token) === row.token_hash) clearSessionCookie(reply, request);
    return { ok: true };
  });

  // GET /api/auth/profiles/:id/avatar: a picker tile's image. Public, but only
  // for accounts the picker shows, and only their avatar (an uploaded photo or
  // the poster of the title they chose). The URL is versioned by the page.
  fastify.get('/api/auth/profiles/:id/avatar', async (request, reply) => {
    const user = getUser(request.params.id);
    const file = isPickable(user) ? avatarFile(user) : null;
    if (!file) {
      reply.code(404);
      return { error: 'not found' };
    }
    reply
      .header('Content-Type', AVATAR_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')
      .header('Cache-Control', 'private, max-age=86400');
    return reply.send(fs.createReadStream(file));
  });

  // GET /api/auth/status: whether login is enabled, and who is signed in.
  fastify.get('/api/auth/status', async (request) => {
    const u = request.user ? getUser(request.user.id) : null;
    return {
      enabled: configured,
      authenticated: !!request.user,
      user: u ? { id: u.id, display_name: u.display_name, role: u.role } : null,
    };
  });

  // POST /api/auth/login  { user_id, password }
  fastify.post('/api/auth/login', async (request, reply) => {
    const ip = clientIp(request);
    if (isRateLimited(ip)) {
      reply.code(429);
      return { error: 'Too many attempts. Try again later.' };
    }
    const body = request.body || {};
    const target = loginTarget(body.user_id);
    if (target.ambiguous) {
      reply.code(400);
      return { error: 'user_id is required' };
    }
    const user = target.user;
    if (user && isUserLocked(user.id)) {
      reply.code(429);
      return { error: 'Too many attempts. Try again later.' };
    }
    if (!user || user.disabled || !verifyPassword(user.password_hash, body.password)) {
      recordFailure(ip);
      recordGlobalFailure();
      if (user) recordUserFailure(user.id);
      logAccess(EVENTS.LOGIN, request, false, user ? user.id : null); // fire-and-forget audit entry
      const delay = globalDelayMs(); // escalating, capped; wrong-password path only
      if (delay) await sleep(delay);
      reply.code(401);
      return { error: 'Invalid credentials' }; // generic: no existence hint
    }
    clearFailures(ip);
    clearGlobalFailures();
    userAttempts.delete(user.id);
    if (needsRehash(user.password_hash)) setPasswordStmt.run(hashPassword(body.password), user.id);
    setLastLoginStmt.run(Date.now(), user.id);
    const token = createSession(user.id, request);
    logAccess(EVENTS.LOGIN, request, true, user.id);
    setSessionCookie(reply, request, token);
    return { ok: true };
  });

  // POST /api/auth/logout-all → sign the caller out on every device (including
  // this one). Other members' sessions are untouched.
  fastify.post('/api/auth/logout-all', async (request, reply) => {
    revokeAllSessions(request.user.id);
    logAccess(EVENTS.LOGOUT_ALL, request, true, request.user.id);
    clearSessionCookie(reply, request);
    return { ok: true };
  });

  // GET /api/auth/access-log → the most recent authentication events (hashed
  // identifiers only) for the read-only "Recent access" panel in Settings.
  fastify.get('/api/auth/access-log', async () => ({ entries: getRecentAccess(20) }));

  // POST /api/auth/logout
  fastify.post('/api/auth/logout', async (request, reply) => {
    destroySession(request);
    clearSessionCookie(reply, request);
    return { ok: true };
  });

  // --- Magic links ---------------------------------------------------------
  // GET /api/auth/magic/:token: the passwordless login itself. Public (see
  // isPublic), rate limited per IP, and redirects (never returns JSON) so a
  // real browser navigation lands on the app or the login page.
  fastify.get('/api/auth/magic/:token', async (request, reply) => {
    const ip = clientIp(request);
    // Redirect (302) to a generic login error on ANY failure: never reveal why.
    const fail = (userId = null) => {
      logAccess(EVENTS.MAGIC_LINK, request, false, userId); // fire-and-forget audit entry
      return reply.redirect(`${BASE}/login?error=magic`);
    };

    if (isMagicRateLimited(ip)) return fail();

    const token = request.params && request.params.token;
    const match = redeemToken(token); // timing-safe; null when invalid/expired
    if (!match) {
      recordMagicFailure(ip); // only failures count toward the brute-force limit
      return fail();
    }
    const user = getUser(match.user_id);
    if (!user || user.disabled) return fail(match.user_id);
    clearMagicFailures(ip);
    recordUse(match.id);
    logAccess(EVENTS.MAGIC_LINK, request, true, user.id);

    // A session IDENTICAL to a password login for the link's account (same
    // lifetime, same cookie): no reduced permissions.
    setLastLoginStmt.run(Date.now(), user.id);
    setSessionCookie(reply, request, createSession(user.id, request));
    return reply.redirect(`${BASE}/`);
  });

  // GET /api/auth/magic: the caller's active links (never the token value).
  fastify.get('/api/auth/magic', async (request) => ({ links: listMagicLinks(request.user.id) }));

  // POST /api/auth/magic { label?, expiry? }: create a link that signs in the
  // caller, and return its URL ONCE.
  fastify.post('/api/auth/magic', async (request, reply) => {
    const body = request.body || {};
    const label = typeof body.label === 'string' ? body.label : null;
    const link = createMagicLink({ userId: request.user.id, label, expiresInMs: expiryMsFor(body.expiry) });
    // `url` logs the visiting device in instantly and 302s into the app.
    const url = magicLinkUrl(request, link.token);
    // Return the URL once; the token itself is never echoed again.
    reply.code(201);
    return {
      id: link.id,
      label: link.label,
      created_at: link.created_at,
      expires_at: link.expires_at,
      last_used_at: null,
      use_count: 0,
      url,
    };
  });

  // DELETE /api/auth/magic/:id: revoke (hard-delete) one of the caller's links.
  fastify.delete('/api/auth/magic/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!Number.isInteger(id)) {
      reply.code(400);
      return { error: 'invalid id' };
    }
    const removed = revokeMagicLink(id, request.user.id);
    if (!removed) {
      reply.code(404);
      return { error: 'not found' };
    }
    return { ok: true };
  });
}

// Browser-facing URL of a path inside the app (e.g. '/login?invite=…'), for links
// a member copies to another device. Prefers the configured public origin
// (PUBLIC_URL); otherwise reconstructs it from the EXTERNAL scheme+host the
// proxy chain forwards, so it's never localhost or a LAN IP for a real request.
export function publicAppUrl(request, appPath) {
  let origin = PUBLIC_URL;
  if (!origin) {
    const proto = (request.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
      (request.headers[':scheme']) || 'https';
    const host = (request.headers['x-forwarded-host'] || request.headers.host || '')
      .split(',')[0]
      .trim();
    origin = host ? `${proto}://${host}` : '';
  }
  return `${origin}${BASE}${appPath}`;
}

function magicLinkUrl(request, token) {
  return publicAppUrl(request, `/api/auth/magic/${token}`);
}
