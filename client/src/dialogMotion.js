// How every dialog arrives and leaves. A sheet is a solid thing: it rises from the bottom
// edge and goes back the way it came, on the same curve as the page slide (pageMotion.js),
// and the page dims with it. A centred popup grows in from slightly smaller and fades.
//
// Each move starts from where the panel is right now, so closing a sheet that's still
// opening reverses it, and letting go of a dragged one carries on from the finger.

const SHEET_IN_MS = 360;
const SHEET_OUT_MS = 280;
const POPUP_IN_MS = 240;
const POPUP_OUT_MS = 160;
const FADE_MS = 150; // reduced motion
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const POPUP_SCALE_IN = 0.94;
const POPUP_SCALE_OUT = 0.97;

function reducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Where it is now, then let go of whatever was moving it.
function take(el) {
  const cs = getComputedStyle(el);
  const now = { transform: cs.transform === 'none' ? 'none' : cs.transform, opacity: +cs.opacity };
  el.getAnimations().forEach((a) => a.cancel());
  return now;
}

// The dim is its own layer behind the panel. The panel lives inside the backdrop, so fading
// the backdrop itself would fade the panel with it, and the page would show through.
export function dimOf(backdrop) {
  let dim = backdrop.querySelector(':scope > .modal-dim');
  if (!dim) {
    dim = document.createElement('div');
    dim.className = 'modal-dim';
    backdrop.prepend(dim);
  }
  return dim;
}

function run(el, keyframes, opts) {
  el.style.willChange = 'transform, opacity';
  const a = el.animate(keyframes, opts);
  const clear = () => {
    el.style.willChange = '';
  };
  a.addEventListener('finish', clear);
  a.addEventListener('cancel', clear);
  return a;
}

export function dialogEnter(panel, backdrop, { popup = false } = {}) {
  // Replacing a dialog that's on its way out (a menu handing over to its confirm): one dim
  // carries on from where the other was, instead of the two stacking up and flashing darker.
  let dimFrom = 0;
  const leaving = document.querySelector('.modal-backdrop.backdrop-closing');
  if (leaving && leaving !== backdrop) {
    const old = dimOf(leaving);
    dimFrom = +getComputedStyle(old).opacity;
    old.style.visibility = 'hidden';
  }
  const dim = dimOf(backdrop);
  if (reducedMotion()) {
    run(panel, { opacity: [0, 1] }, { duration: FADE_MS, easing: 'linear', fill: 'backwards' });
    run(dim, { opacity: [dimFrom, 1] }, { duration: FADE_MS, easing: 'linear', fill: 'backwards' });
    return;
  }
  if (popup) {
    run(panel, { transform: [`scale(${POPUP_SCALE_IN})`, 'scale(1)'] }, { duration: POPUP_IN_MS, easing: EASE, fill: 'backwards' });
    run(panel, { opacity: [0, 1] }, { duration: POPUP_IN_MS * 0.6, easing: 'linear', fill: 'backwards' });
    run(dim, { opacity: [dimFrom, 1] }, { duration: POPUP_IN_MS, easing: EASE, fill: 'backwards' });
    return;
  }
  // In pixels, measured now: the panel's own height is the whole of its travel.
  const height = panel.getBoundingClientRect().height;
  run(panel, { transform: [`translateY(${height}px)`, 'translateY(0px)'] }, { duration: SHEET_IN_MS, easing: EASE, fill: 'backwards' });
  run(dim, { opacity: [dimFrom, 1] }, { duration: SHEET_IN_MS, easing: EASE, fill: 'backwards' });
}

// `done` runs once it's gone. It always runs, even on a page in the background, where
// animations don't finish.
export function dialogLeave(panel, backdrop, done, { popup = false } = {}) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };
  const dimEl = dimOf(backdrop);
  const dim = take(dimEl);
  const from = take(panel);
  backdrop.classList.add('backdrop-closing');
  dimEl.style.opacity = '';
  dimEl.style.transition = '';
  panel.style.transition = '';
  panel.style.transform = '';
  panel.style.removeProperty('--sheet-drag');
  const reduce = reducedMotion();
  const ms = reduce ? FADE_MS : popup ? POPUP_OUT_MS : SHEET_OUT_MS;
  const easing = reduce ? 'linear' : EASE;
  run(dimEl, { opacity: [dim.opacity, 0] }, { duration: ms, easing, fill: 'forwards' });
  let last;
  if (reduce) {
    last = run(panel, { opacity: [from.opacity, 0] }, { duration: ms, easing, fill: 'forwards' });
  } else if (popup) {
    run(panel, { transform: [from.transform === 'none' ? 'scale(1)' : from.transform, `scale(${POPUP_SCALE_OUT})`] }, { duration: ms, easing, fill: 'forwards' });
    last = run(panel, { opacity: [from.opacity, 0] }, { duration: ms, easing: 'linear', fill: 'forwards' });
  } else {
    const height = panel.getBoundingClientRect().height;
    const start = from.transform === 'none' ? 'translateY(0px)' : from.transform;
    last = run(panel, { transform: [start, `translateY(${height}px)`] }, { duration: ms, easing, fill: 'forwards' });
  }
  last.addEventListener('finish', finish);
  setTimeout(finish, ms + 200);
}

// A finger took hold of the panel: it stays exactly where it is, for the finger to move.
export function dialogHold(panel, backdrop) {
  const dim = dimOf(backdrop);
  for (const el of [panel, dim]) {
    const { transform, opacity } = getComputedStyle(el);
    if (!el.getAnimations().length) continue;
    el.getAnimations().forEach((a) => a.cancel());
    if (el === panel && transform !== 'none') el.style.transform = transform;
    if (el === dim) el.style.opacity = opacity;
  }
}
