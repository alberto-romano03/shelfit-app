// What's Next screen (/upcoming) — an "On the Horizon" railway of soon-airing
// episodes, followed by "Up Next" cards (next unwatched episodes of series in
// progress and episodes airing within the week). The built timeline is retained
// for instant return with scroll preserved; resetUpcoming() forces a refresh.

import { createApi, isAbortError } from '../api.js';
import { navigate, onCleanup } from '../router.js';
import {
  el,
  icons,
  mountPoster,
  skelLine,
  epLabel,
  formatDate,
  crossfadeSwap,
  clear,
  stateBlock,
} from '../ui.js';
import { isServerReachable, markDegraded } from '../network.js';
import { saveUpNext, getUpNext, saveUpcoming, getUpcoming, formatSyncTime } from '../offlineCache.js';
import { t, locale, getLang } from '../i18n.js';
import { userPrefix } from '../userScope.js';

// What's Next is fetched once per session and then served from memory: reopening
// it (from the tab bar too) re-attaches the page built last time, scroll and
// decoded images included, with no skeleton and no request. Two layers:
//   • upcomingDom: the built page itself (SPA navigation);
//   • `session`: the last payload, mirrored in sessionStorage so a page reload in
//     the same session paints instantly too. Wiped when the tab/PWA closes, and
//     kept under the signed-in member's prefix like all their on-device data.
// A library change (an episode marked, a series added or moved to Watching, an
// import…) fires 'shelfit:library-changed', which only marks the copy STALE: the
// next open still paints it at once, then fetches in the background and swaps the
// page only if the content actually changed. If What's Next is on screen at that
// moment it updates in place. A new day rebuilds the page from the saved payload
// (countdowns are computed client-side from air dates) and revalidates it, and a
// copy older than SESSION_FRESH_MS is quietly revalidated too, which catches what
// the server changes on its own (the nightly Kodi sync).
const SESSION_FRESH_MS = 30 * 60 * 1000;
let upcomingDom = null; // { node, scrollY, lang, day, key } | null
let session = null; // { data, at, day, stale, key } | null (key: whose copy it is)
let upcomingToTop = false; // next mount scrolls to the top (a tab-bar tap)
let liveRefresh = null; // set while What's Next is mounted: revalidate in place

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sessionKey() {
  const prefix = userPrefix();
  return prefix ? `${prefix}upcoming` : null;
}
function readSession() {
  const key = sessionKey();
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : null;
    // (ignores the older bare-payload format)
    return v && v.data && typeof v.at === 'number' ? { ...v, key } : null;
  } catch {
    return null; // disabled/private storage or malformed
  }
}
function writeSession(v) {
  const key = sessionKey();
  session = { ...v, key };
  if (!key) return;
  try {
    sessionStorage.setItem(key, JSON.stringify({ data: v.data, at: v.at, day: v.day, stale: v.stale }));
  } catch {
    /* quota / disabled: the in-memory copy still works */
  }
}

// The in-memory copy, only if it belongs to the member signed in now.
function currentSession() {
  if (!session || session.key !== sessionKey()) session = readSession();
  return session;
}

window.addEventListener('shelfit:library-changed', () => {
  const s = currentSession();
  if (s && !s.stale) writeSession({ ...s, stale: true });
  if (liveRefresh) liveRefresh();
});

// Tab-bar tap: show the saved page, from the top. No refetch.
export function resetUpcoming() {
  upcomingToTop = true;
}
// The interface language changed: rebuild the page (its labels) from the saved
// payload on the next mount. The data itself doesn't depend on the UI language.
export function rebuildUpcoming() {
  upcomingDom = null;
}

// A single timeline card skeleton — same shape (thumb + two lines) as a real
// card, sitting on the timeline line via its node.
function skelCardItem() {
  // Mirrors the real card: flush-left image, a two-line text column (series
  // title + episode), and the circular progress ring on the right.
  return el('div', { class: 'tl-item' }, [
    el('div', { class: 'tl-card' }, [
      el('div', { class: 'tl-thumb skeleton' }),
      el('div', { class: 'tl-right' }, [
        el('div', { class: 'tl-body', style: { flex: '1' } }, [
          skelLine({ width: '70%', height: '15px' }),
          skelLine({ cls: 'sm', width: '45%', margin: '8px 0 0' }),
        ]),
        el('div', {
          class: 'skeleton',
          style: { width: '60px', height: '60px', borderRadius: '50%', flexShrink: '0' },
        }),
      ]),
    ]),
  ]);
}

// One railway stop ghost: name line above, a shimmer circle on the rail, a
// countdown line below — mirroring a real stop.
function railStopSkeleton(marginLeft) {
  const stop = el('div', { class: 'railway-stop' }, [
    el('div', { class: 'rail-name' }, [skelLine({ width: '58px', height: '11px' })]),
    el('div', {
      class: 'skeleton',
      style: { width: '20px', height: '20px', borderRadius: '50%', flexShrink: '0' },
    }),
    el('div', { class: 'rail-below' }, [skelLine({ width: '40px', height: '11px', margin: '0 auto' })]),
  ]);
  stop.style.marginLeft = `${marginLeft}px`;
  return stop;
}

function railwaySkeleton() {
  const track = el('div', { class: 'railway-track' });
  for (let i = 0; i < 5; i++) track.append(railStopSkeleton(i === 0 ? 20 : 82));
  track.append(el('div', { class: 'railway-tail' }));
  return el('div', { class: 'railway-section' }, [
    el('div', { class: 'railway-scroller' }, [track]),
  ]);
}

// The full What's Next ghost: "On the Horizon" heading + railway, the "Up Next"
// divider, then the episode cards — matching the real page structure.
function upcomingSkeleton() {
  const timeline = el('div', { class: 'timeline' });
  for (let i = 0; i < 4; i++) timeline.append(skelCardItem());
  return el('div', { class: 'upcoming-view' }, [
    skelLine({ width: '150px', height: '18px', margin: '4px 0 12px' }),
    railwaySkeleton(),
    sectionDivider(t('upcoming.upNext')),
    timeline,
  ]);
}

// "today" / "tomorrow" / "in N days" for a YYYY-MM-DD air date.
function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const diff = Math.round((target - today) / 86400000);
  if (diff <= 0) return t('upcoming.etaToday');
  if (diff === 1) return t('upcoming.etaTomorrow');
  return t('upcoming.etaInDays', { n: diff });
}

function episodeSub(season, episode, title) {
  const label = epLabel(season, episode);
  return title ? `${label} · ${title}` : label;
}

// Watch Next card: next unwatched aired episode of a series in progress. Season
// progress is shown as a compact circle (the horizontal image leaves little room
// for a full-width bar).
function watchNextCard(w) {
  const thumb = mountPoster(el('div', { class: 'tl-thumb' }), w.still_url || w.backdrop_url, w.series_title);
  // The (reused) orange pill carries the SXX EXX label, overlaid low on the
  // preview image (with a dark scrim behind it) so the text column is free for
  // the episode title.
  thumb.classList.add('tl-thumb-ep');
  thumb.append(el('span', { class: 'tl-tag tl-tag-watch tl-ep-badge', text: epLabel(w.season, w.episode) }));

  const pct = w.season_total > 0 ? Math.round((w.season_watched / w.season_total) * 100) : 0;
  // Stacked fraction (watched over total) so even large counts — e.g. 124/1000 —
  // fit inside the ring without overflowing. The divider sits under the total,
  // which is always ≥ watched, so the bar spans the widest number.
  const ring = el(
    'div',
    { class: 'tl-ring', title: t('upcoming.ringTitle', { watched: w.season_watched, total: w.season_total }) },
    [
      el('div', { class: 'tl-ring-frac' }, [
        el('span', { class: 'tl-ring-num', text: String(w.season_watched) }),
        el('span', { class: 'tl-ring-den', text: String(w.season_total) }),
      ]),
    ]
  );
  ring.style.setProperty('--pct', String(pct));

  // Series name leads; the episode title gets the freed space below it.
  const body = [el('div', { class: 'tl-title tl-title-lg', text: w.series_title })];
  if (w.episode_title) body.push(el('div', { class: 'tl-sub', text: w.episode_title }));

  const card = el('div', { class: 'tl-card' }, [
    thumb,
    el('div', { class: 'tl-right' }, [
      el('div', { class: 'tl-body' }, body),
      ring,
    ]),
  ]);

  const item = el('div', { class: 'tl-item tl-watch' }, [card]);
  // Straight to THIS episode's season list (not the general series detail), so
  // the next episode to watch is right there — e.g. S1E3 → that series' Season 1.
  item.addEventListener('click', () => navigate(`/season/${w.item_id}/${w.season}`));
  return item;
}

// Coming Soon card: an episode airing within the next 7 days.
function comingSoonCard(ep) {
  const thumb = mountPoster(el('div', { class: 'tl-thumb' }), ep.backdrop_url || ep.poster_url, ep.series_title);

  const card = el('div', { class: 'tl-card' }, [
    thumb,
    el('div', { class: 'tl-right' }, [
      el('div', { class: 'tl-body' }, [
        el('div', { class: 'tl-tag tl-tag-soon', text: t('upcoming.comingSoon') }),
        el('div', { class: 'tl-title', text: ep.series_title }),
        el('div', { class: 'tl-sub', text: episodeSub(ep.season, ep.episode, ep.episode_title) }),
        el('div', { class: 'tl-when' }, [
          el('span', { class: 'tl-date', text: formatDate(ep.air_date) }),
          el('span', { class: 'tl-eta', text: daysUntil(ep.air_date) }),
        ]),
      ]),
    ]),
  ]);

  const item = el('div', { class: 'tl-item tl-soon' }, [card]);
  item.addEventListener('click', () => navigate(`/detail/${ep.item_id}`));
  return item;
}

// --- "On the Horizon" railway timeline ------------------------------------
const p2 = (n) => String(n).padStart(2, '0');

// Whole-day difference between two YYYY-MM-DD dates (b - a).
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000);
}

// Countdown label under a stop.
function railWhen(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const diff = Math.round((target - today) / 86400000);
  if (diff <= 0) return t('upcoming.railToday');
  if (diff === 1) return t('upcoming.railTomorrow');
  if (diff <= 7) return t('upcoming.railInDays', { n: diff });
  return target.toLocaleDateString(locale('en-US'), { month: 'short', day: 'numeric' });
}

// Full-width divider with a small labelled pill — same language as the
// Movies/Series grid dividers.
function sectionDivider(label) {
  return el('div', { class: 'grid-divider' }, [
    el('span', { class: 'grid-divider-label', text: label }),
  ]);
}

// Build the horizontal railway. Spacing between stops is proportional to the time
// gap between their air dates (clamped so stops never overlap or drift too far).
// Circle size/opacity perspective is CSS-driven (nth-child), not computed here.
// Returns { node, init } — call init() once mounted so the desktop arrows can
// read layout sizes.
function buildHorizonRailway(horizon) {
  const MIN_GAP = 66; // px between consecutive stops (same/near day)
  const MAX_GAP = 168; // px cap so far-apart dates stay reachable
  const PER_DAY = 7; // px added per day of separation
  const START = 20; // short gap from the left edge

  const scroller = el('div', { class: 'railway-scroller' });
  const track = el('div', { class: 'railway-track' });
  scroller.append(track);

  let prevDate = null;
  horizon.forEach((h, i) => {
    let marginLeft = START;
    if (i > 0) {
      const days = Math.max(0, daysBetween(prevDate, h.air_date));
      marginLeft = Math.round(Math.min(MAX_GAP, Math.max(MIN_GAP, MIN_GAP + days * PER_DAY)));
    }
    prevDate = h.air_date;

    const below = [el('div', { class: 'rail-when', text: railWhen(h.air_date) })];
    if (h.season != null && h.episode != null) {
      below.push(el('div', { class: 'rail-ep', text: `S${p2(h.season)}E${p2(h.episode)}` }));
    }
    const stop = el('div', { class: 'railway-stop' }, [
      el('div', { class: 'rail-name' }, [
        el('span', { class: 'rail-name-text', text: h.series_title }),
      ]),
      el('div', { class: 'rail-dot' }),
      el('div', { class: 'rail-below' }, below),
    ]);
    stop.style.marginLeft = `${marginLeft}px`;
    stop.addEventListener('click', () => navigate(`/detail/${h.item_id}`));
    track.append(stop);
  });
  // Trailing spacer so the track line runs visibly past the last stop / viewport.
  track.append(el('div', { class: 'railway-tail' }));

  // Desktop-only arrows (hidden on touch via CSS). Same icon-btn style as the app.
  const leftBtn = el('button', {
    class: 'icon-btn railway-arrow railway-arrow-left',
    'aria-label': t('upcoming.scrollLeft'),
    html: icons.back,
  });
  const rightBtn = el('button', {
    class: 'icon-btn railway-arrow railway-arrow-right',
    'aria-label': t('upcoming.scrollRight'),
    html: icons.back, // flipped horizontally via CSS
  });

  const maxScroll = () => Math.max(0, scroller.scrollWidth - scroller.clientWidth);

  function updateArrows() {
    const max = maxScroll();
    const x = scroller.scrollLeft;
    leftBtn.classList.toggle('is-hidden', x <= 2);
    rightBtn.classList.toggle('is-hidden', x >= max - 2);
  }
  scroller.addEventListener('scroll', updateArrows, { passive: true });
  // The railway is as wide as the window, so a resize changes how much of the
  // track fits and therefore which arrows belong on screen. Observed on the
  // scroller rather than bound to window.resize: this node is retained and
  // re-attached across navigations (upcomingDom), so there is no teardown point
  // for a window listener — the observer simply goes away with the element.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(updateArrows).observe(scroller);
  }

  // Move by roughly a viewport at a time — the desktop railway shows several
  // stops at once, so advancing to "the next stop past the centre" barely moved
  // anything. The landing position is aligned to a stop's left edge (allowing for
  // the 16px mask fade) so the railway never comes to rest mid-title, and always
  // travels at least one stop.
  const EDGE_INSET = 16;
  function scrollToDir(dir) {
    const max = maxScroll();
    const here = scroller.scrollLeft;
    const edges = [...track.querySelectorAll('.railway-stop')].map((s) =>
      Math.min(max, Math.max(0, s.offsetLeft - EDGE_INSET))
    );
    const desired = Math.min(max, Math.max(0, here + dir * scroller.clientWidth * 0.8));
    // Only stops we would actually travel to, so a click can never stand still.
    const ahead = dir > 0 ? edges.filter((e) => e > here + 1) : edges.filter((e) => e < here - 1);
    let target;
    if (desired <= 0 || desired >= max || !ahead.length) {
      target = dir > 0 ? max : 0; // ran out of stops — finish at the end
    } else {
      target = ahead.reduce((best, e) => (Math.abs(e - desired) < Math.abs(best - desired) ? e : best));
    }
    scroller.scrollTo({ left: target, behavior: 'smooth' });
  }
  leftBtn.addEventListener('click', () => scrollToDir(-1));
  rightBtn.addEventListener('click', () => scrollToDir(1));

  const node = el('div', { class: 'railway-section' }, [leftBtn, scroller, rightBtn]);
  return { node, init: updateArrows };
}

// The railway with no stops: the full-width rail stays, so the section keeps its
// place on the page, and a label on the line says nothing new is airing yet.
function emptyHorizonRailway() {
  const track = el('div', { class: 'railway-track railway-track-empty' }, [
    el('span', { class: 'railway-empty-label', text: t('upcoming.horizonEmpty') }),
  ]);
  return el('div', { class: 'railway-section' }, [
    el('div', { class: 'railway-scroller' }, [track]),
  ]);
}

// Build the whole What's Next view node from an upcoming() payload. Structure:
// [On the Horizon railway] → [divider "Up Next"] → [episode cards]. When nothing
// is on the horizon the railway is an empty rail with a "nothing yet" label. Returns
// { content, railway }, where railway (or null) exposes init() for the desktop
// arrows once the node is mounted. Countdown labels are recomputed from each
// air_date here, so a cached payload still shows the correct "in N days".
function buildUpcoming(data) {
  const watchNext = data.watch_next || [];
  const soon = data.upcoming || [];
  const horizon = data.horizon || [];

  let content;
  let railway = null;
  if (!horizon.length && !watchNext.length && !soon.length) {
    content = stateBlock({
      icon: 'popcorn',
      title: t('upcoming.emptyTitle'),
      detail: t('upcoming.emptyDetail'),
    });
  } else {
    content = el('div', { class: 'upcoming-view' });

    content.append(el('h2', { class: 'section-heading', text: t('upcoming.horizon') }));
    if (horizon.length) {
      railway = buildHorizonRailway(horizon);
      content.append(railway.node);
    } else {
      content.append(emptyHorizonRailway());
    }

    content.append(sectionDivider(t('upcoming.upNext')));

    if (watchNext.length || soon.length) {
      const timeline = el('div', { class: 'timeline' });
      for (const w of watchNext) timeline.append(watchNextCard(w));
      for (const ep of soon) timeline.append(comingSoonCard(ep));
      content.append(timeline);
    } else {
      content.append(
        stateBlock({ icon: 'popcorn', title: t('upcoming.nothingNext') })
      );
    }
  }
  return { content, railway };
}

// Offline fallback view: "On the Horizon" is date-dependent so it stays a ghost
// skeleton, while "Up Next" is rendered from the durable cache with a staleness
// note + last-synced label. Not retained (upcomingDom): recovery remounts and
// re-fetches, since markDegraded() flagged the view.
function buildOfflineUpcoming(watchNext, savedAt) {
  const view = el('div', { class: 'upcoming-view' });
  view.append(el('h2', { class: 'section-heading', text: t('upcoming.horizon') }));
  view.append(railwaySkeleton());
  view.append(sectionDivider(t('upcoming.upNext')));
  const when = formatSyncTime(savedAt);
  view.append(
    el('div', {
      class: 'offline-note',
      text: when ? t('upcoming.offlineInfoUpdated', { when }) : t('upcoming.offlineInfo'),
    })
  );
  if (watchNext.length) {
    const timeline = el('div', { class: 'timeline' });
    for (const w of watchNext) timeline.append(watchNextCard(w));
    view.append(timeline);
  } else {
    view.append(
      stateBlock({ icon: 'popcorn', title: t('upcoming.nothingNext') })
    );
  }
  return view;
}
function mountOfflineUpcoming(container, watchNext, savedAt) {
  const view = buildOfflineUpcoming(watchNext, savedAt);
  crossfadeSwap(() => {
    container.innerHTML = '';
    container.append(view);
  });
}

// Offline render from a FRESH durable payload (within the TTL): the full view —
// "On the Horizon" railway included — built with real data. Countdown labels are
// recomputed from each air_date, so they stay correct as the day passes. A small
// staleness note marks it as a saved copy. Not retained (upcomingDom): recovery
// remounts and re-fetches, since markDegraded() flagged the view.
function mountUpcomingOffline(container, data, savedAt) {
  const { content, railway } = buildUpcoming(data);
  const when = formatSyncTime(savedAt);
  content.insertBefore(
    el('div', { class: 'offline-note', text: when ? t('upcoming.savedListUpdated', { when }) : t('upcoming.savedList') }),
    content.firstChild
  );
  crossfadeSwap(() => {
    container.innerHTML = '';
    container.append(content);
  });
  if (railway) requestAnimationFrame(() => railway.init());
}

// Paint a freshly built view into the container and record it for instant return.
// `fade`: crossfade over what is on screen (a revalidation that found changes).
function mountUpcoming(container, data, { fade = true } = {}) {
  const { content, railway } = buildUpcoming(data);
  const swap = () => {
    container.innerHTML = '';
    container.append(content);
  };
  if (fade) crossfadeSwap(swap);
  else swap();
  upcomingDom = { node: content, scrollY: 0, lang: getLang(), day: todayKey(), key: sessionKey() };
  // Arrows need layout sizes, so initialise after the node is in the DOM.
  if (railway) requestAnimationFrame(() => railway.init());
}

export default async function Upcoming(container) {
  const toTop = upcomingToTop;
  upcomingToTop = false;
  const day = todayKey();
  const cached = currentSession();
  const needsFetch =
    !cached || cached.stale || cached.day !== day || Date.now() - cached.at >= SESSION_FRESH_MS;

  // --- Paint: the retained page, else one built from the saved payload, else a
  // skeleton (first open of the session). ---
  let painted = false;
  if (
    cached &&
    upcomingDom &&
    upcomingDom.key === cached.key &&
    upcomingDom.lang === getLang() &&
    upcomingDom.day === day
  ) {
    container.append(upcomingDom.node);
    const y = toTop ? 0 : upcomingDom.scrollY || 0;
    requestAnimationFrame(() => window.scrollTo(0, y));
    painted = true;
  } else if (cached) {
    mountUpcoming(container, cached.data, { fade: false });
    painted = true;
  } else {
    container.append(upcomingSkeleton());
  }

  const ac = new AbortController();
  const api = createApi(ac.signal);

  // Swap the skeleton for the durable offline view when the server is unreachable.
  // Mirrors the Movies/Series grid: we must NOT sit on the skeleton waiting for a
  // fetch that may never resolve (device online but the backend/infra STALLS — no
  // prompt reject). Driven from BOTH the fetch's catch (fast failures: transport
  // error / 5xx) AND the server-change event below (a stall is caught by the
  // health poll, which flips reachability within a few seconds). `done` guards a
  // double render.
  let done = false;
  function showOffline() {
    if (done) return;
    markDegraded(); // recovery re-mounts this view when the server returns
    if (painted) return; // session content already on screen: keep it
    // Prefer the full durable payload while within its TTL: the whole view — "On
    // the Horizon" railway included — renders offline with countdowns recomputed
    // from each air_date. Once stale, fall back to the date-independent Up Next
    // cards only (horizon shown as a ghost).
    const up = getUpcoming();
    if (up && up.fresh && up.data) {
      done = true;
      mountUpcomingOffline(container, up.data, up.savedAt);
      return;
    }
    const upNext = getUpNext();
    if (upNext && upNext.data && upNext.data.length) {
      done = true;
      mountOfflineUpcoming(container, upNext.data, upNext.savedAt);
    }
    // Nothing cached → keep the skeleton; markDegraded() already flagged recovery.
  }

  // Connectivity change → the health poll flips reachability within a few seconds
  // of ANY outage (a stall included, since it never rejects), so this is what
  // swaps the stuck skeleton for the cached view — exactly like the grid does.
  function onServerChange(ev) {
    if (ev.detail && ev.detail.reachable === false) {
      ac.abort(); // drop the (possibly stalled) in-flight fetch
      showOffline();
    }
  }
  window.addEventListener('shelfit:server-change', onServerChange);

  // Fetch, save, and repaint only when the payload differs from what is on
  // screen (so an unchanged What's Next never flashes). One at a time.
  let inflight = null;
  function revalidate() {
    if (inflight) return inflight;
    inflight = (async () => {
      let data;
      try {
        data = await api.upcoming();
      } catch (err) {
        if (isAbortError(err)) return; // navigated away, or aborted on going offline
        if (!isServerReachable()) {
          showOffline();
          return;
        }
        // A real error from a reachable backend, with nothing on screen to keep.
        if (!painted && !done) {
          clear(container);
          container.append(
            stateBlock({
              kind: 'error',
              title: t('upcoming.loadError'),
              error: err.message,
              action: { onClick: () => navigate(location.pathname + location.search, { replace: true }) },
            })
          );
        }
        return;
      }
      done = true;
      const shown = session && session.data;
      writeSession({ data, at: Date.now(), day: todayKey(), stale: false });
      // Durably persist the Up Next cards so they're available offline and after
      // a relaunch (sessionStorage is wiped when the PWA reopens), plus the whole
      // payload so "On the Horizon" also renders offline (within its TTL).
      saveUpNext(data.watch_next || []);
      saveUpcoming(data);
      if (painted && shown && JSON.stringify(shown) === JSON.stringify(data)) return;
      mountUpcoming(container, data, { fade: painted });
      painted = true;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  // While on screen, a library change updates the page in place.
  liveRefresh = () => revalidate();

  // Single teardown for this view: abort the fetch, drop the listeners, and
  // save the scroll position for the next visit.
  onCleanup(() => {
    ac.abort();
    liveRefresh = null;
    window.removeEventListener('shelfit:server-change', onServerChange);
    if (upcomingDom) upcomingDom.scrollY = window.scrollY;
  });

  if (!needsFetch) return; // saved copy is current: no request at all

  // Already offline at mount → show the cached view now instead of waiting on a
  // fetch that would just stall. The fetch still runs; if the server turns out to
  // be reachable it supersedes this with fresh content.
  if (!painted && !isServerReachable()) showOffline();

  await revalidate();
}
