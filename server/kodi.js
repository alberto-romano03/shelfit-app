// Kodi integration service — the ONLY place that talks to a Kodi instance.
//
// All communication is server-side over Kodi's JSON-RPC API (HTTP POST to
// /jsonrpc) authenticated with HTTP Basic Auth. The frontend never sees a
// host, port, username or password — it only ever calls shelfIt's own API.
//
// Passwords are stored encrypted (AES-256-GCM) with a key kept in the data
// volume, so the SQLite row never holds a plaintext credential. Encryption is
// reversible on purpose: Basic Auth needs the real password to reach Kodi, so a
// one-way hash would be useless here.
//
// The whole integration degrades silently: if it is disabled, no instance is
// active, or Kodi is unreachable, every entry point returns a neutral result
// (offline / no match) and never throws into the request handlers.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import db from './db.js';
import { DATA_DIR, CLIENT_DIST } from './config.js';

// --- Password encryption --------------------------------------------------
const KEY_PATH = path.join(DATA_DIR, 'kodi.key');

function loadKey() {
  try {
    const b = fs.readFileSync(KEY_PATH);
    if (b.length === 32) return b;
  } catch {
    /* generate below */
  }
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(KEY_PATH, key, { mode: 0o600 });
  } catch {
    /* best effort; key still usable for this process */
  }
  return key;
}
const KEY = loadKey();

// Returns `v1:iv:tag:ciphertext` (all base64) or null for an empty password.
export function encryptPassword(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptPassword(stored) {
  if (!stored) return '';
  try {
    const [v, ivb, tagb, encb] = stored.split(':');
    if (v !== 'v1') return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivb, 'base64'));
    decipher.setAuthTag(Buffer.from(tagb, 'base64'));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(encb, 'base64')),
      decipher.final(),
    ]);
    return dec.toString('utf8');
  } catch {
    return '';
  }
}

// --- Prepared statements (compiled once at module load, reused thereafter) ---
const getEnabledStmt = db.prepare("SELECT value FROM settings WHERE key = 'kodi_enabled'");
const setEnabledStmt = db.prepare(
  `INSERT INTO settings (key, value) VALUES ('kodi_enabled', ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);
const listInstancesStmt = db.prepare('SELECT * FROM kodi_instances ORDER BY id');
const getInstanceStmt = db.prepare('SELECT * FROM kodi_instances WHERE id = ?');
const getActiveInstanceStmt = db.prepare('SELECT * FROM kodi_instances WHERE is_active = 1');
const deleteInstanceStmt = db.prepare('DELETE FROM kodi_instances WHERE id = ?');
const firstInstanceIdStmt = db.prepare('SELECT id FROM kodi_instances ORDER BY id LIMIT 1');
const localTitleYearStmt = db.prepare(
  'SELECT title_it, title_orig, year FROM items WHERE tmdb_id = ? AND type = ?'
);

// --- Enable toggle (settings key/value) -----------------------------------
export function isEnabled() {
  const row = getEnabledStmt.get();
  return row ? row.value === '1' : false;
}
export function setEnabled(on) {
  setEnabledStmt.run(on ? '1' : '0');
}

// --- Instance data access -------------------------------------------------
export function listInstances() {
  return listInstancesStmt.all();
}
export function getInstance(id) {
  return getInstanceStmt.get(id) || null;
}
export function getActiveInstance() {
  return getActiveInstanceStmt.get() || null;
}

// Shape sent to the frontend — password is never included, only whether one is
// set. Everything the settings UI needs, nothing it shouldn't have.
export function publicInstance(row) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username || '',
    has_password: !!row.password,
    icon: row.icon || null,
    is_active: !!row.is_active,
  };
}

// The selectable per-instance icons — SVG files the user drops into
// client/(dist|public)/icons/kodi/, served statically at /icons/kodi/<file>.
export function listKodiIcons() {
  const dirs = [
    path.join(CLIENT_DIST, 'icons', 'kodi'),
    // Dev fallback when the client hasn't been built into dist yet.
    path.join(CLIENT_DIST, '..', 'public', 'icons', 'kodi'),
  ];
  for (const dir of dirs) {
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.svg'))
        .sort();
      if (files.length) {
        return files.map((file) => ({ file, url: `/icons/kodi/${file}` }));
      }
    } catch {
      /* try next */
    }
  }
  return [];
}

const createStmt = db.prepare(
  `INSERT INTO kodi_instances (name, host, port, username, password, icon, is_active)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const clearActiveStmt = db.prepare('UPDATE kodi_instances SET is_active = 0 WHERE is_active = 1');
const setActiveStmt = db.prepare('UPDATE kodi_instances SET is_active = 1 WHERE id = ?');
const activateTx = db.transaction((id) => {
  // Atomic single-active invariant: clear every flag, then set the one.
  clearActiveStmt.run();
  setActiveStmt.run(id);
});

export function createInstance({ name, host, port, username, password, icon }) {
  const hadActive = !!getActiveInstance();
  const info = createStmt.run(
    name,
    host,
    Number(port) || 8080,
    username || null,
    encryptPassword(password),
    icon || null,
    hadActive ? 0 : 1 // first instance ever becomes active automatically
  );
  return getInstance(info.lastInsertRowid);
}

// Update fields; password is only touched when a new non-empty one is supplied
// (blank leaves the stored credential unchanged — write-only from the UI).
export function updateInstance(id, { name, host, port, username, password, icon }) {
  const row = getInstance(id);
  if (!row) return null;
  const fields = [];
  const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (host !== undefined) { fields.push('host = ?'); params.push(host); }
  if (port !== undefined) { fields.push('port = ?'); params.push(Number(port) || 8080); }
  if (username !== undefined) { fields.push('username = ?'); params.push(username || null); }
  if (icon !== undefined) { fields.push('icon = ?'); params.push(icon || null); }
  if (password !== undefined && password !== '') {
    fields.push('password = ?');
    params.push(encryptPassword(password));
  }
  if (fields.length) {
    db.prepare(`UPDATE kodi_instances SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
  }
  return getInstance(id);
}

export function deleteInstance(id) {
  const row = getInstance(id);
  if (!row) return false;
  deleteInstanceStmt.run(id);
  invalidateLibraryCache(id);
  // If the active instance was removed, promote the first remaining one so the
  // integration keeps working with a valid single-active invariant.
  if (row.is_active) {
    const next = firstInstanceIdStmt.get();
    if (next) activateTx(next.id);
  }
  return true;
}

export function activateInstance(id) {
  if (!getInstance(id)) return false;
  activateTx(id);
  invalidateLibraryCache();
  return true;
}

// --- JSON-RPC transport ---------------------------------------------------
// `overridePassword` lets the "test connection" flow try a just-typed password
// that hasn't been saved yet; otherwise the stored encrypted one is used.
async function rpc(instance, method, params, timeoutMs = 2500, overridePassword) {
  const url = `http://${instance.host}:${instance.port}/jsonrpc`;
  const headers = { 'Content-Type': 'application/json' };
  const user = instance.username || '';
  const pass =
    overridePassword !== undefined && overridePassword !== null && overridePassword !== ''
      ? overridePassword
      : decryptPassword(instance.password);
  if (user || pass) {
    headers.Authorization =
      'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const err = new Error(`Kodi HTTP ${res.status}`);
      err.statusCode = res.status;
      throw err;
    }
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Kodi RPC error');
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

// JSON-RPC against the currently-active instance. Throws if none is active.
// The one entry point the library-sync module uses so all Kodi transport stays
// in this file.
export async function rpcActive(method, params, timeoutMs = 8000) {
  const inst = getActiveInstance();
  if (!inst) throw new Error('No active Kodi instance');
  return rpc(inst, method, params, timeoutMs);
}

// --- Reachability ---------------------------------------------------------
export async function pingInstance(instance, overridePassword, timeoutMs = 2500) {
  try {
    const r = await rpc(instance, 'JSONRPC.Ping', {}, timeoutMs, overridePassword);
    return r === 'pong';
  } catch {
    return false;
  }
}

// Status of the active instance — only contacts Kodi when the integration is
// enabled AND an instance is active. Never throws.
export async function statusResponse() {
  if (!isEnabled()) return { enabled: false, online: false };
  const inst = getActiveInstance();
  // No active instance behaves exactly like disabled: report enabled:false so
  // the client stops polling and shows nothing.
  if (!inst) return { enabled: false, online: false };
  const online = await pingInstance(inst);
  return { enabled: true, online };
}

// --- Now Playing ----------------------------------------------------------
// Match a currently-playing title to a shelfIt library row by TMDB id, or — when
// Kodi carries no TMDB id (non-library / direct-file playback) — by title.
const findItemByTmdbStmt = db.prepare('SELECT id, type, tmdb_id FROM items WHERE tmdb_id = ?');
const findItemByTitleStmt = db.prepare(
  `SELECT id, type, tmdb_id FROM items
    WHERE type = ? AND (lower(title_it) = ? OR lower(title_orig) = ?)
    LIMIT 1`
);
// "Already seen?" lookups so the toast can offer Add-rewatch instead of Mark-watched.
const getEpisodeProgressStmt = db.prepare(
  'SELECT watch_count FROM progress WHERE item_id = ? AND season = ? AND episode = ?'
);
const getItemStateStmt = db.prepare('SELECT status, rewatch_count FROM items WHERE id = ?');

// Pull "S02E04" / "2x04" / "Episode 7" out of a filename-ish label when Kodi
// gives no structured season/episode fields.
function parseEpisodeLabel(label) {
  if (!label) return null;
  let m = label.match(/[Ss](\d{1,2})[\s._x-]*[Ee](\d{1,3})/) || label.match(/(\d{1,2})x(\d{1,3})/);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = label.match(/episode\s*(\d{1,3})/i);
  if (m) return { season: 0, episode: Number(m[1]) };
  return null;
}

// Best-effort show / season / episode from a Kodi file path, for playback that
// isn't in Kodi's library (so it has no structured metadata). The folder
// structure usually carries what the filename doesn't, e.g.
//   .../Breaking Bad/Season 2/Episode 7.mkv  →  {show:'Breaking Bad',season:2,episode:7}
function parseKodiPath(file) {
  if (!file || typeof file !== 'string') return {};
  // Streaming add-ons / network streams expose an opaque URL (e.g.
  // https://host/playlist/230618) with no folder structure to mine — skip them,
  // so we never invent a bogus "show" from a URL path segment.
  if (/^(?:https?|plugin|upnp|rtsp|rtmp|udp|pvr|dvd):/i.test(file)) return {};
  const clean = file.replace(/^[a-z]+:\/\//i, ''); // drop smb:// / nfs:// prefixes
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return {};
  const filename = parts[parts.length - 1];
  const dirs = parts.slice(0, -1);
  const out = {};

  // Season / episode from the filename.
  let m =
    filename.match(/[Ss](\d{1,2})[\s._x-]*[Ee](\d{1,3})/) || filename.match(/(\d{1,2})x(\d{1,3})/);
  if (m) {
    out.season = Number(m[1]);
    out.episode = Number(m[2]);
  } else {
    const e = filename.match(/episode\s*(\d{1,3})/i) || filename.match(/^0*(\d{1,3})\b/);
    if (e) out.episode = Number(e[1]);
  }

  // A "Season N" / "SN" / "Stagione N" directory → the show is the dir above it.
  const seasonRe = /^(?:season|stagione|s)\s*0*(\d+)$/i;
  let seasonIdx = -1;
  for (let i = dirs.length - 1; i >= 0; i--) {
    const sm = dirs[i].match(seasonRe);
    if (sm) {
      if (!(out.season > 0)) out.season = Number(sm[1]);
      seasonIdx = i;
      break;
    }
  }
  if (seasonIdx > 0) out.show = dirs[seasonIdx - 1];
  else {
    const parent = dirs[dirs.length - 1];
    if (!seasonRe.test(parent)) out.show = parent;
    else if (dirs.length > 1) out.show = dirs[dirs.length - 2];
  }
  if (out.show) out.show = out.show.replace(/\s*\(\d{4}\)\s*$/, '').replace(/[._]+/g, ' ').trim();
  return out;
}

// Minimal ISO 639-2 (Kodi's 3-letter) → 639-1 (2-letter) map for the languages
// users actually see; anything unknown falls back to the raw code's first two
// letters. Kept small on purpose (no dependency, no full ISO table).
const LANG_2 = {
  eng: 'en', ita: 'it', spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de',
  jpn: 'ja', kor: 'ko', zho: 'zh', chi: 'zh', rus: 'ru', por: 'pt', nld: 'nl',
  dut: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', pol: 'pl', tur: 'tr',
  ara: 'ar', hin: 'hi', ell: 'el', gre: 'el', ces: 'cs', cze: 'cs', hun: 'hu',
  ron: 'ro', rum: 'ro', ukr: 'uk', tha: 'th', vie: 'vi', heb: 'he', ind: 'id',
};
function iso1(code) {
  const c = String(code || '').toLowerCase().trim();
  if (!c) return '';
  if (c.length === 2) return c.toUpperCase();
  return (LANG_2[c] || c.slice(0, 2)).toUpperCase();
}

// Prettify a Kodi audio codec name into a compact label (DTS-HD, AC3, AAC…).
function audioFormat(codec) {
  const c = String(codec || '').toLowerCase();
  if (!c) return '';
  if (c.includes('dtshd') || c === 'dts-hd' || c.includes('dts_hd')) return 'DTS-HD';
  if (c.includes('truehd')) return 'TrueHD';
  if (c.includes('eac3')) return 'E-AC3';
  return c.replace(/[^a-z0-9]/g, '').toUpperCase(); // dts→DTS, ac3→AC3, aac→AAC
}

function timeToSeconds(t) {
  if (!t || typeof t !== 'object') return 0;
  return (t.hours || 0) * 3600 + (t.minutes || 0) * 60 + (t.seconds || 0);
}

// Current Now-Playing snapshot for the active instance. Does GetActivePlayers,
// then GetItem + GetProperties in ONE parallel call. Returns { active:false } when
// nothing is playing or Kodi is off. Never throws.
export async function nowPlaying() {
  if (!isEnabled()) return { active: false };
  const inst = getActiveInstance();
  if (!inst) return { active: false };

  let players;
  try {
    players = await rpc(inst, 'Player.GetActivePlayers', {}, 3000);
  } catch {
    return { active: false };
  }
  const player = (players || []).find((p) => p.type === 'video');
  if (!player) return { active: false };
  const pid = player.playerid;

  let item, props, labels;
  try {
    [item, props, labels] = await Promise.all([
      rpc(inst, 'Player.GetItem', {
        playerid: pid,
        properties: ['title', 'showtitle', 'season', 'episode', 'year', 'runtime', 'uniqueid', 'tvshowid', 'file', 'art', 'thumbnail'],
      }, 3000),
      rpc(inst, 'Player.GetProperties', {
        playerid: pid,
        properties: ['percentage', 'time', 'totaltime', 'speed', 'currentaudiostream', 'currentsubtitle', 'subtitleenabled'],
      }, 3000),
      // The InfoLabels Kodi's own UI shows — add-ons populate these even when the
      // structured GetItem fields are empty. This is what's on screen.
      rpc(inst, 'XBMC.GetInfoLabels', {
        labels: [
          'VideoPlayer.TVShowTitle',
          'VideoPlayer.Title',
          'VideoPlayer.Season',
          'VideoPlayer.Episode',
          'VideoPlayer.Year',
        ],
      }, 3000).catch(() => ({})),
    ]);
  } catch {
    return { active: false };
  }
  const it = (item && item.item) || {};
  const label = (it.label || '').trim();
  const L = labels || {};
  const infoStr = (k) => (typeof L[k] === 'string' ? L[k].trim() : '');
  const infoInt = (k) => {
    const n = parseInt(L[k], 10);
    return Number.isFinite(n) ? n : 0;
  };

  // Prefer structured GetItem fields; then the on-screen InfoLabels; then a label
  // parse; then the file path. Kodi reports type 'unknown' for non-library / add-on
  // playback, so relying on GetItem alone loses the info the UI clearly shows.
  let season = Number(it.season);
  let episode = Number(it.episode);
  let showTitle = (it.showtitle || '').trim();
  let itemTitle = (it.title || '').trim();
  let year = it.year || null;

  if (!showTitle) showTitle = infoStr('VideoPlayer.TVShowTitle');
  if (!itemTitle) itemTitle = infoStr('VideoPlayer.Title');
  if (!(season > 0) && infoInt('VideoPlayer.Season') > 0) season = infoInt('VideoPlayer.Season');
  if (!(episode > 0) && infoInt('VideoPlayer.Episode') > 0) episode = infoInt('VideoPlayer.Episode');
  if (!year && infoInt('VideoPlayer.Year') > 0) year = infoInt('VideoPlayer.Year');

  if (!(episode > 0)) {
    const parsed = parseEpisodeLabel(label);
    if (parsed) {
      episode = parsed.episode;
      if (!(season > 0)) season = parsed.season;
    }
  }
  // Non-library playback: mine the file path for the show name (and season /
  // episode the filename didn't carry).
  if ((!showTitle || !(season > 0) || !(episode > 0)) && it.file) {
    const p = parseKodiPath(it.file);
    if (!showTitle && p.show) showTitle = p.show;
    if (!(season > 0) && p.season > 0) season = p.season;
    if (!(episode > 0) && p.episode > 0) episode = p.episode;
  }
  const looksEpisode = it.type === 'episode' || episode > 0 || showTitle !== '';
  const mediaType = looksEpisode ? 'episode' : it.type === 'movie' ? 'movie' : 'other';

  // Resolve the TMDB id used to match a shelfIt library row. Movies carry it on
  // the item; episodes need the parent show's uniqueid (one extra call, episodes
  // only), so the matched poster/mark-watched target is the SHOW.
  let tmdb = it.uniqueid && (it.uniqueid.tmdb || it.uniqueid.themoviedb);
  if (mediaType === 'episode' && it.tvshowid) {
    try {
      const show = await rpc(inst, 'VideoLibrary.GetTVShowDetails', {
        tvshowid: it.tvshowid,
        properties: ['uniqueid', 'title'],
      }, 3000);
      const det = show && show.tvshowdetails;
      if (det) {
        if (det.uniqueid) tmdb = det.uniqueid.tmdb || det.uniqueid.themoviedb || tmdb;
        if (!showTitle && det.title) showTitle = String(det.title).trim();
      }
    } catch {
      /* leave tmdb / showTitle as-is */
    }
  }

  // The title we try to match against the library: the SHOW for an episode,
  // otherwise the movie/item title (or its label).
  const matchTitle = (mediaType === 'episode' ? showTitle : itemTitle || label).trim();

  let match = null;
  let row = null;
  if (tmdb != null) row = findItemByTmdbStmt.get(String(tmdb));
  // Fallback: no usable TMDB id (e.g. a non-TMDB scraper, or direct playback) —
  // match the library by title instead so Mark-watched still works.
  if (!row && matchTitle) {
    const wantType = mediaType === 'episode' ? 'show' : 'movie';
    const lc = matchTitle.toLowerCase();
    row = findItemByTitleStmt.get(wantType, lc, lc);
  }
  if (row) {
    const folder = row.type === 'movie' ? 'movies' : 'shows';
    match = {
      item_id: row.id,
      type: row.type,
      poster_url: `/assets/${folder}/${row.tmdb_id}/poster.webp`,
    };
    // Whether this exact title is already watched in shelfIt, and how many times
    // in total (episode watch_count, or movie plays = rewatch_count + 1). Drives
    // the toast button: not seen → Mark watched; already seen → Add rewatch.
    if (mediaType === 'episode') {
      match.season = season > 0 ? season : 0;
      match.episode = episode > 0 ? episode : 0;
      const prog = getEpisodeProgressStmt.get(row.id, match.season, match.episode);
      match.seen = !!prog;
      match.plays = prog ? prog.watch_count : 0;
    } else {
      const st = getItemStateStmt.get(row.id);
      match.seen = !!(st && st.status === 'completed');
      match.plays = match.seen ? (st.rewatch_count || 0) + 1 : 0;
    }
    if (tmdb == null) tmdb = String(row.tmdb_id); // enable Add too, and a stable id
  }

  const audioStream = props && props.currentaudiostream;
  const audio =
    audioStream && (audioStream.language || audioStream.codec)
      ? { language: iso1(audioStream.language), codec: audioFormat(audioStream.codec) }
      : null;
  const sub =
    props && props.subtitleenabled && props.currentsubtitle && props.currentsubtitle.language
      ? { language: iso1(props.currentsubtitle.language) }
      : null;

  const totalSeconds = timeToSeconds(props && props.totaltime) || Number(it.runtime) || 0;

  return {
    active: true,
    media_type: mediaType,
    title: mediaType === 'episode' ? itemTitle || '' : itemTitle || label,
    // Heading for an episode: the show name, or the label if Kodi gave none.
    show_title: mediaType === 'episode' ? showTitle || label || '' : null,
    season: mediaType === 'episode' ? (season > 0 ? season : 0) : null,
    episode: mediaType === 'episode' ? (episode > 0 ? episode : 0) : null,
    year: year || null,
    percentage: props ? Math.max(0, Math.min(100, props.percentage || 0)) : 0,
    time_seconds: timeToSeconds(props && props.time),
    total_seconds: totalSeconds,
    paused: props ? (props.speed || 0) === 0 : false,
    audio,
    subtitle: sub,
    // The resolved TMDB id (the SHOW's id for episodes). Lets the client "Add"
    // an unmatched title to the library. `match` stays null when not in library.
    tmdb_id: tmdb != null ? String(tmdb) : null,
    match,
    // Whether Kodi itself has artwork we can proxy (used when there's no local
    // shelfIt poster — e.g. streaming add-ons / non-library playback).
    kodi_poster: !!pickKodiArt(it),
  };
}

// Choose the best artwork token Kodi exposes for the playing item: the show/
// season poster first, then the item poster, episode thumb, or fanart. Kodi
// returns nested art keys as flat dotted strings.
function pickKodiArt(it) {
  const art = (it && it.art) || {};
  return (
    art['tvshow.poster'] ||
    art['season.poster'] ||
    art.poster ||
    art.thumb ||
    (it && it.thumbnail) ||
    art['tvshow.fanart'] ||
    art.fanart ||
    null
  );
}

// Fetch the currently-playing item's artwork bytes from Kodi's image server,
// authenticated with the instance's Basic Auth. Returns {contentType,buffer} or
// null. Kodi serves art at http://host:port/image/<url-encoded art token>.
export async function nowPlayingPoster() {
  if (!isEnabled()) return null;
  const inst = getActiveInstance();
  if (!inst) return null;
  let players;
  try {
    players = await rpc(inst, 'Player.GetActivePlayers', {}, 3000);
  } catch {
    return null;
  }
  const player = (players || []).find((p) => p.type === 'video');
  if (!player) return null;
  let item;
  try {
    item = await rpc(
      inst,
      'Player.GetItem',
      { playerid: player.playerid, properties: ['art', 'thumbnail'] },
      3000
    );
  } catch {
    return null;
  }
  const token = pickKodiArt((item && item.item) || {});
  if (!token) return null;

  const imgUrl = `http://${inst.host}:${inst.port}/image/${encodeURIComponent(token)}`;
  const headers = {};
  const user = inst.username || '';
  const pass = decryptPassword(inst.password);
  if (user || pass) {
    headers.Authorization = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    const res = await fetch(imgUrl, { headers, signal: ac.signal });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await res.arrayBuffer());
    return { contentType, buffer };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Library matching -----------------------------------------------------
// A short in-memory cache of the active instance's library keeps repeated
// detail-popup match checks from hammering Kodi. Keyed by instance id + type.
const libCache = new Map(); // key `${id}:${type}` -> { at, items }
const LIB_TTL_MS = 60_000;

function invalidateLibraryCache(id) {
  if (id === undefined) libCache.clear();
  else {
    for (const key of [...libCache.keys()]) {
      if (key.startsWith(`${id}:`)) libCache.delete(key);
    }
  }
}

// Combining diacritical marks (U+0300–U+036F), stripped after NFKD so
// "Amélie" and "Amelie" compare equal. Built via fromCharCode to keep the
// source ASCII-only (no literal combining chars in the file).
const COMBINING_MARKS = new RegExp(
  `[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`,
  'g'
);
function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function loadLibrary(inst, type) {
  const key = `${inst.id}:${type}`;
  const cached = libCache.get(key);
  // Date.now is fine here — cache freshness only, never persisted.
  const now = Date.now();
  if (cached && now - cached.at < LIB_TTL_MS) return cached.items;

  let items = [];
  if (type === 'movie') {
    const result = await rpc(inst, 'VideoLibrary.GetMovies', {
      properties: ['uniqueid', 'year', 'title', 'originaltitle'],
    });
    items = (result && result.movies) || [];
    items = items.map((m) => ({
      kodiId: m.movieid,
      tmdb: m.uniqueid && (m.uniqueid.tmdb || m.uniqueid.themoviedb),
      year: m.year,
      title: m.title,
      originaltitle: m.originaltitle,
    }));
  } else {
    const result = await rpc(inst, 'VideoLibrary.GetTVShows', {
      properties: ['uniqueid', 'year', 'title', 'originaltitle'],
    });
    items = (result && result.tvshows) || [];
    items = items.map((s) => ({
      kodiId: s.tvshowid,
      tmdb: s.uniqueid && (s.uniqueid.tmdb || s.uniqueid.themoviedb),
      year: s.year,
      title: s.title,
      originaltitle: s.originaltitle,
    }));
  }
  libCache.set(key, { at: now, items });
  return items;
}

// Look up our own row for a title+year fallback when Kodi's scraper metadata
// doesn't carry a TMDB uniqueid.
function localTitleYear(tmdbId, type) {
  const row = localTitleYearStmt.get(String(tmdbId), type === 'movie' ? 'movie' : 'show');
  if (!row) return null;
  const year = row.year ? parseInt(String(row.year).slice(0, 4), 10) : null;
  return {
    titles: [normalizeTitle(row.title_it), normalizeTitle(row.title_orig)].filter(Boolean),
    year: Number.isFinite(year) ? year : null,
  };
}

// Returns the Kodi movieid / tvshowid for the given TMDB id, or null.
export async function matchTitle(tmdbId, type) {
  if (!isEnabled()) return null;
  const inst = getActiveInstance();
  if (!inst) return null;
  const kind = type === 'movie' ? 'movie' : 'show';

  let library;
  try {
    library = await loadLibrary(inst, kind);
  } catch {
    return null; // Kodi unreachable / RPC failure → silently no match
  }

  // Primary: exact TMDB id from Kodi's scraper metadata.
  const byId = library.find((it) => it.tmdb && String(it.tmdb) === String(tmdbId));
  if (byId) return byId.kodiId;

  // Fallback: title + year against our own stored record.
  const local = localTitleYear(tmdbId, kind);
  if (local && local.titles.length) {
    const byTitle = library.find((it) => {
      const t = normalizeTitle(it.title);
      const o = normalizeTitle(it.originaltitle);
      const titleHit = local.titles.includes(t) || local.titles.includes(o);
      if (!titleHit) return false;
      if (local.year && it.year) return Math.abs(local.year - it.year) <= 1;
      return true;
    });
    if (byTitle) return byTitle.kodiId;
  }
  return null;
}

// --- Playback -------------------------------------------------------------
// Movies play directly. For a show we resolve the next unwatched episode (first
// episode with playcount 0 in season/episode order, else the very first), so the
// button does something useful rather than failing on a bare tvshowid.
export async function playOnKodi(kodiId, type) {
  if (!isEnabled()) throw new Error('Kodi integration is disabled');
  const inst = getActiveInstance();
  if (!inst) throw new Error('No active Kodi instance');

  if (type === 'movie') {
    await rpc(inst, 'Player.Open', { item: { movieid: Number(kodiId) } });
    return true;
  }

  // Show: pick the next episode to play.
  const result = await rpc(inst, 'VideoLibrary.GetEpisodes', {
    tvshowid: Number(kodiId),
    properties: ['season', 'episode', 'playcount'],
  });
  const eps = ((result && result.episodes) || [])
    .filter((e) => e.season > 0)
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  if (!eps.length) throw new Error('No episodes found in Kodi');
  const next = eps.find((e) => !e.playcount) || eps[0];
  await rpc(inst, 'Player.Open', { item: { episodeid: next.episodeid } });
  return true;
}
