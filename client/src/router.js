// Client-side SPA router using the History API.
// Each route maps a path pattern to an async view(container, params) function.

import { withBase, stripBase } from './basePath.js';
import { clear, stateBlock } from './ui.js';
import { t } from './i18n.js';

let routes = [];
let container = null;
let onChange = null;
// Optional (from, to) => kind: lets the app pick a different transition than
// the plain fade for a particular hop (Movies <-> Series, see main.js).
let transitionFor = null;
let currentPath = null; // the path on screen, for transitionFor
let vtSeq = 0; // bumped per page transition; only the latest clears <html data-vt>
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

export function cameBack() {
  return lastNav === 'pop';
}

// Settles once the page change in progress has finished fading (at once when
// none is). A view that painted a saved copy waits on it before checking for
// fresher data, so a refresh never rebuilds the page while it is fading in.
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
  container = opts.container;
  onChange = opts.onChange || null;
  transitionFor = opts.transitionFor || null;
  routes = opts.routes.map((r) => ({ ...r, ...compile(r.path) }));

  window.addEventListener('popstate', (event) => {
    // state.path is stored root-relative; location.pathname carries the base.
    const path = (event.state && event.state.path) || stripBase(location.pathname);
    // Going back/forward gets the same quick cross-fade (e.g. closing a detail).
    lastNav = 'pop';
    render(path, { transition: 'fade' });
  });
}

function prefersReduced() {
  return (
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
function supportsViewTransition() {
  return typeof document.startViewTransition === 'function';
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

// Core render: swap the container and mount the matched view. The view's
// synchronous prefix (its skeleton) runs before this returns, which lets a View
// Transition snapshot the skeleton immediately — real data streams in behind it,
// so nothing is ever frozen waiting on the network.
function performRender(path) {
  const found = match(path) || match('/');
  if (!found) return Promise.resolve();

  // Tear down the previous view (this aborts its in-flight requests).
  runCleanups();

  const myToken = ++renderToken;

  // Reset scroll and clear the container for the new view.
  container.innerHTML = '';
  window.scrollTo(0, 0);

  if (onChange) onChange(path);

  let viewPromise;
  try {
    viewPromise = Promise.resolve(found.route.view(container, found.params));
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
      clear(container);
      container.append(
        stateBlock({
          kind: 'error',
          title: t('router.loadFailed'),
          error: err.message || '',
          action: { onClick: () => navigate(location.pathname + location.search, { replace: true }) },
        })
      );
    });
}

// Render, optionally wrapped in a View Transition. `opts.transition` is a label
// ('fade') exposed on <html data-vt> so the stylesheet can style it. Unsupported
// browsers or reduced-motion just render instantly.
export function render(path, opts = {}) {
  const from = currentPath;
  currentPath = path;
  let kind = opts.transition;
  if (kind && transitionFor) kind = transitionFor(from, path) || kind;
  if (!kind || !supportsViewTransition() || prefersReduced()) {
    if (typeof opts.onFinish === 'function') opts.onFinish();
    return performRender(path);
  }
  const root = document.documentElement;
  root.dataset.vt = kind;
  const mine = ++vtSeq;
  // The callback is synchronous as far as the API is concerned (we don't return
  // the view's data promise), so the transition captures the skeleton, not the
  // fully-loaded page — fast, no extra wait.
  const transition = document.startViewTransition(() => {
    performRender(path);
  });
  const done = () => {
    // Only the latest transition clears the marker: a quick second tap starts a
    // new one before this one's `finished` settles.
    if (vtSeq === mine) delete root.dataset.vt;
    if (typeof opts.onFinish === 'function') opts.onFinish();
  };
  // `.ready` rejects when a transition is skipped/aborted (e.g. the document
  // can't currently render one); swallow it so it isn't an unhandled rejection.
  transition.ready.catch(() => {});
  transition.finished.then(done, done);
  settled = transition.finished.catch(() => {});
  return transition.finished;
}

// `transition: false` opts out of the cross-fade (used for the silent
// replace-in-place re-render on server recovery, which must not look like a
// navigation). Everything else dissolves — back/forward (popstate) and detail
// opens already did, so a bottom-nav tap was the one navigation that hard-cut.
export function navigate(path, { replace = false, transition = true } = {}) {
  // Accept either form (callers pass literals like '/series' or a full
  // location.pathname): normalize to root-relative for state + matching, and
  // write the base-prefixed URL into history.
  path = stripBase(path);
  lastNav = 'push';
  const state = { path };
  const url = withBase(path);
  if (replace) {
    history.replaceState(state, '', url);
  } else {
    history.pushState(state, '', url);
  }
  render(path, transition ? { transition: 'fade' } : {});
}

// Open a title's detail page with a quick, snappy cross-fade (no morph).
export function openDetail(path) {
  path = stripBase(path);
  lastNav = 'push';
  history.pushState({ path }, '', withBase(path));
  render(path, { transition: 'fade' });
}

export function start() {
  const path = stripBase(location.pathname);
  // Seed the initial history entry with state so popstate always has data.
  history.replaceState({ path }, '', location.pathname);
  render(path);
}
