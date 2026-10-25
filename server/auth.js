// Single-user authentication for shelfIt.
//
// One password gates the whole app. It's set once via APP_PASSWORD in .env,
// hashed with scrypt on first boot, and stored in the `settings` table — the
// plaintext is never persisted and .env is ignored afterwards. Sessions are
// random tokens kept in memory (a Set) for the process lifetime, carried in a
// signed HttpOnly cookie. No external dependencies — Node's crypto only.

import crypto from 'node:crypto';
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

// The app is served under this sub-path by the reverse proxy (see Caddyfile),
// which STRIPS the prefix before forwarding — so incoming request paths are at
// root and the auth gate matches them unchanged. Only URLs we hand back to the
// BROWSER (the login redirect, the login page's own asset/API refs, the session
// cookie scope) must carry the prefix. Keep in sync with Caddy / client BASE.
const BASE = '/shelfit';

// --- scrypt parameters -----------------------------------------------------
// LEGACY_SCRYPT verifies hashes written by older builds (stored as `salt:hash`).
// New/reset passwords use SCRYPT (raised toward current OWASP guidance) and
// embed their own parameters in the stored value (`s2:N:r:p:salt:hash`), so the
// work factor can be tuned later without ever locking out an existing hash.
const LEGACY_SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEYLEN = 64;
const SALT_BYTES = 32;
const PW_KEY = 'auth:password_hash';

const COOKIE = 'shelfit_session';
const YEAR_SECONDS = 365 * 24 * 60 * 60;

// Per-process secret used only to sign the session cookie. Regenerated on every
// restart, which (together with the in-memory session Set) invalidates all
// existing sessions on restart — acceptable for a single-user self-hosted app.
const COOKIE_SECRET = crypto.randomBytes(32);

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

// --- password hashing ------------------------------------------------------
function hashPassword(password, salt, params = SCRYPT) {
  return crypto.scryptSync(password, salt, KEYLEN, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  });
}

// Boot-time password init / reset. Returns { configured } — when false, auth is
// left DISABLED so the operator isn't locked out until they set APP_PASSWORD.
export function initAuthPassword(logger) {
  const existing = getSetting(PW_KEY);
  const resetFlag = String(process.env.APP_PASSWORD_RESET || '').toLowerCase() === 'true';
  const pw = process.env.APP_PASSWORD || '';

  // Already initialized and not resetting → DB is the source of truth.
  if (existing && !resetFlag) return { configured: true };

  if (!pw) {
    if (existing) {
      logger.warn('AUTH: APP_PASSWORD_RESET set but APP_PASSWORD is empty — keeping the existing password.');
      return { configured: true };
    }
    logger.warn(
      'AUTH DISABLED: no password is configured. Set APP_PASSWORD in .env and restart to require login.'
    );
    return { configured: false };
  }

  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = hashPassword(pw, salt);
  setSetting(
    PW_KEY,
    `s2:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString('hex')}:${hash.toString('hex')}`
  );
  logger.info(
    existing
      ? 'AUTH: password reset from APP_PASSWORD — stored hash overwritten. You can now remove APP_PASSWORD/APP_PASSWORD_RESET from .env.'
      : 'AUTH: password initialized from APP_PASSWORD and hashed into the database. You can now remove APP_PASSWORD from .env.'
  );
  return { configured: true };
}

// Constant-time verification of a submitted password against the stored hash.
// Supports both the self-describing `s2:N:r:p:salt:hash` format (params read
// from the stored value) and the legacy `salt:hash` format (verified with the
// original work factor), so an already-configured password keeps working.
function verifyPassword(password) {
  const stored = getSetting(PW_KEY);
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
    actual = hashPassword(password, salt, params);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// --- sessions --------------------------------------------------------------
// Sessions live only in memory (cleared on restart, as before). Each token is
// tagged with the "session generation" it was minted under; a session is valid
// only while its generation matches the current one. Bumping the generation
// (see logoutAllSessions) therefore invalidates every outstanding session at
// once — the mechanism behind "Sign out all devices" — without a restart. The
// generation is persisted in settings so an invalidation survives a restart too.
const GEN_KEY = 'auth:session_generation';
function loadGeneration() {
  const n = parseInt(getSetting(GEN_KEY), 10);
  return Number.isInteger(n) && n > 0 ? n : 1;
}
let sessionGeneration = loadGeneration();
if (getSetting(GEN_KEY) == null) setSetting(GEN_KEY, String(sessionGeneration));

const sessions = new Map(); // token -> generation it was minted under
// Tokens are only removed on explicit logout, so without a bound the map would
// grow for every login for the life of the process. The cap is far above any
// real device count (and cookies die with the process anyway, since COOKIE_SECRET
// is per-boot), so evicting the oldest can never sign out a live device in
// practice — it just stops the map from being unbounded.
const MAX_SESSIONS = 500;

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, sessionGeneration);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  return token;
}
function destroySession(token) {
  if (token) sessions.delete(token);
}
function isValidSession(token) {
  if (!token) return false;
  const gen = sessions.get(token);
  return gen !== undefined && gen === sessionGeneration;
}
// Invalidate ALL sessions everywhere: advance (and persist) the generation so no
// existing token can match again, and drop the in-memory set. The caller also
// clears the current device's own cookie.
function logoutAllSessions() {
  sessionGeneration += 1;
  setSetting(GEN_KEY, String(sessionGeneration));
  sessions.clear();
}

// --- cookie signing / parsing ---------------------------------------------
function sign(token) {
  const mac = crypto.createHmac('sha256', COOKIE_SECRET).update(token).digest('base64url');
  return `${token}.${mac}`;
}
function unsign(value) {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot < 0) return null;
  const token = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = crypto.createHmac('sha256', COOKIE_SECRET).update(token).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return token;
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}
function sessionTokenFrom(request) {
  const cookies = parseCookies(request.headers.cookie);
  return unsign(cookies[COOKIE]);
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

// Global, IP-independent throttle. The per-IP limiter above can be sidestepped
// by rotating X-Forwarded-For (LAN/direct mode) or by using many source IPs
// (distributed guessing). This adds a small, escalating delay to every FAILED
// attempt across all IPs, so aggregate guessing rate is capped regardless of
// source. The delay is bounded (never a hard lock) and only ever applies to a
// wrong password, so the legitimate owner's correct login is always instant.
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

// Periodically drop expired windows so the map can't grow without bound.
const attemptsSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of attempts) if (now >= e.resetAt) attempts.delete(ip);
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
// The logo is the same file as the favicon, linked rather than inlined: /icons/*
// is public (see isPublic), so it loads without a session, and as a separate URL
// it is downloaded once and browser-cached (Caddy sends a week's max-age) instead
// of riding along, base64-inflated, in every no-store copy of this page.
function loginPageHtml() {
  const logoTag = `<img class="logo" src="${BASE}/icons/shelf-iticon-browser.png" alt="" width="72" height="72">`;
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
  html,body{margin:0;height:100%}
  body{
    background:var(--bg);color:var(--text-primary);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    display:flex;align-items:center;justify-content:center;padding:24px;
  }
  .card{width:100%;max-width:320px;text-align:center}
  .logo{border-radius:var(--r-lg);margin-bottom:14px}
  h1{font-size:24px;margin:0 0 4px;letter-spacing:-.5px}
  h1 span{color:var(--accent)}
  .sub{color:var(--text-secondary);font-size:14px;margin:0 0 24px}
  form{display:flex;flex-direction:column;gap:12px}
  /* The app's text field: 12px radius, focus as a border swap + outside ring so
     nothing shifts. */
  input{
    width:100%;padding:13px 14px;font:inherit;font-size:16px;border-radius:var(--r-md);
    border:1px solid var(--border);background:var(--surface);color:var(--text-primary);
    transition:border-color var(--dur-short) var(--ease-state),box-shadow var(--dur-short) var(--ease-state);
  }
  input:focus{
    outline:none;border-color:var(--accent);
    box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent);
  }
  /* The app's primary .btn: a pill with the verb's glyph left of the label. */
  button{
    display:inline-flex;align-items:center;justify-content:center;gap:8px;
    width:100%;min-height:48px;padding:13px;font:inherit;font-size:16px;font-weight:600;
    border:none;border-radius:var(--r-pill);background:var(--accent);color:#000;cursor:pointer;
    transition:opacity var(--dur-short) var(--ease-state),transform var(--dur-short) var(--ease-state);
  }
  button svg{width:18px;height:18px;flex-shrink:0}
  button:active:not(:disabled){transform:scale(.97)}
  button:disabled{opacity:.4;cursor:default}
  button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  .error{color:var(--danger);font-size:14px;min-height:18px;margin-top:4px}
</style>
</head>
<body>
  <div class="card">
    ${logoTag}
    <h1>shelf<span>it</span></h1>
    <p class="sub" data-it="Inserisci la password per continuare" data-en="Enter your password to continue">Enter your password to continue</p>
    <form id="f" autocomplete="off">
      <input id="pw" type="password" placeholder="Password" autocomplete="current-password"
        autofocus aria-label="Password">
      <button id="btn" type="submit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7"/></svg><span data-it="Entra" data-en="Come inside">Come inside</span></button>
      <div class="error" id="err" role="alert"
        data-it-magic="Questo link di accesso non è più valido. Inserisci la password."
        data-en-magic="That sign-in link is no longer valid. Enter your password."
        data-it-limit="Troppi tentativi. Riprova più tardi."
        data-en-limit="Too many attempts. Try again later."
        data-it-wrong="Password errata"
        data-en-wrong="Wrong password"
        data-it-network="Errore di rete. Riprova."
        data-en-network="Network error. Try again."></div>
    </form>
  </div>
<script>
  (function(){
    // Language: the app's stored choice, else the browser's. Both languages ship
    // in data attributes; fill every translatable node from its own.
    var lang='en';
    try{lang=localStorage.getItem('shelfit:lang');}catch(e){}
    if(lang!=='it'&&lang!=='en')lang=(navigator.language||'').slice(0,2).toLowerCase()==='it'?'it':'en';
    document.documentElement.setAttribute('lang',lang);
    var nodes=document.querySelectorAll('[data-'+lang+']');
    for(var i=0;i<nodes.length;i++)nodes[i].textContent=nodes[i].getAttribute('data-'+lang);
    var f=document.getElementById('f'),pw=document.getElementById('pw'),
        btn=document.getElementById('btn'),err=document.getElementById('err');
    function msg(key){return err.getAttribute('data-'+lang+'-'+key)||'';}
    // Generic message when arriving from an invalid/expired magic link — never
    // says why (expired vs unknown vs revoked vs rate-limited).
    try{
      if(/[?&]error=/.test(window.location.search)){
        err.textContent=msg('magic');
        history.replaceState(null,'','${BASE}/login');
      }
    }catch(e){}
    f.addEventListener('submit',function(ev){
      ev.preventDefault();
      err.textContent='';btn.disabled=true;
      fetch('${BASE}/api/auth/login',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({password:pw.value})
      }).then(function(r){
        if(r.ok){window.location.replace('${BASE}/');return;}
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

// --- registration ----------------------------------------------------------
// Registers the global auth gate, the /login page, and the auth API routes.
export function registerAuth(fastify, { configured }) {
  // Paths reachable WITHOUT a session (login page + login submit + logout).
  function isPublic(request) {
    const p = (request.raw.url || '').split('?')[0];
    if (request.method === 'GET' && (p === '/login' || p === '/login.html')) return true;
    if (request.method === 'GET' && p === '/api/health') return true; // liveness probe
    // PWA branding shell — pure static assets, no user data. These MUST be
    // reachable without a session: iOS fetches the apple-touch-icon (often
    // cookieless) when adding to the home screen, and 302-ing it to the HTML
    // login page makes iOS fall back to a blank/generic icon.
    if (
      request.method === 'GET' &&
      (p === '/manifest.json' || p === '/sw.js' || p.startsWith('/icons/'))
    ) {
      return true;
    }
    if (request.method === 'POST' && p === '/api/auth/login') return true;
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
    if (!configured) return; // no password set → auth disabled (operator warned at boot)
    if (isPublic(request)) return;
    if (isValidSession(sessionTokenFrom(request))) return;

    const p = (request.raw.url || '').split('?')[0];
    if (p.startsWith('/api/') || p.startsWith('/assets/') || p.startsWith('/badges/')) {
      reply.code(401).send({ error: 'unauthorized' });
    } else {
      reply.redirect(`${BASE}/login`); // 302 for page navigations (browser-facing)
    }
    return reply; // halt the pipeline
  });

  // Standalone login page.
  fastify.get('/login', async (_request, reply) => {
    reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(loginPageHtml());
  });

  // GET /api/auth/status → whether login is enabled (and the caller is in).
  fastify.get('/api/auth/status', async (request) => ({
    enabled: configured,
    authenticated: configured ? isValidSession(sessionTokenFrom(request)) : true,
  }));

  // POST /api/auth/login  { password }
  fastify.post('/api/auth/login', async (request, reply) => {
    const ip = clientIp(request);
    if (isRateLimited(ip)) {
      reply.code(429);
      return { error: 'Too many attempts. Try again later.' };
    }
    const password = request.body && request.body.password;
    if (!verifyPassword(password)) {
      recordFailure(ip);
      recordGlobalFailure();
      logAccess(EVENTS.LOGIN, request, false); // fire-and-forget audit entry
      const delay = globalDelayMs(); // escalating, capped; wrong-password path only
      if (delay) await sleep(delay);
      reply.code(401);
      return { error: 'Invalid credentials' }; // generic — no existence hint
    }
    clearFailures(ip);
    clearGlobalFailures();
    const token = createSession();
    logAccess(EVENTS.LOGIN, request, true);
    reply.header(
      'Set-Cookie',
      buildSessionCookie(sign(token), { maxAge: YEAR_SECONDS, secure: isHttps(request) })
    );
    return { ok: true };
  });

  // POST /api/auth/logout-all → invalidate every active session on every device
  // (including this one). Behind the auth gate, so only an authenticated caller
  // can trigger it. Records an audit entry and clears the current cookie.
  fastify.post('/api/auth/logout-all', async (request, reply) => {
    logoutAllSessions();
    logAccess(EVENTS.LOGOUT_ALL, request, true);
    reply.header('Set-Cookie', buildSessionCookie('', { maxAge: 0, secure: isHttps(request) }));
    return { ok: true };
  });

  // GET /api/auth/access-log → the most recent authentication events (hashed
  // identifiers only) for the read-only "Recent access" panel in Settings.
  fastify.get('/api/auth/access-log', async () => ({ entries: getRecentAccess(20) }));

  // POST /api/auth/logout
  fastify.post('/api/auth/logout', async (request, reply) => {
    destroySession(sessionTokenFrom(request));
    reply.header('Set-Cookie', buildSessionCookie('', { maxAge: 0, secure: isHttps(request) }));
    return { ok: true };
  });

  // --- Magic links ---------------------------------------------------------
  // GET /api/auth/magic/:token — the passwordless login itself. Public (see
  // isPublic), rate limited per IP, and redirects (never returns JSON) so a
  // real browser navigation lands on the app or the login page.
  fastify.get('/api/auth/magic/:token', async (request, reply) => {
    const ip = clientIp(request);
    // Redirect (302) to a generic login error on ANY failure — never reveal why.
    const fail = () => {
      logAccess(EVENTS.MAGIC_LINK, request, false); // fire-and-forget audit entry
      return reply.redirect(`${BASE}/login?error=magic`);
    };

    if (isMagicRateLimited(ip)) return fail();

    const token = request.params && request.params.token;
    const match = redeemToken(token); // timing-safe; null when invalid/expired
    if (!match) {
      recordMagicFailure(ip); // only failures count toward the brute-force limit
      return fail();
    }
    clearMagicFailures(ip);
    recordUse(match.id);
    logAccess(EVENTS.MAGIC_LINK, request, true);

    // Mint a session cookie IDENTICAL to a normal password login (same maxAge,
    // same signing, same scope) — no reduced permissions or shorter lifetime.
    const sessionToken = createSession();
    reply.header(
      'Set-Cookie',
      buildSessionCookie(sign(sessionToken), { maxAge: YEAR_SECONDS, secure: isHttps(request) })
    );
    return reply.redirect(`${BASE}/`);
  });

  // GET /api/auth/magic — list active links (never the token value).
  fastify.get('/api/auth/magic', async () => ({ links: listMagicLinks() }));

  // POST /api/auth/magic { label?, expiry? } — create a link, return its URL ONCE.
  fastify.post('/api/auth/magic', async (request, reply) => {
    const body = request.body || {};
    const label = typeof body.label === 'string' ? body.label : null;
    const link = createMagicLink({ label, expiresInMs: expiryMsFor(body.expiry) });
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

  // DELETE /api/auth/magic/:id — revoke (hard-delete) a link.
  fastify.delete('/api/auth/magic/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!Number.isInteger(id)) {
      reply.code(400);
      return { error: 'invalid id' };
    }
    const removed = revokeMagicLink(id);
    if (!removed) {
      reply.code(404);
      return { error: 'not found' };
    }
    return { ok: true };
  });
}

// Build the browser-facing magic-link URL. Prefers the configured public origin
// (PUBLIC_URL); otherwise reconstructs it from the EXTERNAL scheme+host the
// proxy chain forwards, so it's never localhost or a LAN IP for a real request.
function magicLinkUrl(request, token) {
  let origin = PUBLIC_URL;
  if (!origin) {
    const proto = (request.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
      (request.headers[':scheme']) || 'https';
    const host = (request.headers['x-forwarded-host'] || request.headers.host || '')
      .split(',')[0]
      .trim();
    origin = host ? `${proto}://${host}` : '';
  }
  return `${origin}${BASE}/api/auth/magic/${token}`;
}
