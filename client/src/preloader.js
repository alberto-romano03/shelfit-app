// Progressive, priority-ordered poster preloading. The goal is that images are
// already in the in-memory imageCache before the user navigates, so pages render
// with no skeleton/ghost states. This module only *triggers* imageCache.load()
// earlier and smarter — no new cache, no new metadata endpoints (it reuses the
// same paginated /api/media the grids use).
//
// Since the Movies/Series grids are virtualised and paginated, the preloader
// fetches exactly ONE page (pageSize items) per chip view — the items that will
// appear first — and seeds the grid's page-1 cache so the first visit is a cache
// hit (instant paint, no refetch). Priority yielding, the global fetch cap, and
// "preloads never delay a user load" are enforced inside imageCache.
//
// Interface: preloader.runTier1(), runTier2(), triggerTier3(page).

import { api, isAbortError } from './api.js';
import { imageCache } from './imageCache.js';
import { isServerReachable } from './network.js';
import { seedGridPage } from './gridVirtual.js';
import {
  saveUpNext,
  saveUpcoming,
  savePlanTitles,
  savePlanDetail,
  getPlanDetail,
  prunePlanDetails,
} from './offlineCache.js';

const TIER1_THRESHOLD = 0.8; // dismiss splash once 80% of Tier-1 images are cached
const TIER1_TIMEOUT_MS = 4000; // …or after this, whichever comes first
const TIER2_BATCH_DELAY_MS = 150; // yield between Tier-2 groups
// One page per chip view — matches the grid's PAGE_SIZE so we preload exactly the
// first page's posters (no more, no less).
const GRID_PAGE_SIZE = 48;
// Bound total preloaded images to stay under imageCache's LRU cap (300).
const MAX_PRELOAD_BUDGET = 240;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// The default chip each section opens on (must match views/grid.js).
const DEFAULT_STATUS = { movie: 'completed', show: 'watching' };
const DEFAULT_FILTER = { genre: '', sort: 'added_at' };

let planTitles = null; // /api/plan-to-watch payload, for durable offline warming
const seen = new Set(); // poster URLs already handed to imageCache
let budget = MAX_PRELOAD_BUDGET;

// --- offline pause / resume ------------------------------------------------
let paused = !isServerReachable();
const resumeWaiters = [];
window.addEventListener('shelfit:server-change', (e) => {
  const reachable = !!(e.detail && e.detail.reachable);
  paused = !reachable;
  if (reachable && resumeWaiters.length) {
    resumeWaiters.splice(0).forEach((fn) => fn());
  }
});
// Waiters parked until the server is reachable again. Bounded: every navigation
// into Movies/Series calls triggerTier3(), so a long offline stretch would
// otherwise park an unbounded number of resolvers — each pinning the async frame
// (and its page data) behind it forever. Past the cap the OLDEST waiter is
// released instead of dropped: its continuation resumes, its request fails
// against the down server, and it unwinds normally.
const MAX_RESUME_WAITERS = 32;
function whenResumed() {
  if (!paused) return Promise.resolve();
  return new Promise((resolve) => {
    resumeWaiters.push(resolve);
    while (resumeWaiters.length > MAX_RESUME_WAITERS) resumeWaiters.shift()();
  });
}

// --- helpers ---------------------------------------------------------------
// Fetch page 1 of a chip view, seed the grid's cache for that filter (so the
// first visit is a cache hit), and return its poster URLs (viewport-first, list
// order). Best-effort: a failure just yields no URLs.
async function warmView(type, status) {
  await whenResumed();
  try {
    const res = await api.mediaPage(type, {
      status,
      genre: DEFAULT_FILTER.genre,
      sort: DEFAULT_FILTER.sort,
      page: 1,
      pageSize: GRID_PAGE_SIZE,
    });
    seedGridPage(type, { status, ...DEFAULT_FILTER }, res);
    return (res.items || []).map((i) => i.poster_url).filter(Boolean);
  } catch {
    return [];
  }
}

function upcomingImages(data) {
  const urls = [];
  for (const w of data.watch_next || []) {
    const u = w.still_url || w.backdrop_url;
    if (u) urls.push(u);
  }
  for (const e of data.upcoming || []) {
    const u = e.still_url || e.backdrop_url || e.poster_url;
    if (u) urls.push(u);
  }
  return urls;
}

// Enqueue URLs at preload priority (deduped, budget-bounded). Returns the
// imageCache.load promises so a caller can wait on a completion threshold.
function preloadUrls(urls) {
  const promises = [];
  for (const url of urls) {
    if (budget <= 0) break;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    budget -= 1;
    promises.push(imageCache.load(url, { preload: true }));
  }
  return promises;
}

// Durably cache a trimmed detail for each Plan-to-Watch title (from the payload
// fetched in Tier 1), so their detail pages open read-only offline. Idempotent,
// capped, paced, abortable — best-effort throughout.
async function warmPlanDetailsDurable(cap = 30) {
  const titles = planTitles;
  if (!Array.isArray(titles) || !titles.length) return;
  try {
    prunePlanDetails(titles.map((t) => t.id));
  } catch {
    /* best-effort */
  }
  let left = cap;
  for (const t of titles) {
    if (left <= 0) break;
    if (getPlanDetail(t.id)) continue; // already cached → no fetch
    await whenResumed();
    left -= 1;
    try {
      const detail = await api.mediaDetail(t.id);
      savePlanDetail(detail);
    } catch (err) {
      if (isAbortError(err)) return; // teardown — stop warming
      /* skip this title; the rest may still cache */
    }
    await delay(TIER2_BATCH_DELAY_MS);
  }
}

// Resolve once `fraction` of the promises have settled, or after `timeoutMs`.
function raceThreshold(promises, fraction, timeoutMs) {
  return new Promise((resolve) => {
    const need = Math.max(1, Math.ceil(promises.length * fraction));
    let done = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const tick = () => {
      done += 1;
      if (done >= need) finish();
    };
    promises.forEach((p) => p.then(tick, tick));
  });
}

// --- Tiers -----------------------------------------------------------------
export const preloader = {
  // Tier 1 — the pages the user lands on right after the splash. Fetches page 1
  // of each default chip view (Movies=Shelved, Series=Watching), What's Next, and
  // Plan to Watch in parallel; resolves when 80% of their images are cached OR
  // after a timeout, so a slow connection / large library can't hold the splash.
  async runTier1() {
    await whenResumed();
    let upImages = [];
    let planImages = [];
    let movieImages = [];
    let showImages = [];
    await Promise.all([
      warmView('movie', DEFAULT_STATUS.movie).then((u) => {
        movieImages = u;
      }),
      warmView('show', DEFAULT_STATUS.show).then((u) => {
        showImages = u;
      }),
      // What's Next — preload its images AND durably persist the Up Next cards.
      api.upcoming().then((d) => {
        upImages = upcomingImages(d);
        saveUpNext(d.watch_next || []);
        saveUpcoming(d); // full payload → "On the Horizon" renders offline after a boot warm
      }, () => {}),
      // Plan to Watch — warms the SW JSON cache + poster images, and persists both
      // types to localStorage so the offline Plan-to-Watch grids render with no
      // prior navigation.
      api.planToWatch().then((d) => {
        planTitles = d.titles || [];
        savePlanTitles(planTitles);
        planImages = planTitles.map((t) => t.poster_url).filter(Boolean);
      }, () => {}),
    ]);

    const urls = [...movieImages, ...showImages, ...upImages, ...planImages];
    const promises = preloadUrls(urls);
    if (!promises.length) return;
    await raceThreshold(promises, TIER1_THRESHOLD, TIER1_TIMEOUT_MS);
  },

  // Tier 2 — the other chip views the user is likely to open soon. Background,
  // lower priority, with a small delay between groups to yield to user requests.
  async runTier2() {
    const combos = [
      ['movie', 'watching'],
      ['movie', 'plan_to_watch'],
      ['movie', 'all'],
      ['show', 'completed'],
      ['show', 'plan_to_watch'],
      ['show', 'all'],
    ];
    for (const [type, status] of combos) {
      await whenResumed();
      preloadUrls(await warmView(type, status)); // fire-and-forget the images
      await delay(TIER2_BATCH_DELAY_MS);
    }
    // Durably warm the read-only offline detail cache for every planned title.
    await warmPlanDetailsDurable();
  },

  // Tier 3 — triggered on navigation into a page: top up the "All" chip for that
  // page so switching to it is instant after the first visit.
  async triggerTier3(page) {
    const type = page === 'movies' ? 'movie' : page === 'series' ? 'show' : null;
    if (!type) return;
    await whenResumed();
    preloadUrls(await warmView(type, 'all'));
  },
};
