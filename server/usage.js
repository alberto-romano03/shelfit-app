// External-API call metering + self-imposed monthly caps.
//
// Neither TMDB nor Fanart.tv publishes a hard monthly quota (TMDB is ~40 req/s
// with no daily/monthly cap; Fanart.tv is effectively unlimited). So the "cap"
// here is a BUDGET the user sets for their own peace of mind, not an API-imposed
// limit. Counts are metered API calls (api.themoviedb.org / webservice.fanart.tv)
// — image-CDN downloads (image.tmdb.org / assets.fanart.tv) are asset fetches,
// not metered here, so the numbers stay meaningful.
//
// Counts live in the `settings` table under a MONTH-keyed key
// (`api_usage:<api>:<YYYY-MM>`), so a new calendar month naturally starts at 0
// with no explicit reset, and counts survive restarts. Caps live under
// `api_cap:<api>` (0 = unlimited / enforcement off). An in-memory "bypass" set
// lets the user temporarily ignore a cap for the current server session only,
// without changing the saved cap.

import db from './db.js';

export const API_LIST = ['tmdb', 'fanart'];

// Human labels + accent colours for the dashboard (kept here so the API is the
// single source of truth; the client renders whatever it receives).
export const API_META = {
  tmdb: { label: 'TMDB', accent: '#01b4e4' },
  fanart: { label: 'Fanart.tv', accent: '#7dd633' },
};

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
  setSettingStmt.run(key, String(value));
}

// YYYY-MM for the current local month.
export function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

const usageKey = (api, month = monthKey()) => `api_usage:${api}:${month}`;
const capKey = (api) => `api_cap:${api}`;

// Session-only emergency bypass (cleared on restart) — a Set of api names.
const bypassed = new Set();

export function getCap(api) {
  const v = parseInt(getSetting(capKey(api)) || '0', 10);
  return Number.isFinite(v) && v > 0 ? v : 0; // 0 = unlimited
}

export function setCap(api, value) {
  const v = Math.max(0, parseInt(value, 10) || 0);
  setSetting(capKey(api), v);
  return v;
}

export function getUsed(api) {
  const v = parseInt(getSetting(usageKey(api)) || '0', 10);
  return Number.isFinite(v) ? v : 0;
}

export function isBypassed(api) {
  return bypassed.has(api);
}

export function setBypass(api, on) {
  if (on) bypassed.add(api);
  else bypassed.delete(api);
}

// Whether another call to `api` is currently permitted.
export function allowed(api) {
  if (bypassed.has(api)) return true;
  const cap = getCap(api);
  if (cap <= 0) return true; // unlimited / enforcement off
  return getUsed(api) < cap;
}

// Increment this month's counter (month-keyed → auto-resets each calendar month).
export function record(api) {
  const next = getUsed(api) + 1;
  setSetting(usageKey(api), next);
  return next;
}

// Thrown by guard() when a cap is hit, so callers can distinguish it from a real
// network/API error and surface the right "budget reached" message.
export class ApiCapError extends Error {
  constructor(api) {
    super(`${api} monthly call budget reached`);
    this.name = 'ApiCapError';
    this.api = api;
    this.capReached = true;
    this.status = 429;
    this.statusCode = 429; // Fastify reads statusCode for uncaught throws
  }
}

// Enforce the cap before an outbound call. Throws ApiCapError when blocked.
export function guard(api) {
  if (!allowed(api)) throw new ApiCapError(api);
}

// Dashboard snapshot for every tracked API.
export function stats() {
  const month = monthKey();
  return API_LIST.map((api) => {
    const used = getUsed(api);
    const cap = getCap(api);
    const meta = API_META[api] || { label: api, accent: '#888' };
    return {
      api,
      label: meta.label,
      accent: meta.accent,
      month,
      used,
      cap, // 0 = unlimited
      bypassed: bypassed.has(api),
      blocked: cap > 0 && !bypassed.has(api) && used >= cap,
    };
  });
}
