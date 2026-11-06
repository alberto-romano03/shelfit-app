// Client-side SPA router using the History API.
// Each route maps a path pattern to an async view(container, params) function.

import { withBase, stripBase } from './basePath.js';
import { clear, stateBlock } from './ui.js';
import { t } from './i18n.js';
import { closeTopSheetOnPop } from './sheetStack.js';
import {
  pagePhase,
  resolveHop,
  lockSize,
  pin,
  prepare,
  prepareReturn,
  holdForReady,
  leaveAgain,
  play,
  settle,
  cut,
  ghostOf,
  removeGhost,
} from './pageMotion.js';

let routes = [];
// The page on screen. Every page gets its own <main>, so the old one can stay on screen,
// unchanged, while the next one builds.
let container = null;
let onChange = null;
// (from, to, nav) => { kind, dir }: the move a hop gets (see main.js and pageMotion.js).
let transitionFor = null;
let currentPath = null; // the path on screen, for transitionFor
let previousPath = ''; // the page before it, see cameFrom
let historyIndex = 0; // tells Back from Forward
// How long a page may take to be ready before it starts moving with its placeholder. Long
// enough for most data to arrive first, short enough that a tap never feels ignored.
const READY_BUDGET_MS = 100;
// Teardown callbacks for the view currently being mounted. Registered
// synchronously from a view's body (before its first await) so navigation can
// abort in-flight requests even while the view is still loading.
//
// This is a LIST, not a single slot: a view may register several independent
// teardowns (abort a fetch, drop a window listener, clear a debounce timer) from
// different points in its body, and every one of them must run. Each is invoked
// once, in registration order, and the list is emptied — a cleanup that throws
// never prevents the rest from running.
let cleanups = [];
let renderToken = 0;
// How the page now mounting was reached: 'pop' for Back/Forward, 'push' for
// everything else. Views that keep their place between visits restore it only
// when the user came back, so a fresh open still starts at the top.
let lastNav = 'push';

// Where this page was opened from. A skeleton can guess from it what is about to load
// (a title opened from Series is a series).
export function cameFrom() {
  return previousPath;
}

export function cameBack() {
  return lastNav === 'pop';
}

// Settles once the page change in progress has finished moving (at once when
// none is). A view that painted a saved copy waits on it before checking for
// fresher data, so a refresh never rebuilds the page while it is moving.
let settled = Promise.resolve();
export function afterTransition() {
  return settled.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

export function onCleanup(fn) {
  if (typeof fn === 'function') cleanups.push(fn);
}

function runCleanups() {
  const pending = cleanups;
  cleanups = [];
  for (const fn of pending) {
    try {
      fn();
    } catch {
      /* a failed teardown must never block the others (or the navigation) */
    }
  }
}

function compile(pattern) {
  const keys = [];
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/\//g, '\\/')
        .replace(/:([a-zA-Z]+)/g, (_, k) => {
          keys.push(k);
          return '([^\\/]+)';
        }) +
      '$'
  );
  return { regex, keys };
}

export function initRouter(opts) {
  onChange = opts.onChange || null;
  transitionFor = opts.transitionFor || null;
  routes = opts.routes.map((r) => ({ ...r, ...compile(r.path) }));

  window.addEventListener('popstate', (event) => {
    if (closeTopSheetOnPop()) return; // Back closes the sheet; the page stays put.
    // state.path is stored root-relative; location.pathname carries the base.
    const path = (event.state && event.state.path) || stripBase(location.pathname);
    const index = event.state && Number.isFinite(event.state.index) ? event.state.index : historyIndex - 1;
    const nav = index < historyIndex ? 'pop' : 'push';
    historyIndex = index;
    lastNav = 'pop';
    // iOS's swipe-back has already shown its own slide: don't play another on top of it.
    render(path, { nav, transition: !event.hasUAVisualTransition });
  });
}

function match(path) {
  for (const r of routes) {
    const m = r.regex.exec(path);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
  }
  return null;
}

function newPage() {
  const page = document.createElement('main');
  page.className = 'view';
  page.id = 'view';
  return page;
}

// Mount the matched view into `page`. The view's synchronous prefix (its saved copy or
// skeleton) runs before this returns; the promise settles once its first real paint is done.
function mount(path, page, myToken) {
  const found = match(path) || match('/');
  if (!found) return Promise.resolve();
  let viewPromise;
  try {
    viewPromise = Promise.resolve(found.route.view(page, found.params));
  } catch (err) {
    viewPromise = Promise.reject(err);
  }
  return viewPromise
    .then((cleanup) => {
      // A view may ALSO return a cleanup; append it rather than replacing the
      // ones it registered via onCleanup, so both kinds run on navigate-away.
      if (myToken === renderToken) onCleanup(cleanup);
    })
    .catch((err) => {
      // Aborts are expected on navigate-away; a stale view must not clobber the
      // page that replaced it.
      if (err && err.name === 'AbortError') return;
      if (myToken !== renderToken) return;
      console.error(err);
      clear(page);
      page.append(
        stateBlock({
          kind: 'error',
          title: t('router.loadFailed'),
          error: err.message || '',
          action: { onClick: () => navigate(location.pathname + location.search, { replace: true }) },
        })
      );
    });
}

// The next frame, or a moment later where frames aren't running (a hidden page).
const nextFrame = () =>
  new Promise((resolve) => {
    requestAnimationFrame(resolve);
    setTimeout(resolve, 100);
  });

// Ready: its first real paint is done, or the budget ran out.
function whenReady(viewDone) {
  return Promise.race([viewDone, new Promise((resolve) => setTimeout(resolve, READY_BUDGET_MS))]).then(nextFrame);
}

let finishHop = null; // settles `settled` for the hop in progress
let onScreen = null; // while a new page waits to start moving: the page still showing

function render(path, opts = {}) {
  const from = currentPath;
  previousPath = from || '';
  currentPath = path;
  const nav = opts.nav || 'push';
  const hop = opts.transition && from !== null ? resolveHop(transitionFor ? transitionFor(from, path, nav) : null) : null;

  const myToken = ++renderToken;
  if (container && container.isConnected) lockSize(container);
  // Tear down the previous view (this aborts its in-flight requests). It reads the
  // scroll position it wants to keep, so this comes before anything moves.
  runCleanups();
  let leaving;
  if (pagePhase() === 'waiting' && onScreen) {
    // The page that was about to replace this one never appeared: drop it, and the page
    // still showing is the one that leaves.
    if (container !== onScreen) container.remove();
    leaving = onScreen;
    leaveAgain(leaving);
  } else {
    leaving = container && container.isConnected ? pin(container, from).el : null;
  }
  onScreen = null;
  window.scrollTo(0, 0);
  if (onChange) onChange(path);

  if (finishHop) finishHop();
  settled = new Promise((resolve) => {
    finishHop = resolve;
  });
  const finished = () => {
    if (myToken !== renderToken) return;
    settle(container);
    if (finishHop) finishHop();
    finishHop = null;
  };

  // Heading back to a page that hasn't finished leaving: it turns around from where it is.
  const returning = hop ? ghostOf(path) : null;
  if (returning && returning !== leaving) {
    prepareReturn(returning, leaving, hop);
    container = returning;
    play(returning, leaving, hop, () => {
      if (myToken !== renderToken) return;
      // Home. The real page builds underneath it, then takes over.
      const page = newPage();
      returning.before(page);
      container = page;
      holdForReady();
      onScreen = returning;
      const viewDone = mount(path, page, myToken);
      whenReady(viewDone).then(nextFrame).then(() => {
        if (myToken !== renderToken) return;
        onScreen = null;
        removeGhost(returning);
        finished();
      });
    }, { fresh: false });
    return;
  }

  const page = newPage();
  if (leaving) leaving.before(page);
  else document.querySelector('.tabbar').before(page);
  container = page;

  if (!hop) {
    cut(leaving);
    mount(path, page, myToken);
    finished();
    return;
  }

  prepare(page, leaving, hop);
  onScreen = leaving;
  const viewDone = mount(path, page, myToken);
  whenReady(viewDone).then(() => {
    if (myToken !== renderToken) return;
    onScreen = null;
    play(page, leaving, hop, finished);
  });
}

// `transition: false` is for a silent re-render in place (a language change, the server
// coming back), which must not look like a navigation. `kind: 'tab'` is a tab bar tap.
export function navigate(path, { replace = false, transition = true, nav = 'push' } = {}) {
  // Accept either form (callers pass literals like '/series' or a full
  // location.pathname): normalize to root-relative for state + matching, and
  // write the base-prefixed URL into history.
  path = stripBase(path);
  lastNav = 'push';
  const url = withBase(path);
  if (replace) {
    history.replaceState({ path, index: historyIndex }, '', url);
  } else {
    historyIndex += 1;
    history.pushState({ path, index: historyIndex }, '', url);
  }
  render(path, { nav, transition });
}

// Open a title's detail page.
export function openDetail(path) {
  navigate(path);
}

export function start() {
  const path = stripBase(location.pathname);
  // Seed the initial history entry with state so popstate always has data.
  if (history.state && Number.isFinite(history.state.index)) historyIndex = history.state.index;
  history.replaceState({ path, index: historyIndex }, '', location.pathname);
  render(path);
}
