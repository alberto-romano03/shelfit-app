// Dialog warm-up: get a dialog's data and first-screen images ready before it
// opens, so it paints whole instead of filling in poster by poster.
//
// Two triggers, chosen per dialog (see planning/cache-warmup/PLAN.md):
//   • whenSettled(fn): once per session, after the boot preloader's first tier
//     and an idle moment on Home. For dialogs opened often (Rate-O-Matic).
//   • onIntent(root, selector, fn): the finger landing on a Home tile, a beat
//     before its click. For dialogs opened less often (My Tickets, the receipt,
//     Dust It Off).
//
// A warmed response waits in a slot until the dialog takes it. Any library
// write empties every slot, so a dialog never opens on data from before it.

import { isServerReachable } from './network.js';

const slots = new Map(); // key -> { promise, at, ttl }

if (typeof window !== 'undefined') {
  window.addEventListener('shelfit:library-changed', () => slots.clear());
}

// Worth spending data on now? Not offline, not in data-saver mode, not hidden.
export function canWarm() {
  if (typeof document !== 'undefined' && document.hidden) return false;
  const c = typeof navigator !== 'undefined' && navigator.connection;
  if (c && c.saveData) return false;
  return isServerReachable();
}

// Start `fn` for `key` unless a fresh copy is already waiting. The promise is
// kept as is (its own rejections are swallowed here only to stay quiet).
export function prefetch(key, fn, ttlMs = 60000) {
  const slot = slots.get(key);
  if (slot && Date.now() - slot.at < slot.ttl) return slot.promise;
  const promise = fn();
  promise.catch(() => {});
  slots.set(key, { promise, at: Date.now(), ttl: ttlMs });
  return promise;
}

// The dialog's way in: the warmed promise when one is fresh (it is consumed, so
// a reopen fetches again), otherwise `fallback()`. A warm that failed falls back
// to a fresh request too, so warming can never make a dialog fail.
export function take(key, fallback) {
  const slot = slots.get(key);
  slots.delete(key);
  if (!slot || Date.now() - slot.at >= slot.ttl) return fallback();
  return slot.promise.catch(() => fallback());
}

// Resolve after at most `ms`: a dialog waits this long for its first images,
// never longer.
export function capped(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(r, ms))]);
}

// The boot preloader resolves this once its first tier has settled.
let settle;
const settled = new Promise((r) => {
  settle = r;
});
export function markBootSettled() {
  settle();
}

const idle = (fn) =>
  typeof window !== 'undefined' && window.requestIdleCallback
    ? window.requestIdleCallback(fn, { timeout: 3000 })
    : setTimeout(fn, 300);

// Run `fn` once, after boot has settled and the main thread is idle.
const onceRan = new Set();
export function whenSettled(key, fn) {
  if (onceRan.has(key)) return;
  onceRan.add(key);
  settled.then(() =>
    idle(() => {
      if (canWarm()) fn();
      else onceRan.delete(key); // try again on the next Home visit
    })
  );
}

// Warm on the first sign of intent on a tile matching `selector` inside `root`:
// a touch or press (pointerdown), or a mouse hovering it. Each tile warms at
// most once per gesture; the warm functions dedupe on their own.
export function onIntent(root, map) {
  const fire = (e) => {
    if (e.type === 'pointerover' && e.pointerType !== 'mouse') return;
    for (const [selector, fn] of map) {
      if (e.target.closest && e.target.closest(selector)) {
        if (canWarm()) fn();
        return;
      }
    }
  };
  root.addEventListener('pointerdown', fire, { passive: true });
  root.addEventListener('pointerover', fire, { passive: true });
}
