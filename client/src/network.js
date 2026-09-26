// Server-reachability monitor. Detection is based ENTIRELY on fetch outcomes —
// never navigator.onLine (the client may have great internet while the shelfIt
// backend is simply powered off). Drives:
//   • a reactive isServerReachable() flag
//   • a `shelfit:server-change` CustomEvent on every transition
//   • a single, reused bottom toast
// api.js reports every request outcome here, so a failing call flips the state
// immediately without waiting for the next health poll.

import { withBase } from './basePath.js';
import { t } from './i18n.js';

const HEALTH_INTERVAL_MS = 8000; // poll cadence while the server is reachable
const HEALTH_INTERVAL_OFFLINE_MS = 4000; // faster cadence while down — catch recovery quickly
const HEALTH_TIMEOUT_MS = 3000; // per-probe timeout
const NAV_PING_THROTTLE_MS = 1500; // min spacing between navigation-triggered probes
const TEXT_FADE_MS = 170; // label fade, either direction
const RECOVERY_TOAST_MS = 3000; // how long "Back online" lingers before it hides
const COLLAPSE_MS = 10000; // offline toast folds to its circle after this long visible
const WIDTH_MS = 400; // width/padding transition (keep in sync with the CSS)
const ICON_HOLD_MS = 320; // the circle holds while the disc crossfades inside it
const SLIDE_MS = 350; // slide up/down duration (keep in sync with the CSS transition)

const offlineMsg = () => t('net.offline');
const onlineMsg = () => t('net.online');

// Inline toast glyphs (Lucide globe-off / eject). Inline BY RULE, not by
// accident: this toast appears precisely when requests are failing, so it must
// paint without waiting on any fetch (see the icon rule in ui.js). The matching
// .svg files were deleted — these strings are the only copies.
// stroke=currentColor so CSS tints them; sized to the disc span via CSS.
const GLOBE_OFF_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M10.114 4.462A14.5 14.5 0 0 1 12 2a10 10 0 0 1 9.313 13.643"/>' +
  '<path d="M15.557 15.556A14.5 14.5 0 0 1 12 22 10 10 0 0 1 4.929 4.929"/>' +
  '<path d="M15.892 10.234A14.5 14.5 0 0 0 12 2a10 10 0 0 0-3.643.687"/>' +
  '<path d="M17.656 12H22"/>' +
  '<path d="M19.071 19.071A10 10 0 0 1 12 22 14.5 14.5 0 0 1 8.44 8.45"/>' +
  '<path d="M2 12h10"/>' +
  '<path d="m2 2 20 20"/></svg>';
const EJECT_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 13a1 1 0 0 1-.72-1.695l7.257-7.668a2 2 0 0 1 2.926 0l7.256 7.668A1 1 0 0 1 20 13z"/>' +
  '<rect x="3" y="17" width="18" height="4" rx="1"/></svg>';

let reachable = true; // optimistic until proven otherwise
let started = false;
let degraded = false; // a mounted view is currently showing ghost placeholders
let suspecting = false; // a confirmation probe is pending after a single failure

// --- State ----------------------------------------------------------------
export function isServerReachable() {
  return reachable;
}
// Views call this when they render ghost placeholders because the server is
// down, so the app knows to re-render (and re-fetch) once it comes back.
export function markDegraded() {
  degraded = true;
}
export function wasDegraded() {
  return degraded;
}
export function clearDegraded() {
  degraded = false;
}

function setReachable(next) {
  if (next === reachable) return;
  reachable = next;
  updateToast();
  window.dispatchEvent(
    new CustomEvent('shelfit:server-change', { detail: { reachable } })
  );
}

// Called by api.js on every request outcome (see buildApi). A cached
// service-worker fallback response carries X-Shelfit-Offline and must NOT be
// treated as the server being up — only the health poll and un-cached calls do.
export function reportServerUp() {
  suspecting = false; // a real success clears any pending suspicion
  setReachable(true);
}
// A single request failed (network-level rejection or a 5xx). That alone is NOT
// proof the server is down — a reused keep-alive socket the server just closed, a
// momentary blip, or a one-off upstream 5xx look identical to a real outage, and
// flipping the UI on it produces the spurious "offline" toast that clears itself a
// second later. So we don't touch the state here: we fire an out-of-band health
// probe and let ONLY that probe decide. If the server is genuinely down the probe
// fails within its timeout (instantly for connection-refused) and the toast
// appears as before; if it was a transient hiccup the probe succeeds and nothing
// is shown. Bursts of failures collapse to one in-flight probe.
export function reportServerSuspect() {
  if (!reachable) return; // already offline — the fast recovery poll handles it
  if (suspecting) return; // a confirmation probe is already scheduled/running
  suspecting = true;
  pingNow();
}
// (There is deliberately no hard "the server is down" setter. A caller that
// observes a failure asks for confirmation via reportServerSuspect() above; only
// the health probe declares an outage. A view that needs to degrade on THIS tick
// keys off its own local failure flag instead — see views/Detail.js.)

// --- Health poll ----------------------------------------------------------
// One probe of /api/health, classified rather than reduced to a boolean:
//   'ok'      — the server answered (anything under 500)
//   'refused' — the connection was rejected outright (connection refused, DNS or
//               TLS failure, device offline). Nothing is listening: DEFINITIVE.
//   'timeout' — no answer within HEALTH_TIMEOUT_MS, or a 5xx from a live proxy.
//               AMBIGUOUS: a dead host and a momentarily busy one look identical.
// The distinction is what lets runPing() confirm only the ambiguous case, so a
// genuine outage is still declared on the first probe.
async function probe() {
  // Manual AbortController + setTimeout (not AbortSignal.timeout) so the probe
  // has a hard ceiling on EVERY runtime and can't stall when the host is off, and
  // so a missing AbortSignal.timeout can't throw before the fetch even starts.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(withBase('/api/health'), {
      method: 'GET',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    // Any real response under 5xx means it's up. A 5xx is a live reverse proxy
    // reporting a dead backend — real, but also what a single upstream blip looks
    // like, so it goes through confirmation rather than flipping on its own.
    return res.status < 500 ? 'ok' : 'timeout';
  } catch {
    // Our own abort fired → the request went unanswered (busy or stalled).
    // Anything else rejected before that → nothing is listening at all.
    return ctrl.signal.aborted ? 'timeout' : 'refused';
  } finally {
    clearTimeout(timer);
  }
}

// --- Toast (one shared element, created once, reused) ----------------------
// The same content-hugging pill as the transient toast(): [disc icon] [message],
// neutral surface, state carried by the glyph's ink alone.
//
// Every state change runs through the SAME four beats, so a recovery never swaps
// a whole pill's worth of content at once:
//
//   full offline message
//     -> circle          (the label fades, then the pill shrinks around the disc)
//     -> disc crossfades (cracked globe to eject mark, inside the circle)
//     -> circle opens    (to the width the new message needs)
//     -> full online message (fades in once the width has settled)
//
// A flap back down before the sequence finishes cancels it and runs the same
// beats in the other direction, so rapid changes never snap either. The 10s idle
// collapse is just the first beat on its own.
let toastEl = null;
let discBroken = null;
let discSpark = null;
let textEl = null;

// One list, cleared wholesale: a new state change cancels whatever beats of the
// previous one were still pending.
let timers = [];
function clearTimers() {
  timers.forEach(clearTimeout);
  timers = [];
}
function at(ms, fn) {
  timers.push(setTimeout(fn, ms));
}

function ensureToast() {
  if (toastEl) return toastEl;
  toastEl = document.createElement('div');
  toastEl.className = 'net-toast';
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');

  const icon = document.createElement('div');
  icon.className = 'net-toast-icon';
  // Inline SVGs (Lucide globe-off / eject) rather than external mask images, so
  // the glyphs are guaranteed to render regardless of how static assets are
  // served under the app's base path. Colour comes from CSS (currentColor).
  discBroken = document.createElement('span');
  discBroken.className = 'net-toast-disc net-toast-disc--broken';
  discBroken.innerHTML = GLOBE_OFF_SVG;
  discSpark = document.createElement('span');
  discSpark.className = 'net-toast-disc net-toast-disc--spark';
  discSpark.innerHTML = EJECT_SVG;
  icon.append(discBroken, discSpark);

  textEl = document.createElement('div');
  textEl.className = 'net-toast-text';

  toastEl.append(icon, textEl);
  document.body.appendChild(toastEl);
  return toastEl;
}

// The pill hugs its content, and `fit-content` cannot be interpolated - so the
// width it is ABOUT to take is measured and pinned as --net-w, giving the
// collapse (and the re-expansion) two real lengths to animate between.
// Measuring means briefly laying the pill out expanded with `msg` in place:
// transitions are hard-disabled for that one synchronous pass and nothing paints
// inside a single task, so it is invisible.
function measureExpanded(msg) {
  if (!toastEl) return 0;
  const t = toastEl;
  const prevText = textEl.textContent;
  const wasCollapsed = t.classList.contains('collapsed');
  t.classList.add('net-toast--measuring');
  t.classList.remove('collapsed');
  textEl.textContent = msg;
  t.style.setProperty('--net-w', 'fit-content');
  const w = Math.ceil(t.getBoundingClientRect().width);
  t.style.setProperty('--net-w', `${w}px`);
  textEl.textContent = prevText;
  if (wasCollapsed) t.classList.add('collapsed');
  void t.offsetWidth; // flush the restored state before transitions come back
  t.classList.remove('net-toast--measuring');
  return w;
}

const fadeOutLabel = () => textEl.classList.add('net-toast-text--swap');
const fadeInLabel = () => textEl.classList.remove('net-toast-text--swap');

// Beat 1 - shrink to the circle: the label fades out first, so the pill is never
// caught mid-shrink with text still in it. Returns how long the beat lasts.
function collapseToCircle(t) {
  if (t.classList.contains('collapsed')) return 0;
  fadeOutLabel();
  at(TEXT_FADE_MS, () => t.classList.add('collapsed'));
  return TEXT_FADE_MS + WIDTH_MS;
}

// Beats 3 and 4 - open the circle back up carrying `msg`: pin the target width,
// put the (still invisible) text in place, expand, and only then fade the label
// in, so it never appears in a pill that has not finished growing. Returns the
// duration.
function expandWith(t, msg) {
  measureExpanded(msg);
  fadeOutLabel();
  textEl.textContent = msg; // invisible: the label is display:none while collapsed
  t.classList.add('net-toast--opening'); // holds the label on one line meanwhile
  t.classList.remove('collapsed');
  at(WIDTH_MS, () => {
    t.classList.remove('net-toast--opening');
    fadeInLabel();
  });
  return WIDTH_MS + TEXT_FADE_MS;
}

// The idle collapse: after COLLAPSE_MS of continuous downtime the pill folds
// down to its circle and stays there.
function armIdleCollapse(t, delay = 0) {
  at(delay + COLLAPSE_MS, () => collapseToCircle(t));
}

// Offline. A first appearance has nothing to transition FROM, so it simply
// slides up with the message already in place; a flap back down from the online
// message runs the full sequence in the other direction.
function showOffline() {
  const t = ensureToast();
  clearTimers();
  t.classList.remove('dismissing');

  if (!t.classList.contains('show')) {
    t.classList.remove('online', 'collapsed', 'net-toast--opening');
    const msg = offlineMsg();
    textEl.textContent = msg;
    fadeInLabel();
    measureExpanded(msg);
    t.classList.add('show');
    armIdleCollapse(t);
    return;
  }

  at(collapseToCircle(t), () => {
    t.classList.remove('online'); // eject mark crossfades back to the cracked globe
    at(ICON_HOLD_MS, () => {
      armIdleCollapse(t, expandWith(t, offlineMsg()));
    });
  });
}

// Recovery: shrink to the circle, swap the disc inside it, open back up with the
// online message, then linger before sliding away.
function showOnline() {
  const t = ensureToast();
  clearTimers();
  at(collapseToCircle(t), () => {
    t.classList.add('online'); // triggers the disc-broken -> disc-spark crossfade
    at(ICON_HOLD_MS, () => {
      at(expandWith(t, onlineMsg()) + RECOVERY_TOAST_MS, () => dismiss(t));
    });
  });
}

// Slide the pill back down off-screen (ease-in), then reset state for next time.
function dismiss(t) {
  t.classList.add('dismissing');
  t.classList.remove('show');
  at(SLIDE_MS, () => {
    t.classList.remove('online', 'collapsed', 'dismissing', 'net-toast--opening');
    fadeInLabel();
    t.style.removeProperty('--net-w'); // the next appearance measures fresh
  });
}

function updateToast() {
  const t = ensureToast();
  if (!reachable) {
    showOffline();
  } else if (t.classList.contains('show')) {
    // Only announce recovery if we had been showing the offline message.
    showOnline();
  }
}

// --- Lifecycle ------------------------------------------------------------
// Adaptive, self-scheduling poll: a fast cadence while the server is DOWN (so
// recovery is noticed within a few seconds, not up to 30) and a relaxed cadence
// while it's up. A single in-flight guard prevents overlapping probes.
let pollTimer = null;
let pinging = false;

function scheduleNextPing() {
  clearTimeout(pollTimer);
  pollTimer = null;
  // Don't keep probing a hidden tab: a backgrounded PWA has no UI to update, and
  // the visibilitychange handler below fires pingNow() the moment it returns, so
  // reachability is fresh before anything can read it. (Without this the poll
  // ticks for the whole life of the session behind a hidden tab.)
  if (typeof document !== 'undefined' && document.hidden) return;
  const delay = reachable ? HEALTH_INTERVAL_MS : HEALTH_INTERVAL_OFFLINE_MS;
  pollTimer = setTimeout(runPing, delay);
}
// Run a probe and decide reachability from it.
//
// Hysteresis, applied ONLY to the ambiguous outcome: a probe that goes unanswered
// (or returns a 5xx) while we currently believe the server is up does not flip
// the app offline on its own — it is re-probed once, on a fresh connection, and
// only a second ambiguous result is treated as an outage. This is what stops a
// backend that is alive but momentarily busy from announcing itself as down.
//
// A 'refused' outcome is NOT confirmed: nothing is listening, which is proof, and
// it is how every ordinary outage presents (container stopped, proxy stopped,
// machine off, device offline). Those still flip on the very first probe, exactly
// as fast as before — the extra round-trip is paid only by a stalled host, the one
// case where being sure is the entire point.
const CONFIRM_DELAY_MS = 250;

async function runPing() {
  if (pinging) return; // a probe is already in flight
  pinging = true;
  try {
    let result = await probe();
    if (result === 'timeout' && reachable) {
      await new Promise((r) => setTimeout(r, CONFIRM_DELAY_MS));
      result = await probe();
    }
    setReachable(result === 'ok');
  } finally {
    pinging = false;
    suspecting = false; // the probe has spoken — clear any pending suspicion
    scheduleNextPing();
  }
}
// Probe immediately, then resume the adaptive cadence — used on the signals that
// most often coincide with a connectivity change, so the state doesn't lag until
// the next interval (or the next user action) as it did before.
function pingNow() {
  clearTimeout(pollTimer);
  runPing();
}

// A navigation-triggered probe, throttled so a burst of route changes fires at
// most one probe. Every in-app screen change re-checks reachability, so infra
// going down (Caddy/machine/network) is noticed on the very next navigation —
// within one probe timeout — instead of lagging up to a full poll interval. This
// is what makes "stop Caddy" degrade as promptly as "stop the container" (which
// self-reports instantly via a 5xx on its next request).
let lastNavPing = 0;
function pingOnNav() {
  const now = Date.now();
  if (now - lastNavPing < NAV_PING_THROTTLE_MS) return;
  lastNavPing = now;
  pingNow();
}

export function startNetworkMonitor() {
  if (started) return;
  started = true;
  runPing(); // immediate first check on app load, then adaptive polling
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pingNow();
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', pingNow); // returned to the app
    window.addEventListener('online', pingNow); // device link restored
    window.addEventListener('offline', pingNow); // device link lost → probe fails fast
    // SPA navigation → re-probe. Back/forward fire popstate; hash routes fire
    // hashchange; programmatic navigations go through history.pushState, which the
    // router uses and which emits no event, so wrap it to notify us.
    window.addEventListener('popstate', pingOnNav);
    window.addEventListener('hashchange', pingOnNav);
    const origPush = history.pushState;
    if (typeof origPush === 'function') {
      history.pushState = function (...args) {
        const result = origPush.apply(this, args);
        pingOnNav();
        return result;
      };
    }
  }
}
