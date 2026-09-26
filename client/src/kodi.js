// Frontend Kodi status manager (singleton).
//
// Holds the enabled + online state in memory and, ONLY while the integration is
// enabled, polls shelfIt's own /api/kodi/status every 30s. Nothing here talks to
// Kodi directly — the backend does. When disabled, no polling runs, no match
// requests fire, and any cached status is discarded, so a user who never opened
// Settings sees no trace of Kodi anywhere.
//
// Polling pauses when the tab is hidden (backgrounded PWA) or the shelfIt server
// is unreachable, and resumes on return.

import { api } from './api.js';
import { isServerReachable } from './network.js';
import { pget, pset } from './persist.js';

const POLL_MS = 30000;
// Now-Playing poll cadence: fast while something is playing, slow when idle.
const NOW_ACTIVE_MS = 8000;
const NOW_IDLE_MS = 30000;
// Remembers, across launches, whether Kodi was enabled — so on boot we can start
// the Now-Playing poll in parallel with the config fetch (indicator/ring appear
// sooner) WITHOUT ever hitting Kodi for users who never enabled it.
const KODI_HINT_KEY = 'kodi-enabled';

const state = {
  enabled: false,
  online: false,
  loaded: false, // config fetched at least once
  now: { active: false }, // cached Now-Playing snapshot (panel reads this, never fetches)
};

let pollTimer = null;
let nowTimer = null;
let wired = false;

// --- Now Playing ----------------------------------------------------------
// A single cached snapshot, refreshed on an adaptive interval and broadcast via
// `shelfit:kodi-nowplaying` so the ring / topbar indicator / panel update in
// lockstep. The panel reads the cache (getNowPlaying) and never fetches on tap.
function emitNow() {
  window.dispatchEvent(new CustomEvent('shelfit:kodi-nowplaying', { detail: state.now }));
}

export function getNowPlaying() {
  return state.now;
}

async function pollNowOnce() {
  if (!state.enabled) return;
  if (document.hidden || !isServerReachable()) return; // paused
  try {
    const np = await api.kodiNowPlaying();
    state.now = np && typeof np === 'object' ? np : { active: false };
    state.online = true; // a successful reply proves Kodi is reachable
  } catch {
    state.now = { active: false }; // any failure → treat as nothing playing
  }
  emitNow();
  scheduleNow();
}

function scheduleNow() {
  clearTimeout(nowTimer);
  nowTimer = null;
  if (!state.enabled) return;
  const ms = state.now && state.now.active ? NOW_ACTIVE_MS : NOW_IDLE_MS;
  nowTimer = setTimeout(pollNowOnce, ms);
}

function stopNow() {
  clearTimeout(nowTimer);
  nowTimer = null;
  if (state.now.active) {
    state.now = { active: false };
    emitNow();
  }
}

function clearStatus() {
  state.online = false;
}

// Stop only the status interval, leaving the cached Now-Playing snapshot (and
// the state the UI reads from it) untouched. Used to pause polling while the tab
// is hidden; startStatusLoop() resumes it on return.
function pauseStatusPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  stopNow();
}

async function pollOnce() {
  if (!state.enabled) return;
  if (document.hidden || !isServerReachable()) return; // paused
  try {
    const s = await api.kodiStatus();
    state.enabled = !!s.enabled;
    state.online = !!s.online;
    if (!state.enabled) {
      // Server says it was disabled out from under us — tear down.
      clearStatus();
      stopPolling();
      return;
    }
    // A scheduled sync left discoveries waiting → ask the UI to raise the review
    // card (it defers itself if a popup is currently open).
    if (s.pending_review > 0) {
      window.dispatchEvent(new CustomEvent('shelfit:kodi-pending'));
    }
  } catch {
    state.online = false; // treat any failure as offline; keep polling
  }
}

// Start the status loop if it isn't already running (idempotent, so it never
// resets an already-running Now-Playing loop started optimistically at boot).
function startStatusLoop() {
  if (pollTimer) return;
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_MS);
}

function wireLifecycle() {
  if (wired) return;
  wired = true;
  // Pause when hidden; poll immediately again when the tab returns.
  //
  // The interval is CLEARED while hidden rather than left ticking on a body that
  // returns early: a backgrounded PWA would otherwise wake every 30s for the rest
  // of the session for nothing. startStatusLoop() is idempotent, so resuming can
  // never end up with two intervals.
  document.addEventListener('visibilitychange', () => {
    if (!state.enabled) return;
    if (document.hidden) {
      pauseStatusPolling();
      return;
    }
    startStatusLoop(); // idempotent, and polls once immediately on resume
    pollNowOnce();
  });
  // When the shelfIt server comes back, refresh Kodi status right away.
  window.addEventListener('shelfit:server-change', (ev) => {
    if (ev.detail && ev.detail.reachable && state.enabled) {
      pollOnce();
      pollNowOnce();
    }
  });
}

// Read the enable toggle and (re)configure polling. Called on boot and whenever
// Settings changes the toggle or the active instance.
export async function refreshKodi() {
  wireLifecycle();

  // If Kodi was enabled last session, kick the Now-Playing poll IN PARALLEL with
  // the config fetch, so the indicator + avatar ring appear a round-trip sooner
  // (the user is likely already watching). Torn down below if config says it's off.
  const likelyEnabled = pget(KODI_HINT_KEY) === true;
  if (likelyEnabled && !state.enabled) {
    state.enabled = true;
    pollNowOnce(); // starts the adaptive Now-Playing loop immediately
  }

  let cfg;
  try {
    cfg = await api.kodiConfig();
  } catch {
    return; // transient boot failure; any optimistic loop keeps running
  }
  state.loaded = true;
  const enabled = !!cfg.enabled && cfg.active_id != null;
  pset(KODI_HINT_KEY, enabled); // remember for the next launch
  if (!enabled) {
    state.enabled = false;
    clearStatus(); // discard any cached status on disable / no active instance
    stopPolling();
    return;
  }
  state.enabled = true;
  startStatusLoop();
  if (!nowTimer) pollNowOnce(); // ensure the Now-Playing loop runs (if not started above)
}

// Boot entry point.
export function initKodi() {
  refreshKodi();
}

// True only when the integration is enabled AND Kodi is currently reachable.
export function isKodiActive() {
  return state.enabled && state.online;
}

// Background match for a detail popup. Resolves to a Kodi id or null, and never
// throws. Skips the request entirely when Kodi is known-offline, so an offline
// Kodi is never hammered with match queries.
export async function matchKodi(tmdbId, type, apiClient) {
  if (!isKodiActive()) return null;
  try {
    const client = apiClient || api;
    const res = await client.kodiMatch(tmdbId, type);
    return res && res.match != null ? res.match : null;
  } catch {
    return null;
  }
}
