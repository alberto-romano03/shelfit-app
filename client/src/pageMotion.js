// How one page gives way to the next. Both pages are real and on screen: the old one is
// pinned where it stands (position: fixed, so tearing its view down can't reflow it) and
// the new one builds in the page's flow. Only their transform and opacity are animated.
//
//   push   going deeper: the new page slides in from the right, the old drifts left and dims
//   pop    going back: the exact reverse
//   tab    between tabs: both shift a little in the direction of the tab bar and dissolve
//   grid   Movies <-> Series: the same, with the filters held still (the chip glides, grid.js)
//   swap   the same page again, or reduced motion: a short plain fade
//
// Every move starts from where things are now, so a second tap never makes anything jump.
// A page changes only while it stands still (whenStill), and never in the middle of a move.

const MOVE_MS = 360;
const TAB_MS = 240;
const SWAP_MS = 160;
const EASE_MOVE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const EASE_TAB = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
const BEHIND_SHIFT = 0.28; // of the screen: how far a page drifts behind a deeper one
const BEHIND_DIM = 0.35;
const TAB_SHIFT = 30; // px
// Past this the page is a centred column with the old one showing beside it, so a full
// slide can't cover it: push and pop use the short shift.
const SLIDE_MAX_WIDTH = 700;

const REST = 'translateX(0px)';

let phase = 'still'; // 'waiting' (new page building, old on screen), 'moving', 'still'
let hopKind = null;
let queue = [];
let dim = null;
const ghosts = new Set(); // pinned pages, on their way out

export const pagePhase = () => phase;
// The kind of move this page is arriving by; read while a view mounts.
export const arrivingBy = () => hopKind;

// Run now if the page is standing still, else once it is. Dropped if the page is left first.
export function whenStill(fn) {
  if (phase === 'still') fn();
  else queue.push(fn);
}

function reducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// The move a hop really gets on this screen.
export function resolveHop(hop) {
  if (!hop) return null;
  if (reducedMotion()) return { kind: 'swap' };
  if ((hop.kind === 'push' || hop.kind === 'pop') && window.innerWidth > SLIDE_MAX_WIDTH) {
    return { kind: 'tab', dir: hop.kind === 'push' ? 1 : -1 };
  }
  return hop;
}

function dimEl() {
  if (!dim) {
    dim = document.createElement('div');
    dim.className = 'page-dim';
    document.body.append(dim);
  }
  return dim;
}

function animate(el, keyframes, opts) {
  const a = el.animate(keyframes, { fill: 'both', ...opts });
  (el._moves = el._moves || []).push(a);
  return a;
}

function stop(el) {
  (el._moves || []).forEach((a) => a.cancel());
  el._moves = [];
}

// The grid's filters stay still while the rest of the page moves.
function movers(el, kind) {
  return kind === 'grid' ? [...el.children].filter((c) => !c.classList.contains('grid-chrome')) : [el];
}

// Slide `el` from where it is (or `from`) to `to`.
function moveTo(el, to, { ms, ease, from = null, opDelay = 0, opMs = ms }) {
  const cs = getComputedStyle(el);
  const start = from || { transform: cs.transform === 'none' ? REST : cs.transform, opacity: +cs.opacity };
  stop(el);
  const slide = animate(el, { transform: [start.transform, to.transform] }, { duration: ms, easing: ease });
  animate(el, { opacity: [start.opacity, to.opacity] }, { duration: opMs, delay: opDelay, easing: 'linear' });
  return slide;
}

function setDim(target, ms, ease) {
  const el = dimEl();
  const current = +getComputedStyle(el).opacity;
  stop(el);
  animate(el, { opacity: [current, target] }, { duration: ms, easing: ease });
}

// Before a page's view is torn down: fix its size. Teardown takes away what gave it that
// size (a grid's flex layout), which would blow it up to its full content height and reset
// the scroll inside it. Its place in the document stays, so the window's scroll stays too.
export function lockSize(el) {
  if (el.classList.contains('page-ghost')) return;
  const cs = getComputedStyle(el);
  const m = cs.transform === 'none' ? null : new DOMMatrixReadOnly(cs.transform);
  const r = el.getBoundingClientRect();
  el._box = { top: r.top - (m ? m.m42 : 0), left: r.left - (m ? m.m41 : 0), width: r.width, height: r.height };
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
  el.style.flex = 'none';
}

// Pin a page where it stands, whatever it was doing, now its view has been torn down.
export function pin(el, path) {
  if (el.classList.contains('page-ghost')) {
    ghosts.add(el); // called back, and now leaving again
    return { el, path: el._path };
  }
  const { top, left, height } = el._box;
  el.removeAttribute('id');
  el.classList.add('page-ghost');
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
  el.style.height = `${Math.max(height, window.innerHeight - top)}px`;
  el._path = path;
  ghosts.add(el);
  return { el, path };
}

export function removeGhost(el) {
  for (const part of [el, ...el.children]) stop(part);
  ghosts.delete(el);
  el.remove();
}

// Back on the list of pages leaving: the page meant to replace it never got to appear.
export function leaveAgain(el) {
  ghosts.add(el);
}

// A page on its way out that the next hop is heading back to.
export function ghostOf(path) {
  for (const el of ghosts) if (el._path === path) return el;
  return null;
}

function poses(hop) {
  const w = window.innerWidth;
  const shift = TAB_SHIFT * (hop.dir || 1);
  switch (hop.kind) {
    case 'push':
      return {
        enterFrom: { transform: `translateX(${w}px)`, opacity: 1 },
        leaveTo: { transform: `translateX(${-w * BEHIND_SHIFT}px)`, opacity: 1 },
        ms: MOVE_MS,
        ease: EASE_MOVE,
      };
    case 'pop':
      return {
        enterFrom: { transform: `translateX(${-w * BEHIND_SHIFT}px)`, opacity: 1 },
        leaveTo: { transform: `translateX(${w}px)`, opacity: 1 },
        ms: MOVE_MS,
        ease: EASE_MOVE,
      };
    case 'swap':
      return { enterFrom: { transform: REST, opacity: 1 }, leaveTo: { transform: REST, opacity: 0 }, ms: SWAP_MS, ease: 'ease' };
    default: // tab, grid
      return {
        enterFrom: { transform: `translateX(${shift}px)`, opacity: 0 },
        leaveTo: { transform: `translateX(${-shift}px)`, opacity: 0 },
        ms: TAB_MS,
        ease: EASE_TAB,
      };
  }
}

const SLIDES = new Set(['push', 'pop']);

// Stack the two pages for this move. In a pop the leaving page stays on top, sliding away
// to show the page beneath it.
function stack(entering, leaving, hop) {
  const slides = SLIDES.has(hop.kind);
  const enterOnTop = hop.kind !== 'pop' && hop.kind !== 'swap';
  for (const g of ghosts) if (g !== entering && g !== leaving) g.style.zIndex = 1;
  entering.style.zIndex = enterOnTop ? 3 : 1;
  entering.classList.add('page-moving');
  entering.classList.toggle('page-solid', slides || hop.kind === 'swap');
  entering.classList.toggle('page-top', slides && enterOnTop);
  if (leaving) {
    leaving.style.zIndex = enterOnTop ? 1 : 3;
    leaving.classList.toggle('page-solid', slides || hop.kind === 'swap');
    leaving.classList.toggle('page-top', slides && !enterOnTop);
    if (hop.kind === 'grid') {
      const chrome = leaving.querySelector('.grid-chrome');
      if (chrome) chrome.style.visibility = 'hidden';
    }
  }
}

// A new page, building: hold it at the start of its move, out of sight, until it's ready.
export function prepare(entering, leaving, hop) {
  phase = 'waiting';
  hopKind = hop.kind;
  queue = [];
  document.documentElement.classList.add('page-hop');
  stack(entering, leaving, hop);
  const { enterFrom } = poses(hop);
  for (const el of movers(entering, hop.kind)) {
    el.style.transform = enterFrom.transform;
    el.style.opacity = enterFrom.opacity;
  }
  if (hop.kind === 'pop') {
    const d = dimEl();
    stop(d);
    animate(d, { opacity: [BEHIND_DIM, BEHIND_DIM] }, { duration: 1 });
  }
}

// Heading back to a page that's still on its way out: it stays a ghost until it's home.
export function prepareReturn(ghost, leaving, hop) {
  phase = 'waiting';
  hopKind = hop.kind;
  queue = [];
  document.documentElement.classList.add('page-hop');
  ghosts.delete(ghost); // not leaving any more
  const chrome = ghost.querySelector('.grid-chrome');
  if (chrome) chrome.style.visibility = '';
  stack(ghost, leaving, hop);
}

// The move is done but the real page is still building behind what's on screen.
export function holdForReady() {
  phase = 'waiting';
}

// Run the move. `fresh`: the entering page hasn't moved yet, so it starts from its pose.
export function play(entering, leaving, hop, onDone, { fresh = true } = {}) {
  phase = 'moving';
  const p = poses(hop);
  const isTab = hop.kind === 'tab' || hop.kind === 'grid';
  const opts = { ms: p.ms, ease: p.ease };
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    onDone();
  };
  // Animations don't finish on a page that's in the background, and nothing may ever be
  // left half way: this ends the hop regardless.
  const watchdog = setTimeout(done, p.ms + 500);

  const moving = movers(entering, hop.kind);
  // A page turning around may be mid-way through a different kind of move: all of it heads
  // home, and none of what it was doing can still finish and remove it.
  if (!fresh) {
    for (const el of [entering, ...entering.children]) {
      if (!moving.includes(el) && el._moves && el._moves.length) moveTo(el, { transform: REST, opacity: 1 }, opts);
    }
  }
  let last = null;
  for (const el of moving) {
    el.style.transform = '';
    el.style.opacity = '';
    last = moveTo(el, { transform: REST, opacity: 1 }, {
      ...opts,
      from: fresh ? p.enterFrom : null,
      ...(isTab ? { opDelay: p.ms * 0.15, opMs: p.ms * 0.55 } : {}),
    });
  }
  if (leaving) {
    let removing = null;
    for (const el of movers(leaving, hop.kind)) {
      removing = moveTo(el, p.leaveTo, { ...opts, ...(isTab ? { opMs: p.ms * 0.4 } : {}) });
    }
    // Only if it's still leaving by then: a page can be called back.
    if (removing) {
      removing.onfinish = () => {
        if (ghosts.has(leaving)) removeGhost(leaving);
      };
    } else {
      removeGhost(leaving);
    }
  }
  setDim(hop.kind === 'push' ? BEHIND_DIM : 0, p.ms, p.ease);
  if (last) last.onfinish = done;
  else done();
}

// The move is over: the page goes back to being an ordinary page, and what waited runs.
export function settle(page) {
  for (const g of [...ghosts]) removeGhost(g);
  for (const el of [page, ...(page ? page.children : [])]) {
    if (!el) continue;
    stop(el);
    el.style.transform = '';
    el.style.opacity = '';
  }
  if (page) {
    page.classList.remove('page-moving', 'page-solid', 'page-top');
    page.style.zIndex = '';
  }
  if (dim) stop(dim);
  document.documentElement.classList.remove('page-hop');
  phase = 'still';
  hopKind = null;
  const waiting = queue;
  queue = [];
  waiting.forEach((fn) => fn());
}

// No move at all: the old page simply goes.
export function cut(leaving) {
  if (leaving) removeGhost(leaving);
  for (const g of [...ghosts]) removeGhost(g);
  if (dim) stop(dim);
  document.documentElement.classList.remove('page-hop');
  phase = 'still';
  hopKind = null;
  queue = [];
}

// A content change on a page standing still: the old look dissolves over the new one. A
// copy of the page does it, so the page itself is already final underneath.
export function dissolveOver(page, mutate) {
  if (!page || reducedMotion()) {
    mutate();
    return;
  }
  const r = page.getBoundingClientRect();
  const veil = page.cloneNode(true);
  veil.removeAttribute('id');
  veil.classList.add('page-veil');
  veil.style.top = `${r.top}px`;
  veil.style.left = `${r.left}px`;
  veil.style.width = `${r.width}px`;
  veil.style.height = `${Math.max(r.height, window.innerHeight - r.top)}px`;
  page.after(veil);
  mutate();
  veil.animate({ opacity: [1, 0] }, { duration: SWAP_MS, easing: 'ease', fill: 'forwards' }).onfinish = () => veil.remove();
}
