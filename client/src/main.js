import './styles.css';
import { initTheme } from './theme.js';
import { initI18n, t, onLangChange } from './i18n.js';
import { initRouter, navigate, start } from './router.js';
import { el, icons } from './ui.js';
import { startNetworkMonitor, wasDegraded, clearDegraded } from './network.js';
import { initKodi } from './kodi.js';
import { initNowPlaying } from './nowPlaying.js';
import { openKodiReviewFromPending } from './kodiSync.js';
import { withBase } from './basePath.js';
import { initInstallPrompt } from './addToHome.js';
import { initNavAnimations } from './navAnim.js';
import { initUserScope } from './userScope.js';
import { checkSuggestions } from './suggestions.js';

import Home from './views/Home.js';
import Series from './views/Series.js';
import Movies from './views/Movies.js';
import Upcoming from './views/Upcoming.js';
import Search, { setPendingSearch } from './views/Search.js';
import Detail from './views/Detail.js';
import Person from './views/Person.js';
import Preview from './views/Preview.js';
import Collection from './views/Collection.js';
import Season from './views/Season.js';
import Settings from './views/Settings.js';
import ListView from './views/List.js';
import Lists from './views/Lists.js';
import { resetGridSection } from './views/grid.js';
import { resetUpcoming, rebuildUpcoming } from './views/Upcoming.js';
import { preloader } from './preloader.js';

initTheme();
initI18n();
// Before anything reads the on-device stores: pick the signed-in member's cache
// and drop what belongs to nobody (see userScope.js).
initUserScope();

const app = document.getElementById('app');

// The current route and the one immediately before it, tracked from the router's
// onChange. The Settings icon uses these to toggle: tapping it while already on
// Settings closes the page and returns to where the user came from.
let currentPath = null;
let previousPath = null;

// --- Header ---------------------------------------------------------------
// (Theme toggle lives in Settings; profile/settings shortcuts live on the home
// cover.)
const brandLogo = el('img', {
  class: 'brand-logo',
  src: withBase('/icons/shelf-iticon-browser.png'),
  alt: '',
  width: '28',
  height: '28',
});
// The logo lives in an overflow-hidden "slot" so the idle animation's disc is
// truly masked by the line (the DVD-slot edge) instead of just fading out.
const brandLogoSlot = el('div', { class: 'brand-logo-slot' }, [brandLogo]);
const brand = el('div', { class: 'brand' }, [
  el('div', { class: 'brand-line' }),
  brandLogoSlot,
  el('h1', { html: 'shelf<span>it</span>' }),
]);
const settingsBtn = el('button', {
  class: 'icon-btn',
  'aria-label': t('common.settings'),
  html: icons.gear,
  onClick: () => {
    // Toggle: if already on Settings, close it and return to the previous
    // page (history.back restores that page's scroll position). Fall back to
    // Home when there is no prior in-app entry (e.g. a cold start on
    // /settings), so the gesture can never step outside the app.
    if (currentPath === '/settings') {
      if (previousPath && previousPath !== '/settings') history.back();
      else navigate('/');
    } else {
      navigate('/settings');
    }
  },
});
const searchBtn = el('button', {
  class: 'icon-btn',
  'aria-label': t('common.search'),
  html: icons.search,
  onClick: () => navigate('/search'),
});
const headerActions = el('div', { class: 'header-actions' }, [settingsBtn, searchBtn]);
const header = el('header', { class: 'app-header' }, [brand, headerActions]);

// --- Idle CD-logo animation: after 120s of inactivity the logo is "sucked"
// into the glowing line and slides back. Purely decorative; resets on any
// interaction and never blocks input. ---
let logoIdleTimer = null;
function armLogoIdle() {
  clearTimeout(logoIdleTimer);
  logoIdleTimer = setTimeout(() => brand.classList.add('logo-idle-run'), 120000);
}
brandLogo.addEventListener('animationend', () => {
  brand.classList.remove('logo-idle-run');
  armLogoIdle();
});
// (mousemove intentionally excluded — it fires per-pixel and would churn the
// idle timer continuously; the events below already cover real interaction.)
['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((e) =>
  window.addEventListener(e, armLogoIdle, { passive: true })
);
armLogoIdle();

// --- View container -------------------------------------------------------
const viewContainer = el('main', { class: 'view', id: 'view' });

// --- Bottom tab bar -------------------------------------------------------
const TABS = [
  { path: '/upcoming', key: 'nav.upcoming', icon: icons.navUpcoming },
  { path: '/series', key: 'nav.series', icon: icons.navSeries },
  { path: '/movies', key: 'nav.movies', icon: icons.navMovies },
  { path: '/', key: 'nav.home', icon: icons.navHome },
];

const tabButtons = TABS.map((tab) => {
  const label = el('span', { text: t(tab.key) });
  const btn = el('button', {
    'data-path': tab.path,
    html: tab.icon,
    // A bottom-nav tap resets the grids (defaults + top of list). What's Next
    // keeps its saved page for the session and only returns to the top; it
    // updates itself when the library changes (see views/Upcoming.js).
    onClick: () => {
      resetGridSection(tab.path);
      if (tab.path === '/upcoming') resetUpcoming();
      navigate(tab.path);
    },
  });
  btn.append(label);
  btn._label = label;
  btn._key = tab.key;
  return btn;
});
const tabbar = el('nav', { class: 'tabbar' }, tabButtons);
// Idle animations for the active tab's icon (starts on section change; see
// navAnim.js). Driven from the router's onChange below.
const navAnim = initNavAnimations(tabButtons);

app.append(header, viewContainer, tabbar);

// --- Router ---------------------------------------------------------------
initRouter({
  container: viewContainer,
  routes: [
    { path: '/', view: Home },
    { path: '/series', view: Series },
    { path: '/movies', view: Movies },
    { path: '/upcoming', view: Upcoming },
    { path: '/search', view: Search },
    { path: '/settings', view: Settings },
    { path: '/detail/:id', view: Detail },
    { path: '/preview/:type/:id', view: Preview },
    { path: '/person/:id', view: Person },
    { path: '/collection/:id', view: Collection },
    { path: '/list/:id', view: ListView },
    { path: '/lists', view: Lists },
    { path: '/season/:id/:n', view: Season },
  ],
  onChange: (path) => {
    // Track the route history (one step back) for the Settings-icon toggle.
    if (path !== currentPath) previousPath = currentPath;
    currentPath = path;
    tabButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.path === path);
    });
    // Start/stop the active icon's idle animation for the new section.
    navAnim.setActive(path);
    // Tier 3: opening Movies/Series tops up that page's remaining chip views so
    // switching chips within it is instant after the first visit.
    if (path === '/movies') preloader.triggerTier3('movies');
    else if (path === '/series') preloader.triggerTier3('series');
  },
});

// --- Share Target launch --------------------------------------------------
// A shared TMDB link (or text) enters via the backend /share endpoint, which
// 302s the app to /shelfit/?open=<type>:<id> or /shelfit/?search=<text>. Read
// those params on boot and act, cleaning the query string first (via
// replaceState) so a refresh or Back never re-triggers the shared action.
// Falls through to the normal start() when there is nothing shared.
function bootFromShare() {
  let params;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return false;
  }
  const open = params.get('open');
  const search = params.get('search');
  if (!open && !search) return false;

  // Seed a clean history entry (no query) so the share isn't repeatable and
  // popstate always has state; the target below is then pushed on top of it.
  history.replaceState({ path: '/' }, '', withBase('/'));

  if (open) {
    const m = /^(movie|show):(\d+)$/.exec(open);
    if (m) {
      navigate(`/preview/${m[1]}/${m[2]}`);
      return true;
    }
  }
  if (search) {
    setPendingSearch(search);
    navigate('/search');
    return true;
  }
  // Malformed params — fall back to a normal boot on Home.
  return false;
}

if (!bootFromShare()) start();

// --- Language switch: relabel the chrome and re-render the current page -----
onLangChange(() => {
  tabButtons.forEach((btn) => (btn._label.textContent = t(btn._key)));
  settingsBtn.setAttribute('aria-label', t('common.settings'));
  searchBtn.setAttribute('aria-label', t('common.search'));
  // Sections that keep their rendered page around between visits would come
  // back in the old language: drop those caches so they rebuild.
  resetGridSection('/movies');
  resetGridSection('/series');
  rebuildUpcoming();
  navigate(location.pathname, { replace: true, transition: false });
});

// --- Splash suppression on resume -----------------------------------------
// The app is now fully initialized (the initial route is mounted). Two paths
// bring the user BACK to an already-running app — returning from an external
// Safari link on an iOS standalone PWA is the motivating case — and neither
// should replay the splash / entrance animation:
//   1) The PWA is reloaded on return (iOS standalone does this). The reload is a
//      fresh JS context, so visibilitychange can't flag it — but sessionStorage
//      survives an in-session reload and is cleared only on a true cold
//      termination. Recording that the splash was shown THIS session lets the
//      head script above skip it on that reload. A genuine cold start has no
//      flag and plays the splash as normal.
//   2) The app is merely resumed (same JS context, visibilitychange fires). Here
//      the splash was long since removed, but we defensively drop any lingering
//      splash/anti-flash overlay and never replay an entrance animation.
try {
  sessionStorage.setItem('shelfit:seen-splash', '1');
} catch (e) {
  /* private mode / disabled storage → splash simply plays every load (safe) */
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  document.documentElement.classList.add('app-resume', 'app-revealed');
  const splash = document.getElementById('splash');
  if (splash && splash.parentNode) splash.parentNode.removeChild(splash);
  const flash = document.getElementById('app-flash');
  if (flash && flash.parentNode) flash.parentNode.removeChild(flash);
});

// --- Progressive image preloading (background) ----------------------------
// Runs entirely in the background — it does NOT hold the splash (which dismisses
// on its own animation, see index.html) so startup stays fast. Tier 1 warms the
// images for the pages the user lands on first, then Tier 2 continues silently.
// All fetches are async and low-priority, so the home screen never janks.
preloader
  .runTier1()
  .catch(() => {})
  .finally(() => {
    preloader.runTier2().catch(() => {});
  });

// --- Server-offline monitoring --------------------------------------------
// When the backend comes back, re-render the current route so any view that was
// showing ghost placeholders re-fetches and swaps in real content.
window.addEventListener('shelfit:server-change', (ev) => {
  if (ev.detail && ev.detail.reachable && wasDegraded()) {
    clearDegraded();
    navigate(location.pathname, { replace: true, transition: false });
  }
});
startNetworkMonitor();

// Capture the (single, early) beforeinstallprompt so the "Add to Home Screen"
// action in Settings can replay it later as a native install dialog.
initInstallPrompt();

// --- Kodi integration -----------------------------------------------------
// Reads the enable toggle and, only when enabled, begins polling Kodi status.
// When disabled it stays completely dormant — no requests, no UI anywhere.
initKodi();
// Kodi "Now Playing" — topbar indicator + pre-rendered popover panel (built once).
initNowPlaying(headerActions);
// A scheduled library sync signals pending discoveries via this event; raise the
// review card (it defers itself until any open popup closes).
window.addEventListener('shelfit:kodi-pending', () => openKodiReviewFromPending());

// Title suggestions from other members: asked about shortly after start (once the
// first screen has settled) and again whenever the app comes back to the
// foreground, at most once a minute (see suggestions.js).
setTimeout(() => checkSuggestions({ force: true }), 1500);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkSuggestions();
});
// A loan's push notification while the app is already open: the service worker
// says so, and the popup comes up now instead of on the next open.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'shelfit:loan') checkSuggestions({ force: true });
  });
}

// --- Durable storage ------------------------------------------------------
// Ask the browser to make our on-device storage persistent so iOS is far less
// likely to evict the offline cache (profile, stats, watchlist titles, cached
// images) between app launches. Best-effort — ignored where unsupported.
if (navigator.storage && typeof navigator.storage.persist === 'function') {
  navigator.storage.persist().catch(() => {});
}

// --- Service worker -------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(withBase('/sw.js'), { scope: withBase('/') })
      .catch(() => {});
  });
}
