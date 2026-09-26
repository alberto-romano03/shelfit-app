// Navbar active-icon idle animations — controller.
//
// Only the icon of the CURRENTLY active section animates. When a section becomes
// active: wait 5s, play its icon animation once, then replay every 12–15s (a
// randomized delay so it never feels mechanical). Navigating away immediately
// cancels the pending/scheduled plays for the old icon and starts fresh for the
// new one. All the motion itself is pure CSS @keyframes (styles.css); this file
// only adds/removes the trigger class with the right timing.

// path -> { cls, durationMs }. Only these four tabs animate.
const ANIM = {
  '/': { cls: 'nav-anim-shelf', durationMs: 600 },
  '/movies': { cls: 'nav-anim-clap', durationMs: 500 },
  '/series': { cls: 'nav-anim-tv', durationMs: 400 },
  '/upcoming': { cls: 'nav-anim-heart', durationMs: 500 },
};

const FIRST_DELAY_MS = 5000;
const REPEAT_MIN_MS = 12000;
const REPEAT_MAX_MS = 15000;

export function initNavAnimations(tabButtons) {
  const byPath = new Map();
  for (const b of tabButtons) byPath.set(b.dataset.path, b);

  let activePath = null;
  let startTimer = null;
  let repeatTimer = null;
  let cleanupTimer = null;

  function clearTimers() {
    for (const t of [startTimer, repeatTimer, cleanupTimer]) if (t) clearTimeout(t);
    startTimer = repeatTimer = cleanupTimer = null;
  }

  function stripClass(path) {
    const btn = byPath.get(path);
    const conf = ANIM[path];
    if (btn && conf) btn.classList.remove(conf.cls);
  }

  // Play one cycle for `path` (guarded to the still-active section), then queue
  // the next repeat.
  function play(path) {
    if (path !== activePath) return;
    const btn = byPath.get(path);
    const conf = ANIM[path];
    if (!btn || !conf) return;

    // Restart cleanly: drop the class, force a reflow, re-add so @keyframes runs.
    btn.classList.remove(conf.cls);
    void btn.offsetWidth;
    btn.classList.add(conf.cls);

    cleanupTimer = setTimeout(() => {
      btn.classList.remove(conf.cls);
    }, conf.durationMs + 80);

    const delay = REPEAT_MIN_MS + Math.floor(Math.random() * (REPEAT_MAX_MS - REPEAT_MIN_MS + 1));
    repeatTimer = setTimeout(() => play(path), delay);
  }

  // Called on every route change. `path` is the newly active route.
  function setActive(path) {
    const next = ANIM[path] ? path : null; // non-tab routes → nothing animates
    if (next === activePath) return; // same section still active → leave it running

    clearTimers();
    if (activePath) stripClass(activePath);
    activePath = next;
    if (!activePath) return;

    // First play only after the idle delay — nothing animates during init.
    startTimer = setTimeout(() => play(next), FIRST_DELAY_MS);
  }

  return { setActive };
}
