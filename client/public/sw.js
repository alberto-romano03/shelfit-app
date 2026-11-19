// shelfIt service worker — instant cache-first shell + graceful offline.
//   • App shell (HTML) + /static/* bundles + logo: CACHE-FIRST. At install we
//     pre-cache the shell, the logo, AND every hashed JS/CSS file of this build
//     (PRECACHE, written in by the build), so the app + loading screen render
//     fully offline with zero network wait, no blank/unstyled page.
//   • GET /api/profile, /api/stats & /api/plan-to-watch: network-first, cached
//     into shelfit-data-v1. The profile fetch also warms its avatar/cover/badge
//     images; the plan-to-watch fetch warms its poster images. Together these
//     let the home screen open offline (name, avatar, cover, stats) and the
//     Movies/Series "Plan to Watch" grid render real poster cards offline.
//   • Profile images (/api/profile/photo, /assets/*, /badges/*): network-first,
//     falling back to a warmed copy in shelfit-data-v1 when offline. Any image
//     not in cache simply errors (never an empty/malformed response), so the
//     frontend's own skeleton fallback takes over.
//   • Everything else under /api: network only.
//
// The app is hosted under a sub-path (see Caddyfile / client basePath.js), so
// every path the browser uses carries this prefix. The SW sees those real,
// prefixed paths — so all of its own path literals must include BASE too. Keep
// this in sync with the Caddy `handle_path` prefix and Vite's `base`.

const BASE = '/shelfit';

// Stamped by the build (client/vite.config.js, shelfitServiceWorker): BUILD_ID
// is a hash of the built files, PRECACHE lists every /static/* file. A deploy
// that changes anything therefore changes this script's bytes, which is what
// makes the browser install the new worker, and gets a fresh shell cache. No
// manual version bump. In `vite dev` the placeholders stay as they are.
const BUILD_ID = '__SHELFIT_BUILD_ID__';
const PRECACHE = [] /* __SHELFIT_PRECACHE__ */;

const CACHE = `shelfit-shell-${BUILD_ID}`;
// Offline copies of API responses. Bumped to v3 to drop the copies made before
// accounts existed; the client also deletes every shelfit-data-* cache whenever
// the member on this device changes (userScope.js), since entries are keyed by
// URL alone.
const DATA = 'shelfit-data-v3';
const KEEP = [CACHE, DATA];

// Static, stable public paths (the logo is required by the splash, the in-app
// loader, and the header — pre-cache it so it is never an empty square offline).
const SHELL = [
  `${BASE}/`,
  `${BASE}/index.html`,
  `${BASE}/manifest.json`,
  `${BASE}/icons/apple-touch-icon.png`,
  `${BASE}/icons/shelf-iticon-browser.png`,
  `${BASE}/icons/icon-192.png`,
  `${BASE}/icons/icon-512.png`,
];

const SHELL_KEY = `${BASE}/index.html`;

// Only real content goes into the shell cache. A redirect (signed out, the server
// answers with a 302 to the login page), an error, or the wrong kind of body (the
// server's SPA fallback answers an unknown URL with index.html) would otherwise be
// stored and served from cache: the login page as the app, or HTML under a .js
// name. `html` says which kind the key needs: the shell is HTML, nothing else is.
function cacheable(res, html) {
  if (!res || !res.ok || res.redirected || res.type !== 'basic') return false;
  const isHtml = (res.headers.get('content-type') || '').includes('text/html');
  return html ? isHtml : !isHtml;
}

// Fetch `url` fresh and store it if it is cacheable. `redirect: 'error'` makes a
// 302 fail outright instead of being followed. Best effort.
async function cacheFresh(cache, url, html) {
  try {
    const res = await fetchWithTimeout(new Request(url, { cache: 'no-store', redirect: 'error' }), REVALIDATE_TIMEOUT_MS);
    if (cacheable(res, html)) await cache.put(url, res);
  } catch {
    /* offline or refused: on-demand caching still covers it */
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all([
        cacheFresh(cache, SHELL_KEY, true),
        ...SHELL.filter((u) => u !== SHELL_KEY && u !== `${BASE}/`).map((u) => cacheFresh(cache, u, false)),
        ...PRECACHE.map((u) => cacheFresh(cache, u, false)),
      ]);
    })()
  );
  self.skipWaiting();
});

// Drop this app's caches from older builds. Only `shelfit-` ones: other apps
// share this origin (same host, other path prefixes) and keep their own caches.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('shelfit-') && !KEEP.includes(k)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// Warm the avatar / cover / badge images referenced by a profile response so
// they render offline. The server emits root-absolute paths (/assets/…); warm
// them under the /base prefix, which is exactly what the page requests. Fire-
// and-forget; same-origin URLs only.
async function warmProfileImages(profileResponse) {
  try {
    const data = await profileResponse.json();
    const urls = [data.profile_image_url, data.cover_image_url, data.active_badge_url]
      .filter((u) => typeof u === 'string' && u.startsWith('/'))
      .map((u) => (u.startsWith(BASE + '/') ? u : BASE + u));
    const cache = await caches.open(DATA);
    for (const u of urls) cache.add(u).catch(() => {});
  } catch {
    /* ignore malformed profile bodies */
  }
}

// Drop warmed poster entries that no longer belong to the current watchlist.
// warmPlanPosters is the ONLY writer of /assets/* into DATA, so anything under
// that prefix that isn't in `keep` is a poster for a title that has since left
// Plan to Watch — dead weight that would otherwise accumulate for the life of
// the installation. The profile avatar/cover are also /assets/* URLs, so they
// are added to `keep` from the cached profile response; if that response isn't
// cached yet we can't tell them apart and skip pruning entirely rather than risk
// evicting them.
async function prunePlanPosters(cache, keep) {
  try {
    const profileRes = await cache.match(`${BASE}/api/profile`);
    if (!profileRes) return; // can't identify the profile images → don't prune
    const profile = await profileRes.json();
    for (const u of [profile.profile_image_url, profile.cover_image_url]) {
      if (typeof u === 'string' && u.startsWith('/')) {
        keep.add(u.startsWith(BASE + '/') ? u : BASE + u);
      }
    }
    const prefix = `${BASE}/assets/`;
    for (const req of await cache.keys()) {
      const p = new URL(req.url).pathname;
      if (p.startsWith(prefix) && !keep.has(p)) await cache.delete(req);
    }
  } catch {
    /* a malformed profile body / cache error → leave the cache untouched */
  }
}

// Warm the poster images referenced by a /api/plan-to-watch response so the
// Movies/Series "Plan to Watch" grid renders real poster cards offline. Same
// approach as the profile images: cache.add under the /base prefix, which is
// exactly what the grid's <img> requests. Fire-and-forget; same-origin only.
async function warmPlanPosters(response) {
  try {
    const data = await response.json();
    const urls = (data.titles || [])
      .map((t) => t && t.poster_url)
      .filter((u) => typeof u === 'string' && u.startsWith('/'))
      .map((u) => (u.startsWith(BASE + '/') ? u : BASE + u));
    const cache = await caches.open(DATA);
    for (const u of urls) cache.add(u).catch(() => {});
    // Now that the current set is warm, drop the posters of titles that have
    // left the watchlist — otherwise DATA only ever grows.
    await prunePlanPosters(cache, new Set(urls));
  } catch {
    /* ignore malformed bodies */
  }
}

// Bound every network fetch so a fully-unreachable host can't leave a request
// hanging forever. The critical case: when the whole machine is off, or Caddy's
// host is unreachable, or packets are silently dropped, fetch() neither resolves
// nor throws promptly — it STALLS. Without a ceiling the network-first handlers
// below would await that stall indefinitely and never reach their cache-fallback
// catch, so a cached copy that exists is never served. With it, a stall becomes a
// rejection within `ms` and is handled exactly like a refused connection or a
// 5xx — one uniform "server unreachable" path for every failure mode.
//
// Online, responses arrive far under these limits, so behaviour is unchanged.
// AbortController + setTimeout is used (not AbortSignal.timeout) for maximum
// service-worker runtime compatibility.
const NET_TIMEOUT_MS = 5000; // fast local data endpoints (profile / stats / plan)
const IMG_TIMEOUT_MS = 15000; // images can be larger / slower on a poor link
const REVALIDATE_TIMEOUT_MS = 10000; // background shell/bundle refresh

function fetchWithTimeout(request, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(request, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// Read the last-good cached copy of a data request as an offline response, or
// null when absent/unreadable. Carries X-Shelfit-Offline so the client never
// reads a cached 200 as "server is up". Guarded so a malformed cached body just
// yields null (the caller then surfaces the real network failure).
async function cachedDataResponse(request) {
  try {
    const cache = await caches.open(DATA);
    const cached = await cache.match(request);
    if (cached) {
      const body = await cached.blob();
      const headers = new Headers(cached.headers);
      headers.set('X-Shelfit-Offline', '1');
      return new Response(body, { status: 200, statusText: 'OK (cached)', headers });
    }
  } catch {
    /* cached read failed → fall through */
  }
  return null;
}

// Network-first with a last-good fallback for cacheable data endpoints. The
// fallback carries X-Shelfit-Offline so the client doesn't read a cached 200 as
// "server is up". `warm` (optional) is called with a clone of a fresh response
// to pre-cache any images it references.
//
// Every failure shape must fall back to cache, so the app degrades identically no
// matter WHAT is unreachable (container, Caddy, the whole machine, the network):
//   • fetch THROWS         → device offline / connection refused / DNS/TLS failure
//   • fetch STALLS         → machine off / host unreachable (the timeout → abort)
//   • fetch RESOLVES 5xx   → backend down behind a live reverse proxy (Caddy 502…)
// All three reach the same last-good cache. A 4xx is a real answer from a healthy
// backend (401/404/…) and is passed through unchanged.
async function networkFirstData(request, warm) {
  try {
    const res = await fetchWithTimeout(request, NET_TIMEOUT_MS);
    if (res.ok) {
      const cache = await caches.open(DATA);
      cache.put(request, res.clone()).catch(() => {}); // ignore quota rejections
      if (warm) warm(res.clone());
      return res;
    }
    if (res.status >= 500) {
      const cached = await cachedDataResponse(request);
      if (cached) return cached; // serve last-good copy; else surface the 5xx
    }
    return res;
  } catch (err) {
    const cached = await cachedDataResponse(request);
    if (cached) return cached;
    throw err; // nothing cached → let the request fail so the app can degrade
  }
}

// Network-first, falling back to a warmed copy for the profile avatar / cover /
// badge. Falls back on a thrown fetch (offline), a stalled fetch (host off, via
// the timeout), AND a 5xx (backend down behind a live proxy). An image that is
// not in cache errors/passes through normally, keeping the shimmer skeleton.
async function imageWithOfflineFallback(request) {
  try {
    const res = await fetchWithTimeout(request, IMG_TIMEOUT_MS);
    if (res.ok) return res;
    if (res.status >= 500) {
      const cache = await caches.open(DATA);
      const cached = await cache.match(request);
      if (cached) return cached;
    }
    return res;
  } catch (err) {
    const cache = await caches.open(DATA);
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

// Navigations: the cached shell, instantly, refreshed in the background from
// /index.html itself. Never from the navigation's own response: that may be an
// image or JSON opened in a tab, or the login page after a redirect, and storing
// it as the shell would break the next launch. On a cache miss the navigation
// goes to the network as is (the server may redirect it to the login page, which
// the browser follows), and is kept as the shell only if it is the HTML app.
async function shellFirst(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(SHELL_KEY);
  if (cached) {
    event.waitUntil(cacheFresh(cache, SHELL_KEY, true));
    return cached;
  }
  try {
    const res = await fetchWithTimeout(request, REVALIDATE_TIMEOUT_MS);
    if (cacheable(res, true)) await cache.put(SHELL_KEY, res.clone());
    return res;
  } catch {
    return new Response('', { status: 504 });
  }
}

// Shell assets (/static/*, icons, manifest): cache-first. Content-hashed bundles
// (/static/*) never change for a given URL, so a hit is served as is; unhashed
// assets are refreshed in the background so a redeploy lands on the next load.
async function cacheFirst(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached && new URL(request.url).pathname.startsWith(`${BASE}/static/`)) return cached;
  // Timed out so a stalled host can't leave a background revalidation (or a
  // cache miss's only fetch) hanging forever.
  const network = fetchWithTimeout(request, REVALIDATE_TIMEOUT_MS)
    .then(async (res) => {
      if (cacheable(res, false)) await cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(network);
    return cached; // instant; network revalidates in the background
  }
  return (await network) || new Response('', { status: 504 });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // The login page is a real server-rendered page behind the auth gate. It must
  // NEVER be shadowed by the cached SPA shell — otherwise an expired session
  // boots the app, gets 401s, redirects to /login, and the SW hands back the
  // shell again → an unbreakable loop. Let these navigations hit the network.
  if (url.pathname === `${BASE}/login` || url.pathname === `${BASE}/login.html`) {
    return;
  }

  // Magic-link redemption navigation. It MUST reach the network so the server can
  // set the session cookie and 302 into the app, and it must NOT be shadowed by
  // the cached SPA shell (that would boot the app with no session → /login). Let
  // the browser handle it natively: this applies Set-Cookie and follows the
  // redirect correctly across browsers — an SW `redirect:'manual'` opaque response
  // did not reliably carry the cookie on some Android builds.
  if (request.mode === 'navigate' && url.pathname.startsWith(`${BASE}/api/auth/magic/`)) {
    return; // bypass the SW → native network navigation
  }

  // Share Target navigation (/shelfit/share?...). It MUST reach the backend so
  // the server can parse the shared TMDB link and 302 into the app — never the
  // cached SPA shell (which would drop the shared payload). The redirect target
  // (/shelfit/?open=… or ?search=…) is a normal navigation handled below.
  if (request.mode === 'navigate' && url.pathname === `${BASE}/share`) {
    return; // bypass the SW → native network navigation
  }

  // A navigation straight to an API, image or badge URL (opened in a tab) is not
  // an app route: let the browser load it, never the shell.
  if (
    request.mode === 'navigate' &&
    ['/api/', '/assets/', '/badges/'].some((p) => url.pathname.startsWith(BASE + p))
  ) {
    return;
  }

  // Navigations (any SPA route) → the single cached shell, instantly.
  if (request.mode === 'navigate') {
    event.respondWith(shellFirst(event));
    return;
  }

  if (!sameOrigin) return; // third-party requests: default handling

  // Cached-data endpoints (also warms profile images).
  if (url.pathname === `${BASE}/api/profile`) {
    event.respondWith(networkFirstData(request, warmProfileImages));
    return;
  }
  if (url.pathname === `${BASE}/api/stats`) {
    event.respondWith(networkFirstData(request, null));
    return;
  }
  // Watchlist — cached JSON + warmed poster images so the Movies/Series "Plan
  // to Watch" grid shows real poster cards offline.
  if (url.pathname === `${BASE}/api/plan-to-watch`) {
    event.respondWith(networkFirstData(request, warmPlanPosters));
    return;
  }

  // Profile-referenced images: network-first with an offline fallback.
  if (
    url.pathname === `${BASE}/api/profile/photo` ||
    url.pathname.startsWith(`${BASE}/assets/`) ||
    url.pathname.startsWith(`${BASE}/badges/`)
  ) {
    event.respondWith(imageWithOfflineFallback(request));
    return;
  }

  // Rest of the API (incl. /api/health, which must fail when down) → network only.
  if (url.pathname.startsWith(`${BASE}/api/`)) return;

  // Never intercept the service worker script itself.
  if (url.pathname === `${BASE}/sw.js`) return;

  // Shell assets (/static/* bundles, /icons/*, /manifest.json, …) → cache-first.
  event.respondWith(cacheFirst(event));
});

// --- Push notifications ----------------------------------------------------
// The backend sends an encrypted JSON payload { title, body, url, tag? }. Show it
// as a notification using the app icon; the click opens shelfIt at `url`. A loan
// (tag 'loan') is also announced to any open shelfit window, which raises its
// popup right away.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'shelfit';
  const options = {
    body: data.body || 'A new episode is available',
    icon: `${BASE}/icons/icon-192.png`,
    badge: `${BASE}/icons/icon-192.png`,
    tag: data.tag || data.url || 'shelfit', // collapse duplicates for the same target
    data: { url: typeof data.url === 'string' ? data.url : '/' },
  };
  const tasks = [self.registration.showNotification(title, options)];
  if (data.tag === 'loan') {
    tasks.push(
      self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((list) => list.forEach((c) => c.postMessage({ type: 'shelfit:loan' })))
    );
  }
  event.waitUntil(Promise.all(tasks));
});

// Tapping a notification focuses an existing shelfit window (navigating it to the
// target) or opens a new one at the series detail page.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rel = (event.notification.data && event.notification.data.url) || '/';
  const target = rel.startsWith(BASE) ? rel : `${BASE}${rel}`;
  event.waitUntil(
    (async () => {
      const clientsArr = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of clientsArr) {
        if (client.url.includes(BASE) && 'focus' in client) {
          await client.focus();
          if ('navigate' in client) {
            try {
              await client.navigate(target);
            } catch {
              /* cross-origin or not allowed — focus is enough */
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })()
  );
});
