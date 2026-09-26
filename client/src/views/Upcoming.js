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

// Retain the built What's Next timeline (images decoded) so returning to it —
// e.g. back from a title's detail — re-attaches it instantly with the scroll
// position preserved, exactly like the Movies/Series grids. A mutation anywhere
// (marking an episode changes what's next) fires 'shelfit:library-changed',
// which drops it; tapping the What's Next tab (resetUpcoming) forces a refresh.
let upcomingDom = null; // { node, scrollY, lang } | null
let upcomingFresh = false; // next mount should rebuild (manual refresh)

// Second cache layer: the last upcoming() payload, kept in sessionStorage so the
// timeline (On the Horizon railway + Up Next) paints instantly even across a full
// page reload — the in-memory `upcomingDom` above only survives SPA navigation.
// The horizon episodes/series/air-dates rarely change during a day, so the cached
// copy is almost always current and is revalidated by a background fetch. Cleared
// on any library mutation (which can change what's up next) and wiped when the tab
// closes (sessionStorage semantics), so it never goes stale across days.
const SESSION_KEY = 'shelfit:upcoming';
function readSessionUpcoming() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // disabled/private storage or malformed
  }
}
function writeSessionUpcoming(data) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch {
    /* quota / disabled — best-effort */
  }
}
function clearSessionUpcoming() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

window.addEventListener('shelfit:library-changed', () => {
  upcomingDom = null;
  clearSessionUpcoming();
});
export function resetUpcoming() {
  upcomingFresh = true;
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
  return title ? `${label} — ${title}` : label;
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

// Build the whole What's Next view node from an upcoming() payload. Structure:
// [On the Horizon railway] → [divider "Up Next"] → [episode cards]. The railway
// (and its title) is omitted when nothing is on the horizon. Returns
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

    if (horizon.length) {
      content.append(el('h2', { class: 'section-heading', text: t('upcoming.horizon') }));
      railway = buildHorizonRailway(horizon);
      content.append(railway.node);
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
function mountUpcoming(container, data) {
  const { content, railway } = buildUpcoming(data);
  crossfadeSwap(() => {
    container.innerHTML = '';
    container.append(content);
  });
  upcomingDom = { node: content, scrollY: 0, lang: getLang() };
  // Arrows need layout sizes, so initialise after the node is in the DOM.
  if (railway) requestAnimationFrame(() => railway.init());
}

export default async function Upcoming(container) {
  const fresh = upcomingFresh;
  upcomingFresh = false;

  // Retained DOM hit: re-attach the exact timeline built last time and restore
  // scroll — no refetch, no rebuild, no flash.
  if (!fresh && upcomingDom && upcomingDom.lang === getLang()) {
    container.append(upcomingDom.node);
    onCleanup(() => {
      if (upcomingDom) upcomingDom.scrollY = window.scrollY;
    });
    requestAnimationFrame(() => window.scrollTo(0, upcomingDom.scrollY || 0));
    return;
  }

  const ac = new AbortController();
  const api = createApi(ac.signal);

  // Fast paint from the session cache (no skeleton) when we have a recent payload
  // and this isn't a forced refresh. The background fetch below revalidates it.
  const cached = fresh ? null : readSessionUpcoming();
  let painted = false;
  if (cached) {
    const { content, railway } = buildUpcoming(cached);
    container.append(content);
    upcomingDom = { node: content, scrollY: 0, lang: getLang() };
    if (railway) requestAnimationFrame(() => railway.init());
    painted = true;
  } else {
    container.append(upcomingSkeleton());
  }

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
    if (painted) return; // session content already on screen — keep it
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
  // Single teardown for this view: abort the fetch,
  // drop the listener, and save scroll.
  onCleanup(() => {
    ac.abort();
    window.removeEventListener('shelfit:server-change', onServerChange);
    if (upcomingDom) upcomingDom.scrollY = window.scrollY;
  });

  // Already offline at mount → show the cached view now instead of waiting on a
  // fetch that would just stall. The fetch still runs; if the server turns out to
  // be reachable it supersedes this with fresh content.
  if (!painted && !isServerReachable()) showOffline();

  let data;
  try {
    data = await api.upcoming();
  } catch (err) {
    if (isAbortError(err)) return; // navigated away, or aborted on going offline
    if (!isServerReachable()) {
      showOffline();
      return;
    }
    // A real error from a reachable backend, with nothing cached to show.
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

  // Revalidate: refresh the session cache, and repaint only when the fresh
  // payload actually differs from what was painted (so an unchanged day causes no
  // flash). A skeleton (no cache) always swaps in the real content.
  writeSessionUpcoming(data);
  // Durably persist the Up Next cards so they're available offline and after a
  // relaunch (sessionStorage above is wiped when the PWA reopens), plus the whole
  // payload so "On the Horizon" also renders offline (within its TTL).
  saveUpNext(data.watch_next || []);
  saveUpcoming(data);
  if (painted && JSON.stringify(cached) === JSON.stringify(data)) return;
  mountUpcoming(container, data);
}
