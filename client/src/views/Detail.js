// Title detail screen (/detail/:id) — the full page for a movie or show in the
// library: hero, poster with disc/DVD ownership chrome, overview, status,
// rating, notes, series progress/seasons, a "Liner Notes" bento, and Kodi play.
// Edits persist immediately; built views are retained (LRU) for instant return.

import { api, createApi, isAbortError } from '../api.js';
import { navigate, openDetail, onCleanup } from '../router.js';
import { isServerReachable, markDegraded, reportServerSuspect } from '../network.js';
import { savePlanDetail, getPlanDetail, formatSyncTime } from '../offlineCache.js';
import { createRatingControls } from '../ratingControls.js';
import { createStatusSelect } from '../statusSelect.js';
import { isKodiActive, matchKodi } from '../kodi.js';
import { collapsibleText } from '../collapsibleText.js';
import { openImagePicker } from '../imagePicker.js';
import { withBase } from '../basePath.js';
import { confetti } from '../confetti.js';
import { offerShelve } from '../finishSeries.js';
import { openNewTicketModal } from '../cinemaTickets.js';
import { t, locale, getLang } from '../i18n.js';
import {
  el,
  icons,
  poster,
  cachedImg,
  mountPoster,
  setBg,
  skelLine,
  toast,
  openModal,
  openWatchCountModal,
  formatDate,
  crossfadeSwap,
  setLabel,
  fadeSwap,
  lucideIcon,
  clear,
  stateBlock,
  typewriterPlaceholder,
  settingsRow,
} from '../ui.js';

// Who this member can suggest a title to (see openSuggestSheet). Fetched when a
// detail page mounts, so the options menu knows whether to offer the action;
// null until the first answer, and empty when nobody else can sign in.
let suggestRecipients = null;
function loadSuggestRecipients() {
  api
    .suggestRecipients()
    .then((d) => {
      suggestRecipients = (d && d.recipients) || [];
    })
    .catch(() => {
      /* keep the last known list; the menu simply omits the action without one */
    });
}

// Diary-style openers used as a random placeholder each time the notes field is
// built (mirrors the episode-note placeholders on the season page).
const NOTE_PLACEHOLDERS = [
  'detail.notePlaceholder1',
  'detail.notePlaceholder2',
  'detail.notePlaceholder3',
  'detail.notePlaceholder4',
  'detail.notePlaceholder5',
  'detail.notePlaceholder6',
  'detail.notePlaceholder7',
  'detail.notePlaceholder8',
  'detail.notePlaceholder9',
  'detail.notePlaceholder10',
  'detail.notePlaceholder11',
  'detail.notePlaceholder12',
  'detail.notePlaceholder13',
];

// Local calendar date as 'YYYY-MM-DD' (avoids the UTC shift of toISOString()).
function localTodayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// First 10 chars ('YYYY-MM-DD') of a date/datetime string, or '' when absent.
function dateOnly(v) {
  return v ? String(v).slice(0, 10) : '';
}
// A design-system modal with a single native date picker + Confirm/Cancel.
// onConfirm(date) may be async; throw to keep the modal open (the error is
// toasted), or return normally to close it.
function openDateModal({ title, label, value, confirmLabel = t('detail.confirm'), onConfirm }) {
  openModal((modal, close) => {
    const input = el('input', { class: 'text-field', type: 'date', value: value || localTodayISO() });
    const confirm = el('button', { class: 'btn btn-primary' }, [
      lucideIcon('check', 'btn-lucide'),
      el('span', { text: confirmLabel }),
    ]);
    confirm.addEventListener('click', async () => {
      const date = input.value;
      if (!date) return;
      confirm.disabled = true;
      try {
        await onConfirm(date);
        close();
      } catch (err) {
        confirm.disabled = false;
        toast((err && err.message) || t('detail.couldNotSave'), 'bad');
      }
    });
    modal.append(
      el('h3', { text: title }),
      el('div', { class: 'field-label', text: label }),
      input,
      el('hr', { class: 'status-sep' }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.cancel') }),
    ]),
        confirm,
      ])
    );
  });
}

// Retain the fully-built detail DOM per id so returning to it — e.g. back from a
// season's episode list — re-attaches it instantly: no refetch, no rebuild, no
// flash, and the scroll position is preserved. Any mutation anywhere fires
// 'shelfit:library-changed' (see api.js), which clears this, so a change made in
// the season view (marking watched) still rebuilds fresh on return.
//
// LRU-bounded: each entry holds an entire DOM subtree (with a decoded backdrop),
// so without a cap, browsing many titles would grow memory without limit. A Map
// preserves insertion order → oldest key is the least-recently-used.
const DETAIL_DOM_MAX = 12;
const detailDom = new Map(); // id -> { nodes, hero, backdropUrl, scrollY }
window.addEventListener('shelfit:library-changed', () => detailDom.clear());

// Ceiling on the detail load before a stalled fetch falls back to the cached
// copy (see the load below). It must clear the slowest LEGITIMATE response: this
// endpoint reads cached meta from disk, and a cold read on a large title is not
// instant. 500ms did not clear it — an alive-but-busy backend routinely tripped
// the timeout and the app declared itself offline. A real outage does not rely on
// this number at all: a refused connection rejects in milliseconds, and a stalled
// host is caught by the health probe regardless of what this timer does.
const DETAIL_LOAD_TIMEOUT_MS = 2500;

// Open an external URL in a way that never disturbs the shelfIt PWA.
//
// iOS standalone PWA (Add to Home Screen, launched full-screen) is the special
// case: there, window.open('_blank') is intercepted by an in-app Safari view that
// overlays the app, and dismissing it tears down the PWA's navigation context —
// shelfIt reloads from scratch, losing scroll/state. A transient hidden
// <a target="_blank" rel="noopener noreferrer"> that we click and immediately
// remove hands the URL to a SEPARATE Safari session instead, leaving the PWA's
// process untouched, so returning via the app switcher restores it exactly as left.
//
// Detection is window.navigator.standalone === true (iOS-only property; undefined
// elsewhere). Every other platform/browser keeps the plain window.open path.
function openExternal(url) {
  if (typeof navigator !== 'undefined' && navigator.standalone === true) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }
  window.open(url, '_blank', 'noopener noreferrer');
}

// Average of TMDB's episode_run_time array (rounded); null when unknown.
function avgRuntime(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const nums = arr.filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}


// One metadata row: a Lucide icon tightly coupled to its label.
function metaRow(name, text) {
  return el('div', { class: 'meta-row' }, [lucideIcon(name, 'meta-icon'), el('span', { class: 'meta-label', text })]);
}

// --- Bento "Details" section ----------------------------------------------
// Flag emoji from a 2-letter ISO country code (regional indicators). '' if none.
function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return '';
  const A = 0x1f1e6;
  const u = cc.toUpperCase();
  if (u < 'AA' || u > 'ZZ') return '';
  return String.fromCodePoint(A + u.charCodeAt(0) - 65) + String.fromCodePoint(A + u.charCodeAt(1) - 65);
}
// Human name for a language/region code via the built-in Intl API (no deps).
function intlName(code, type) {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([getLang()], { type }).of(type === 'region' ? code.toUpperCase() : code) || '';
  } catch {
    return '';
  }
}
// "$142M" / "$1.2B" etc.; '' when unknown.
function formatMoney(n) {
  if (!n || n <= 0) return '';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1e6) return `$${Math.round(n / 1e6)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
}
function fmtLongDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(y, m - 1, d).toLocaleDateString(locale('en-US'), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
function movieStatus(s) {
  switch (s) {
    case 'Released':
      return { label: t('detail.movieStatus.released'), tone: 'green', icon: 'circle-check' };
    case 'In Production':
      return { label: t('detail.movieStatus.inProduction'), tone: 'orange', icon: 'circle-play' };
    case 'Post Production':
      return { label: t('detail.movieStatus.postProduction'), tone: 'amber', icon: 'circle-play' };
    case 'Planned':
    case 'Rumored':
      return { label: s === 'Planned' ? t('detail.movieStatus.planned') : t('detail.movieStatus.rumored'), tone: 'amber', icon: 'circle-pause' };
    case 'Canceled':
    case 'Cancelled':
      return { label: t('detail.movieStatus.cancelled'), tone: 'red', icon: 'circle-x' };
    default:
      return s ? { label: s, tone: 'grey', icon: 'circle-check' } : null;
  }
}
function showStatus(s) {
  switch (s) {
    case 'Returning Series':
      return { label: t('detail.showStatus.airing'), tone: 'green', icon: 'circle-play' };
    case 'Ended':
      return { label: t('detail.showStatus.ended'), tone: 'grey', icon: 'circle-check' };
    case 'Canceled':
    case 'Cancelled':
      return { label: t('detail.showStatus.cancelled'), tone: 'red', icon: 'circle-x' };
    case 'In Production':
    case 'Planned':
    case 'Pilot':
      return { label: t('detail.showStatus.onHiatus'), tone: 'orange', icon: 'circle-pause' };
    default:
      return s ? { label: s, tone: 'grey', icon: 'circle-check' } : null;
  }
}
// Liner Notes palettes, chosen per title by `tmdb_id % BENTO_PALETTES.length`.
// Each is a dark / mid / light triad (all referencing the global --color-* design
// tokens). `midText` is the text/icon color for the mid cell: the palette's light,
// except where a bright mid (Espresso's clementine, Bark's amber) needs dark text
// to stay legible (verified for contrast).
const BENTO_PALETTES = [
  { dark: 'var(--color-espresso)',  mid: 'var(--color-clementine)', light: 'var(--color-oat-milk)', midText: 'var(--color-espresso)' },
  { dark: 'var(--color-pine-ink)',  mid: 'var(--color-sage)',       light: 'var(--color-mist)',     midText: 'var(--color-mist)' },
  { dark: 'var(--color-plum-ink)',  mid: 'var(--color-iris)',       light: 'var(--color-powder)',   midText: 'var(--color-powder)' },
  { dark: 'var(--color-slate-ink)', mid: 'var(--color-harbor)',     light: 'var(--color-fog)',      midText: 'var(--color-fog)' },
  { dark: 'var(--color-deepsea)',   mid: 'var(--color-teal)',       light: 'var(--color-chalk)',    midText: 'var(--color-chalk)' },
  { dark: 'var(--color-rose-ink)',  mid: 'var(--color-rose)',       light: 'var(--color-shell)',    midText: 'var(--color-shell)' },
  { dark: 'var(--color-bark)',      mid: 'var(--color-amber)',      light: 'var(--color-oat)',      midText: 'var(--color-bark)' },
];
// Set the scoped --bento-* custom properties on a .bento grid, once, from the
// title's tmdb id. Cells then theme themselves purely via their bento-shade-* class.
function applyBentoPalette(grid, tmdbId) {
  const n = BENTO_PALETTES.length;
  const pal = BENTO_PALETTES[(((Number(tmdbId) || 0) % n) + n) % n];
  grid.style.setProperty('--bento-dark', pal.dark);
  grid.style.setProperty('--bento-mid', pal.mid);
  grid.style.setProperty('--bento-light', pal.light);
  grid.style.setProperty('--bento-mid-text', pal.midText);
  return grid;
}

// A bento cell placed into a named grid area. iconName null → no top-left icon
// (the language cell, where the flag is the marker). tone → a soft pastel tint;
// shade ('dark'|'mid'|'light') → the palette role (background + contrasting text).
function bentoCell(area, iconName, primary, secondary, opts = {}) {
  const kids = [];
  if (iconName) kids.push(lucideIcon(iconName, 'bento-icon'));
  kids.push(el('div', { class: 'bento-value', text: primary }));
  if (secondary) kids.push(el('div', { class: 'bento-sub', text: secondary }));
  const cls = ['bento-cell'];
  if (opts.tone) cls.push('bento-tone-' + opts.tone);
  if (opts.shade) cls.push('bento-shade-' + opts.shade);
  if (opts.emphasis) cls.push('bento-emphasis');
  const cell = el('div', { class: cls.join(' ') }, kids);
  cell.style.gridArea = area;
  return cell;
}
function statusCell(st, area = 'status', shade) {
  const s = st || { label: '–', tone: 'grey', icon: 'circle-check' };
  const cls = `bento-cell bento-status bento-status--${s.tone}` + (shade ? ` bento-shade-${shade}` : '');
  const cell = el('div', { class: cls }, [
    lucideIcon(s.icon, 'bento-icon'),
    el('div', { class: 'bento-value', text: s.label }),
    el('div', { class: 'bento-sub', text: t('detail.bento.status') }),
  ]);
  cell.style.gridArea = area;
  return cell;
}
function langCell(langCode, countryCode, secondaryKind) {
  const flag = flagEmoji(countryCode);
  const code = (langCode || '').toUpperCase();
  const primary = [flag, code].filter(Boolean).join(' ') || '–';
  const secondary =
    secondaryKind === 'region' ? intlName(countryCode, 'region') : intlName(langCode, 'language');
  return bentoCell('lang', null, primary, secondary || '', { tone: 'blue', shade: 'light' });
}

function buildMovieBento(meta) {
  const budget = formatMoney(meta.budget);
  const revenue = formatMoney(meta.revenue);
  const cert = (meta.certification || '').trim();

  const cells = [
    // Swapped: production takes the tall box, status takes the wide bottom box.
    // Production name gets a touch more visual weight (emphasis). Palette roles:
    // the big production cell is the dark anchor; director + status are mid; the
    // small detail cells recede in light.
    bentoCell('status', 'clapperboard', meta.production_company || '–', t('detail.bento.production'), { tone: 'teal', emphasis: true, shade: 'dark' }),
    bentoCell('age', 'shield', cert || '–', t('detail.bento.ageRating'), { tone: 'purple', shade: 'light' }),
    langCell(meta.original_language, meta.origin_country, 'language'),
    bentoCell('dir', 'user-round', meta.director || '–', t('detail.bento.director'), { tone: 'pink', shade: 'mid' }),
    statusCell(movieStatus(meta.status), 'prod', 'mid'),
  ];
  // Budget/revenue collapse: either missing → the other fills; both missing →
  // the production cell spans the whole bottom row.
  let variant = 'none';
  if (budget && revenue) {
    variant = 'both';
    cells.push(bentoCell('budget', 'wallet', budget, t('detail.bento.budget'), { tone: 'green', shade: 'light' }));
    cells.push(bentoCell('revenue', 'trending-up', revenue, t('detail.bento.boxOffice'), { tone: 'amber', shade: 'light' }));
  } else if (budget) {
    variant = 'budget';
    cells.push(bentoCell('budget', 'wallet', budget, t('detail.bento.budget'), { tone: 'green', shade: 'light' }));
  } else if (revenue) {
    variant = 'revenue';
    cells.push(bentoCell('revenue', 'trending-up', revenue, t('detail.bento.boxOffice'), { tone: 'amber', shade: 'light' }));
  }
  return el('div', { class: `bento bento--m-${variant}` }, cells);
}

function buildShowBento(meta) {
  const seasons = meta.number_of_seasons || 0;
  const eps = meta.number_of_episodes || 0;
  const seasonsText =
    seasons > 0
      ? `${t('detail.bento.seasonCount', { n: seasons })} · ${t('detail.bento.epCount', { n: eps })}`
      : '–';
  const creators = Array.isArray(meta.created_by) ? meta.created_by.slice(0, 2).join(', ') : '';

  const cells = [
    // Rotated content (boxes unchanged): creators → tall box, seasons → wide box,
    // status → the small box. Palette roles: the big "Created by" cell is the dark
    // anchor; network + release status are mid; the rest recede in light.
    bentoCell('status', 'users', creators || '–', t('detail.bento.createdBy'), { tone: 'orange', shade: 'dark' }),
    bentoCell('network', 'tv', meta.network || '–', t('detail.bento.network'), { tone: 'pink', shade: 'mid' }),
    langCell(meta.original_language, meta.origin_country, 'region'),
    statusCell(showStatus(meta.status), 'seasons', 'mid'),
    bentoCell('creators', 'layers', seasonsText, t('common.seasons'), { tone: 'indigo', shade: 'light' }),
    bentoCell('lastaired', 'calendar-check', fmtLongDate(meta.last_air_date) || '–', t('detail.bento.lastAired'), { tone: 'cyan', shade: 'light' }),
  ];
  return el('div', { class: 'bento bento--tv' }, cells);
}

// The collapsible "Details" section. Returns null when there's essentially no
// data to show (e.g. a cache from before these fields were stored).
function buildBento(d, meta) {
  if (!meta) return null;
  const hasData =
    meta.status ||
    meta.original_language ||
    (d.type === 'movie'
      ? meta.production_company || meta.budget || meta.revenue || meta.certification
      : meta.network || (meta.created_by && meta.created_by.length) || meta.last_air_date);
  if (!hasData) return null;

  const grid = applyBentoPalette(
    d.type === 'movie' ? buildMovieBento(meta) : buildShowBento(meta),
    d.tmdb_id
  );
  // Liner Notes are always fully expanded (no collapse).
  const header = el('div', { class: 'bento-header' }, [
    el('span', { class: 'bento-title' }, [
      el('span', { class: 'section-title', text: t('detail.linerNotes') }),
    ]),
  ]);
  const bodyWrap = el('div', { class: 'bento-body' }, [grid]);
  return el('div', { class: 'bento-section' }, [header, bodyWrap]);
}

// Offline "Liner Notes": only the release/airing status is cached (per the
// offline field set), so the full bento would be mostly em-dashes. Render a
// single status cell in its normal position instead. Null when no status cached.
function buildOfflineBento(d, meta) {
  const st = d.type === 'movie' ? movieStatus(meta.status) : showStatus(meta.status);
  if (!st) return null;
  const header = el('div', { class: 'bento-header' }, [
    el('span', { class: 'bento-title' }, [
      el('span', { class: 'section-title', text: t('detail.linerNotes') }),
    ]),
  ]);
  const grid = applyBentoPalette(
    el('div', { class: 'bento bento--solo' }, [statusCell(st, 'status', 'dark')]),
    d.tmdb_id
  );
  const bodyWrap = el('div', { class: 'bento-body' }, [grid]);
  return el('div', { class: 'bento-section' }, [header, bodyWrap]);
}

function detailSkeleton() {
  const frag = document.createDocumentFragment();
  frag.append(
    el('div', { class: 'detail-hero skeleton' }),
    el('div', { class: 'detail-head' }, [
      // Wrap the poster like the real layout so it's bottom-anchored (sticking up
      // into the hero) instead of overflowing DOWN into the description below.
      el('div', { class: 'detail-poster-wrap' }, [el('div', { class: 'detail-poster skeleton' })]),
      el('div', { class: 'detail-titles' }, [
        skelLine({ width: '75%', height: '22px', margin: '0 0 8px' }),
        skelLine({ width: '50%', height: '14px' }),
        skelLine({ width: '40%', height: '13px', margin: '12px 0 0' }),
      ]),
    ]),
    el('div', { style: { marginTop: '20px' } }, [
      skelLine({ margin: '0 0 8px' }),
      skelLine({ width: '92%', margin: '8px 0' }),
      skelLine({ width: '96%', margin: '8px 0' }),
    ])
  );
  return frag;
}

export default async function Detail(container, params) {
  const id = params.id;

  // Retained DOM hit (e.g. back from a season): re-attach the exact detail built
  // last time and restore scroll — no skeleton, no refetch, no rebuild. Cleared
  // on any mutation, so this only reuses unchanged content.
  const dom = detailDom.get(id);
  if (dom) {
    detailDom.delete(id);
    detailDom.set(id, dom); // LRU: mark most-recently-used
    container.append(...dom.nodes);
    // The backdrop is a background-image blob URL that the imageCache LRU may
    // have revoked while this node was detached; re-resolve it so it never comes
    // back blank (a cache hit is instant; only an evicted one reloads).
    if (dom.hero && dom.backdropUrl) setBg(dom.hero, dom.backdropUrl);
    onCleanup(() => {
      dom.scrollY = window.scrollY;
    });
    requestAnimationFrame(() => window.scrollTo(0, dom.scrollY || 0));
    return;
  }

  const ac = new AbortController();
  onCleanup(() => {
    ac.abort();
    const e = detailDom.get(id); // Map, not a plain object — use .get()
    if (e) e.scrollY = window.scrollY; // save scroll for return
  });
  // Abortable client for the (potentially large) detail load only; every other
  // call uses the module `api`, so mutations complete even after navigate-away
  // and keep working on a re-attached (retained) view.
  const loadApi = createApi(ac.signal);

  container.append(detailSkeleton());
  let d;
  let offline = false; // rendering a cached Plan-to-Watch detail (read-only)
  let savedAt = null; // when that cached copy was last synced
  // /api/media/:id is network-only in the service worker (see public/sw.js), so a
  // STALLED fetch — infra down where the socket neither resolves nor rejects
  // promptly (Caddy holding the connection, the host off, packets silently
  // dropped) — would otherwise hang this skeleton forever. (Device-offline fails
  // fast and already falls back to cache; a stalled infra does not.) Bound it: on
  // timeout, abort and treat the server as unreachable so the same cache fallback
  // runs. A genuine navigation-away abort is told apart by `timedOut`.
  let timedOut = false;
  const loadTimer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, DETAIL_LOAD_TIMEOUT_MS);
  try {
    d = await loadApi.mediaDetail(id);
  } catch (err) {
    if (isAbortError(err) && !timedOut) return; // navigated away — ignore silently
    // A timeout means the server didn't answer in time — which is a REASON TO
    // CHECK, not proof of an outage. Ask for a confirming health probe (the same
    // path a failed request takes in api.js) instead of hard-flipping the whole
    // app offline: a busy-but-alive backend answers the probe and nothing is
    // shown, while a genuinely dead one fails it and the toast appears as before.
    if (timedOut) reportServerSuspect();
    // Fall back to the cached copy on our own local `timedOut` flag rather than
    // waiting on the probe's verdict — this view's degraded render must not
    // depend on a global that a confirming probe has yet to set.
    if (timedOut || !isServerReachable()) {
      const cached = getPlanDetail(id);
      if (cached) {
        d = cached.data;
        offline = true;
        savedAt = cached.savedAt;
      } else {
        markDegraded(); // keep the ghost detail skeleton; recovery re-fetches
        return;
      }
    } else {
      clear(container);
      container.append(
        stateBlock({
          kind: 'error',
          title: t('detail.loadError'),
          error: err.message,
          action: { onClick: () => navigate(location.pathname + location.search, { replace: true }) },
        })
      );
      return;
    }
  } finally {
    clearTimeout(loadTimer);
  }

  // Opportunistically cache a freshly-loaded Plan-to-Watch title so its detail
  // opens offline later, even if the background grid warm hasn't reached it yet.
  if (!offline && d.status === 'plan_to_watch') {
    try {
      savePlanDetail(d);
    } catch {
      /* best-effort */
    }
  }

  const reload = () => navigate(location.pathname, { replace: true });
  const meta = d.meta || {};

  // Visually disable a write control that can't work offline (muted + no pointer
  // events + a tooltip). Native controls also get `disabled` so they never fire.
  function lockOffline(node, tip = t('detail.unavailableOffline')) {
    if (!node) return;
    node.classList.add('offline-locked');
    node.setAttribute('title', tip);
    if ('disabled' in node) node.disabled = true;
  }

  // The options modal's heading uses the title's clear logo; warm it now so the
  // modal never has to wait for it (see preloadLogo). Same for who the title can
  // be suggested to.
  preloadLogo(d);
  loadSuggestRecipients();

  // --- Hero + back ---
  const hero = el('div', { class: 'detail-hero' });
  setBg(hero, d.backdrop_url);
  const backBtn = el('button', {
    class: 'icon-btn icon-btn--overlay',
    html: icons.back,
    'aria-label': t('common.back'),
    style: { position: 'absolute', top: 'calc(8px + env(safe-area-inset-top))', left: '8px', zIndex: 3 },
    onClick: () => history.back(),
  });
  const menuBtn = el('button', {
    class: 'icon-btn icon-btn--overlay',
    html: icons.more,
    'aria-label': t('common.more'),
    style: { position: 'absolute', top: 'calc(8px + env(safe-area-inset-top))', right: '8px', zIndex: 3 },
    onClick: () => openMenu(d, reload),
  });
  hero.append(backBtn, menuBtn);

  // Offline: there's no cached backdrop, so the hero shows the shimmer skeleton.
  // The "saved information" note itself sits between the poster and the
  // description (added to the body below).
  if (offline) hero.classList.add('skeleton');

  // --- Poster + titles --- (shimmer skeleton until the poster decodes; stays on
  // error / offline rather than showing a broken image)
  const posterBox = mountPoster(el('div', { class: 'detail-poster' }), d.poster_url, d.title_it);

  // Physical-ownership CD: layered BENEATH the poster (poster always on top) and
  // revealed when owned. A real Fanart disc is used when cached; otherwise the
  // poster stands in as a disc with hub/hole chrome (the "Back to the Shelf"
  // poster-disc fallback). Outer element handles the slide-up entrance; the inner
  // element carries the endless slow spin so the two transforms never conflict.
  const discSpin = el('div', { class: 'detail-disc-spin' });
  // fanart_v changes when the user replaces the disc art; the route serves it
  // immutable, so without it the browser keeps showing the copy it already has.
  const discSrc = d.disc_available
    ? withBase(`/api/fanart/${d.tmdb_id}?type=${d.type}${d.fanart_v ? `&v=${d.fanart_v}` : ''}`)
    : withBase(d.poster_url);
  discSpin.style.backgroundImage = `url("${discSrc}")`;
  if (!d.disc_available) {
    discSpin.append(el('div', { class: 'detail-disc-hub' }), el('div', { class: 'detail-disc-hole' }));
  }
  const disc = el('div', { class: 'detail-disc' }, [discSpin]);
  // DVD badge temporarily disabled — uncomment to restore
  // DVD logo badge — the logotype SVG from public/icons, tinted white via CSS.
  // Shown above every layer when owned (same transition as the case border).
  // const dvdBadge = el('div', { class: 'dvd-badge' }, [
  //   el('img', { class: 'dvd-badge-img', src: withBase('/icons/DVD_logo.svg'), alt: 'DVD' }),
  // ]);
  const posterWrap = el('div', { class: 'detail-poster-wrap' }, [disc, posterBox]);

  // Metadata as a vertical stack of icon + label rows (Lucide icons, tinted with
  // the secondary text colour via CSS — see .meta-icon).
  const metaRows = [];
  if (meta.year) metaRows.push(metaRow('calendar', String(meta.year)));
  const duration =
    d.type === 'movie'
      ? meta.runtime
        ? t('detail.runtimeMin', { n: meta.runtime })
        : null
      : avgRuntime(meta.episode_run_time)
        ? t('detail.runtimeMin', { n: avgRuntime(meta.episode_run_time) })
        : null;
  if (duration) metaRows.push(metaRow('clock', duration));
  if (meta.genres && meta.genres.length) metaRows.push(metaRow('tag', meta.genres.join(', ')));

  const titles = el('div', { class: 'detail-titles' }, [
    el('h2', { text: d.title_it }),
    d.title_orig && d.title_orig !== d.title_it
      ? el('div', { class: 'orig', text: d.title_orig })
      : null,
    el('div', { class: 'detail-meta' }, metaRows),
    d.type === 'show' && d.cached_at
      ? el('div', { class: 'detail-updated', text: t('detail.dataUpdated', { date: formatDate(d.cached_at) }) })
      : null,
  ]);

  const head = el('div', { class: 'detail-head' }, [posterWrap, titles]);

  // --- Overview (smart-truncated preview, height-animated) ---
  // The short preview is computed once (natural sentence boundary; see
  // truncate.js). "Show more"/"Show less" swap between the preview and the full
  // text with the same smooth max-height animation.
  const body = el('div', {});
  if (offline) {
    const when = formatSyncTime(savedAt);
    body.append(
      el('div', {
        class: 'detail-offline-line',
        text: when ? t('detail.offlineSavedUpdated', { when }) : t('detail.offlineSaved'),
      })
    );
  }
  if (meta.overview) body.append(...collapsibleText(meta.overview));

  // --- Status: shared selector (button + chooser). Persists on select; on a
  // failed save the chooser stays open and the value is unchanged. ---
  const statusControl = createStatusSelect({
    status: d.status,
    onSelect: async (key) => {
      try {
        await api.updateMedia(id, { status: key });
      } catch (err) {
        toast(err.message, 'bad');
        throw err; // keep the chooser open, leave the button unchanged
      }
      d.status = key;
      updateCompletion();
      renderRewatch(); // show/hide the movie rewatch control with completion
      toast(t('detail.statusUpdated'), 'ok');
    },
  });
  const statusBtn = statusControl.element;

  // --- Physical ownership toggle (optimistic UI, saves immediately) ---
  const DISC_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/></svg>';
  const ownedBtn = el('button', { class: 'toggle-wide owned-toggle' });
  function renderOwned() {
    const on = !!d.owned;
    ownedBtn.classList.toggle('active', on);
    ownedBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    ownedBtn.innerHTML = `${DISC_ICON}<span>${on ? t('detail.ownedOnDisc') : t('detail.markOwned')}</span>`;
    // Compound poster classes drive the CD reveal + DVD-box styling (see CSS).
    posterWrap.classList.toggle('owned', on);
    posterBox.classList.toggle('owned', on);
    head.classList.toggle('owned', on);
  }
  renderOwned();
  ownedBtn.addEventListener('click', async () => {
    const next = !d.owned;
    d.owned = next; // optimistic
    renderOwned();
    try {
      await api.updateMedia(id, { owned: next });
    } catch (err) {
      d.owned = !next; // revert on failure
      renderOwned();
      toast(err.message, 'bad');
    }
  });

  // --- Watched in Cinema toggle (MOVIES ONLY) ---
  // When active it illuminates in a warm popcorn red, distinct from the amber of
  // the Owned toggle. The flag rides the same PATCH /api/media/:id as `owned`.
  // Turning it ON opens the "New ticket" popup and only lights up once the ticket
  // is added (Cancel leaves it off). Tapping it while ON opens the same popup as
  // "Edit ticket", prefilled, where the ticket can be saved or removed.
  const TICKET_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>';
  const cinemaBtn = el('button', { class: 'toggle-wide cinema-toggle' });
  function renderCinema() {
    const on = !!d.watched_in_cinema;
    cinemaBtn.classList.toggle('active', on);
    cinemaBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    cinemaBtn.innerHTML = `${TICKET_ICON}<span>${t('detail.seenInCinema')}</span>`;
  }
  if (d.type === 'movie') {
    renderCinema();
    cinemaBtn.addEventListener('click', () => {
      const editing = !!d.watched_in_cinema;
      openNewTicketModal({
        movie: {
          id,
          tmdbId: d.tmdb_id,
          title: d.title_it,
          backdropPath: d.backdrop_url,
          releaseDate: (d.meta && d.meta.release_date) || null,
        },
        existing: editing
          ? { cinemaDate: d.cinema_date, cinemaTime: d.cinema_time, cinemaName: d.cinema_name }
          : null,
        // Screening details first, then the flag: if the flag fails, the
        // movie is simply not a ticket yet and the popup stays open to retry.
        onConfirm: async (screening) => {
          await api.updateCinema(id, screening);
          if (!editing) await api.updateMedia(id, { watched_in_cinema: true });
          d.cinema_date = screening.cinema_date;
          d.cinema_time = screening.cinema_time;
          d.cinema_name = screening.cinema_name;
          d.watched_in_cinema = true;
          renderCinema();
        },
        // Clearing the flag drops the movie from My Tickets; its screening
        // details stay stored, as before.
        onRemove: async () => {
          await api.updateMedia(id, { watched_in_cinema: false });
          d.watched_in_cinema = false;
          renderCinema();
        },
      });
    });
  }

  // --- Rating stars + heart (shared component; persists on tap) ---
  const ratingControls = createRatingControls({
    rating: d.rating,
    favorite: d.favorite,
    // Title is rendered separately as a `.section-title` (matching the Progress /
    // Liner Notes headings) instead of the component's small centered field-label.
    onRate: (r) => api.updateMedia(id, { rating: r }),
    onFavorite: (next) => api.updateMedia(id, { favorite: next }),
    onError: (msg) => toast(msg, 'bad'),
    onChange: (s) => {
      d.rating = s.rating;
      d.favorite = s.favorite;
    },
  });
  const ratingTitle = el('div', { class: 'section-title', text: t('common.rating') });
  const ratingWrap = ratingControls.element;

  // --- Watch date (movies) — calendar-icon prefixed field ---
  const completionLine = el('div', { class: 'watch-date' });
  function updateCompletion() {
    if (d.type === 'movie' && d.status === 'completed') {
      completionLine.innerHTML = '';
      completionLine.append(
        el('span', { class: 'cal-icon', html: icons.calendar }),
        el('span', { text: t('detail.watchedOn', { date: formatDate(d.watch_date || d.updated_at) }) })
      );
      completionLine.style.display = '';
    } else {
      completionLine.innerHTML = '';
      completionLine.style.display = 'none';
    }
  }
  updateCompletion();

  // --- Movie watch-date + rewatch controls (completed movies only) ---
  const rewatchWrap = el('div', { class: 'rewatch-wrap' });
  function renderRewatch() {
    rewatchWrap.innerHTML = '';
    if (d.type !== 'movie' || d.status !== 'completed') {
      rewatchWrap.style.display = 'none';
      return;
    }
    rewatchWrap.style.display = '';
    const times = (d.rewatch_count || 0) + 1;

    // Edit the first-watch date retroactively (so the movie lands in the right
    // monthly receipt); optimistically updates the "Watched on" line.
    const editDateBtn = el('button', { class: 'link-btn', text: t('detail.editDate') });
    editDateBtn.addEventListener('click', () => {
      openDateModal({
        title: t('detail.editWatchDate'),
        label: t('detail.editWatchDateLabel'),
        value: d.watch_date || dateOnly(d.updated_at),
        onConfirm: async (date) => {
          const prev = d.watch_date;
          d.watch_date = date; // optimistic
          updateCompletion();
          try {
            await api.setWatchDate(id, date);
            toast(t('detail.watchDateUpdated'), 'ok');
          } catch (err) {
            d.watch_date = prev; // revert
            updateCompletion();
            throw err;
          }
        },
      });
    });

    // Add rewatch → the −/+ stepper sets the total times watched (min 1), with a
    // date picker underneath for the added rewatch. The stepper delta is applied
    // as dated add/remove events (each keeps rewatch_count in lockstep), so the
    // familiar count mechanism still drives the number while every rewatch gets a
    // date for the receipt.
    const addBtn = el('button', { class: 'link-btn', text: t('detail.addRewatch') });
    addBtn.addEventListener('click', () => {
      openWatchCountModal({
        title: t('detail.timesWatched'),
        count: times,
        min: 1,
        showDate: true,
        confirmLabel: t('detail.confirm'),
        onConfirm: async (newTimes, date) => {
          const delta = Math.max(0, newTimes - 1) - (d.rewatch_count || 0);
          if (!delta) return;
          try {
            if (delta > 0) {
              for (let k = 0; k < delta; k++) {
                const res = await api.addRewatch(id, date);
                if (res && typeof res.rewatch_count === 'number') d.rewatch_count = res.rewatch_count;
              }
            } else {
              // Remove the newest rewatch events (list is newest-first).
              const { rewatches = [] } = await api.rewatches(id);
              for (const r of rewatches.slice(0, -delta)) {
                const res = await api.deleteRewatch(id, r.id);
                if (res && typeof res.rewatch_count === 'number') d.rewatch_count = res.rewatch_count;
              }
            }
            toast(delta > 0 ? t('detail.rewatchAdded') : t('detail.rewatchRemoved'), 'ok');
          } finally {
            renderRewatch();
          }
        },
      });
    });

    rewatchWrap.append(
      el('span', {
        class: 'rewatch-count',
        text: t('detail.watchedTimes', { n: times }),
      }),
      el('div', { class: 'rewatch-actions' }, [editDateBtn, addBtn])
    );
  }
  renderRewatch();

  // --- Notes (always the last editable field) ---
  const notePlaceholder = t(NOTE_PLACEHOLDERS[Math.floor(Math.random() * NOTE_PLACEHOLDERS.length)]);
  const notes = el('textarea', { class: 'notes' });
  notes.value = d.notes || '';
  // Type the diary-opener placeholder out letter by letter once it scrolls into
  // view — a small "someone's writing" flourish. Stops on cleanup / first keypress.
  onCleanup(typewriterPlaceholder(notes, notePlaceholder));
  notes.addEventListener('blur', async () => {
    if (notes.value === (d.notes || '')) return;
    try {
      await api.updateMedia(id, { notes: notes.value });
      d.notes = notes.value;
      toast(t('detail.notesSaved'), 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
  const notesWrap = el('div', { class: 'notes-wrap' }, [
    el('div', { class: 'field-label', text: t('detail.notes') }),
    notes,
  ]);

  // --- Play on Kodi (digital) + Owned (physical) action pair ---
  // The Kodi button sits to the LEFT of the ownership toggle in a shared row,
  // branded with the Kodi logo. It appears only once a match is confirmed;
  // until then the owned toggle takes the full row width, so a disabled /
  // offline / unmatched Kodi leaves no trace.
  const kodiBtn = el('button', { class: 'kodi-play-btn' });
  kodiBtn.innerHTML =
    `<img class="kodi-logo-img" src="${withBase('/icons/kodi.svg')}" alt="" aria-hidden="true"><span>${t('detail.playOnKodi')}</span>`;
  const kodiSlot = el('div', { class: 'kodi-slot' });
  const kodiFeedback = el('div', { class: 'kodi-feedback' });
  // Movies get a two-row action area: [status | Kodi] then [Owned | Cinema].
  // Shows keep the original single row [Kodi | Owned] under the full-width status
  // button. `actionsRow` always holds the Kodi slot, so checkKodi() targets it.
  const isMovie = d.type === 'movie';
  const actionsRow = isMovie
    ? el('div', { class: 'detail-actions-row' }, [
        el('div', { class: 'status-slot' }, [statusBtn]),
        kodiSlot,
      ])
    : el('div', { class: 'detail-actions-row' }, [kodiSlot, ownedBtn]);
  const cinemaRow = isMovie
    ? el('div', { class: 'detail-actions-row' }, [ownedBtn, cinemaBtn])
    : null;
  async function checkKodi() {
    if (!isKodiActive()) return; // disabled / offline → skip the match entirely
    // Load-time GET → abortable client, so a quick navigate-away cancels it.
    const kodiId = await matchKodi(d.tmdb_id, d.type, loadApi);
    if (kodiId == null) return; // not in Kodi's library → button never appears
    kodiBtn.addEventListener('click', async () => {
      kodiFeedback.textContent = t('detail.playingOnKodi');
      kodiFeedback.className = 'kodi-feedback show';
      try {
        await api.kodiPlay(kodiId, d.type);
        window.setTimeout(() => kodiFeedback.classList.remove('show'), 2000);
      } catch (err) {
        if (isAbortError(err)) return;
        kodiFeedback.textContent = err.message || t('detail.kodiPlayFailed');
        kodiFeedback.className = 'kodi-feedback show kodi-fail';
        window.setTimeout(() => kodiFeedback.classList.remove('show'), 3000);
      }
    });
    kodiSlot.append(kodiBtn);
    actionsRow.classList.add('has-kodi');
  }

  // "Watched on…" sits right after the overview's Show more toggle and just
  // before the action area; rating follows. For movies the status button lives
  // inside the first action row (with Kodi), and a second row holds Owned +
  // Cinema; for shows the status button stays full-width above the Kodi/Owned row.
  if (isMovie) {
    body.append(completionLine, rewatchWrap, actionsRow, cinemaRow, kodiFeedback, ratingTitle, ratingWrap);
  } else {
    body.append(completionLine, rewatchWrap, statusBtn, actionsRow, kodiFeedback, ratingTitle, ratingWrap);
  }

  // --- Series progress + seasons ---
  if (d.type === 'show' && d.progress) {
    const p = d.progress;
    body.append(
      el('div', { class: 'section-title', text: t('detail.progress') }),
      el('div', { class: 'muted', text: t('detail.progressWatched', { watched: p.watched_episodes, total: p.total_episodes, percent: p.percent }) }),
      el('div', { class: 'progress-bar' }, [el('div', { style: { width: `${p.percent}%` } })])
    );

    const seasonsWrap = el('div', {});
    for (const s of p.seasons) {
      const item = el('div', { class: 'season-item' });
      const header = el('div', { class: 'season-header' }, [
        el('div', {}, [
          el('div', { class: 's-name', text: s.name }),
          el('div', { class: 's-count', text: t('detail.seasonEpisodes', { watched: s.watched, total: s.total }) }),
        ]),
        el('button', {
          class: 'link-btn',
          text: t('detail.markAllWatched'),
          onClick: async (e) => {
            e.stopPropagation();
            try {
              const res = await api.markSeason(id, s.season_number);
              toast(t('detail.seasonMarked'), 'ok');
              if (res.caught_up) confetti.trigger(); // finished the last available episode
              reload();
              offerShelve(res, { id, onShelved: reload });
            } catch (err) {
              toast(err.message, 'bad');
            }
          },
        }),
      ]);
      header.addEventListener('click', () => navigate(`/season/${id}/${s.season_number}`));
      item.append(header);
      if (p.current_season === s.season_number && p.episodes_left > 0) {
        item.append(
          el('div', {
            class: 'season-left-hint',
            text: t('detail.episodesLeft', { n: p.episodes_left, season: s.name }),
          })
        );
      }
      seasonsWrap.append(item);
    }
    body.append(el('div', { class: 'section-title', text: t('common.seasons') }), seasonsWrap);
  }

  // Collapsible "Details" bento — below the description/sections, above notes.
  // Offline only the status is cached, so render the slim single-cell variant.
  const bentoSection = offline ? buildOfflineBento(d, meta) : buildBento(d, meta);
  if (bentoSection) body.append(bentoSection);

  // Tagline — a cinematic quote floating directly below the Liner Notes (movies
  // and series alike). Omitted entirely when absent; wrapped in curly quotes.
  if (meta && meta.tagline && meta.tagline.trim()) {
    body.append(
      el('div', { class: 'detail-tagline', text: `“${meta.tagline.trim()}”` })
    );
  }

  // --- View on TMDB (external link) ---
  // Styled like the Owned/Cinema toggles but permanently in the "active" state
  // (it's a link, not a toggle) with the TMDB brand accent instead of the app's
  // orange. Shown for every title regardless of library status; opens the TMDB
  // page in a new tab without navigating away. The logo asset is a local static
  // file (public/icons/tmdb/) — never fetched from TMDB at runtime.
  const tmdbUrl = `https://www.themoviedb.org/${d.type === 'movie' ? 'movie' : 'tv'}/${d.tmdb_id}`;
  const tmdbBtn = el('button', {
    class: 'toggle-wide tmdb-toggle active',
    type: 'button',
    'aria-label': t('detail.viewOnTmdbAria'),
  });
  tmdbBtn.innerHTML =
    `<img class="tmdb-logo-img" src="${withBase('/icons/tmdb/tmdb-logo.svg')}" alt="" aria-hidden="true"><span>${t('detail.viewOnTmdb')}</span>`;
  tmdbBtn.addEventListener('click', () => openExternal(tmdbUrl));
  body.append(tmdbBtn);

  // Notes is always the last editable field (below the collection row).
  body.append(notesWrap);

  // Offline (cached Plan-to-Watch): every write control is visually disabled —
  // nothing here can persist without the server.
  if (offline) {
    lockOffline(menuBtn);
    lockOffline(statusBtn);
    lockOffline(ownedBtn);
    if (isMovie) lockOffline(cinemaBtn);
    lockOffline(ratingWrap);
    lockOffline(notes);
  }

  // Crossfade the skeleton out and the real content in (built while the skeleton
  // was still showing, so it's ready in the DOM before the skeleton disappears).
  crossfadeSwap(() => {
    container.innerHTML = '';
    container.append(hero, head, body);
  });

  // A read-only offline render isn't retained as the canonical DOM (it lacks the
  // full data and its controls are locked); instead, re-fetch the live detail the
  // moment the server is reachable again.
  if (offline) {
    const onBack = (ev) => {
      if (ev.detail && ev.detail.reachable) reload();
    };
    window.addEventListener('shelfit:server-change', onBack);
    // Registered in addition to the abort/scroll teardown above — the router runs
    // every registered cleanup, so this listener is dropped on navigate-away.
    onCleanup(() => window.removeEventListener('shelfit:server-change', onBack));
    return;
  }

  // Retain the built DOM (posters decoded, sections resolved) so returning
  // re-attaches it instantly instead of rebuilding. Any later in-place additions
  // (Kodi button, collection row) mutate `body`, which is one of these nodes, so
  // they're captured too. Evict the least-recently-used once over the cap.
  detailDom.set(id, { nodes: [hero, head, body], hero, backdropUrl: d.backdrop_url, scrollY: 0 });
  while (detailDom.size > DETAIL_DOM_MAX) {
    detailDom.delete(detailDom.keys().next().value);
  }

  // Background Kodi match — non-blocking, populates the Play button if found.
  checkKodi();

  // --- "More from this Collection" (movies in a TMDB collection) ---
  // loadApi (abortable) so the background collection fetch is cancelled if the
  // user navigates away before it resolves.
  const btc = d.type === 'movie' && meta ? meta.belongs_to_collection : null;
  if (btc && btc.id) {
    renderCollectionSection(loadApi, body, notesWrap, btc, d);
  }
}

// Fetch the collection asynchronously and append a horizontal row of the other
// films. Non-blocking: nothing is shown if the collection has no siblings.
// `api` is the page's abort-bound client so the fetch is cancelled on navigate.
// Exported so the no-add Preview view can render the same section.
export async function renderCollectionSection(api, body, anchor, btc, d) {
  let coll;
  try {
    coll = await api.collectionDetail(btc.id);
  } catch {
    return; // includes AbortError on navigate-away
  }
  const others = (coll.parts || []).filter((p) => String(p.tmdb_id) !== String(d.tmdb_id));
  if (!others.length) return;

  const row = el('div', { class: 'coll-row' });
  for (const p of others) {
    const cell = el('div', { class: 'coll-row-cell' });
    const card = poster(p.poster_url, p.title);
    card.classList.add('coll-row-poster');
    // Watched indicator: a white eye on an orange badge, bottom-left, always on
    // top of the art. Only for titles the user has completed; everything else is
    // a clean poster.
    if (p.status === 'completed') {
      card.append(
        el('div', { class: 'watched-badge', html: icons.eye, 'aria-label': t('common.watched') })
      );
    }
    // Tap opens the full detail view directly — no modal, no auto-add. Owned
    // titles open their real detail; a title not in the library opens a no-add
    // preview of the same detail view (with an Add option there).
    card.addEventListener('click', () => openCollectionTitle(p));
    cell.append(
      card,
      el('div', { class: 'coll-row-title', text: p.title }),
      el('div', { class: 'coll-row-year', text: p.year || '' })
    );
    row.append(cell);
  }

  body.insertBefore(el('div', { class: 'section-title', text: t('detail.moreFromCollection') }), anchor);
  body.insertBefore(row, anchor);
}

// Open a collection sibling's full detail — no modal, no auto-add. Owned titles
// go to their real detail; a title not in the library opens a no-add preview of
// the same detail view, where the user can add it if they want.
export function openCollectionTitle(p) {
  openDetail(p.item_id ? `/detail/${p.item_id}` : `/preview/movie/${p.tmdb_id}`);
}

// --- "Add to list" sheet ---------------------------------------------------
// "Lend to…" (a title suggestion, told as lending a DVD): one row per member who
// can receive it; tapping a row sends it, and they are offered the loan as a
// popup the next time they open the app.
function openSuggestSheet(d) {
  openModal((modal, close) => {
    const rows = (suggestRecipients || []).map((r) => {
      // Not an async handler on purpose: the row would clear its trailing slot
      // when the promise settles, wiping the "Sent" mark.
      const row = settingsRow({
        icon: 'user-round',
        label: r.display_name,
        onClick: ({ report }) => {
          row.setDisabled(true);
          api
            .suggest(r.id, d.type, d.tmdb_id)
            // Held for as long as the sheet can reasonably stay open (a 0 hold
            // would clear it at once).
            .then(() => report(t('suggest.sent'), 10 * 60 * 1000))
            .catch((err) => {
              row.setDisabled(false);
              toast(err.message || t('suggest.failed'), 'bad');
            });
        },
      });
      return row.el;
    });
    modal.append(
      el('h3', { text: t('detail.suggest') }),
      el('div', { class: 'muted', text: t('suggest.sheetSub', { title: d.title_it }) }),
      el('div', { class: 'suggest-recipients' }, rows),
      el('hr', { class: 'status-sep' }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-secondary', onClick: close }, [
          lucideIcon('x', 'btn-lucide'),
          el('span', { text: t('common.close') }),
        ]),
      ])
    );
  });
}

function openAddToListSheet(d) {
  openModal((modal, close) => {
    modal.append(el('h3', { text: t('detail.addToList') }));
    const listWrap = el('div');
    modal.append(listWrap);

    async function load() {
      listWrap.innerHTML = '';
      let data;
      try {
        data = await api.lists(`?type=${d.type}&tmdbId=${d.tmdb_id}`);
      } catch {
        listWrap.append(
          stateBlock({
            kind: 'error',
            tier: 'inline',
            title: t('detail.listsLoadError'),
            action: { onClick: () => load() },
          })
        );
        return;
      }
      const lists = data.lists || [];
      if (!lists.length) {
        listWrap.append(el('div', { class: 'muted', text: t('detail.noLists') }));
      }
      for (const l of lists) {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = !!l.contains;
        cb.addEventListener('change', async () => {
          try {
            if (cb.checked) await api.addListItem(l.id, d.tmdb_id);
            else await api.removeListItem(l.id, d.tmdb_id);
          } catch (err) {
            cb.checked = !cb.checked;
            toast(err.message || t('detail.failed'), 'bad');
          }
        });
        // Settings-style row: name + muted count on the left, the app's iOS toggle
        // on the right — the same control language as every other on/off row.
        const row = el('div', { class: 'settings-row' }, [
          el('div', {}, [
            el('span', { text: l.name }),
            el('span', { class: 'muted', style: { marginLeft: '8px' }, text: String(l.count) }),
          ]),
          el('label', { class: 'switch' }, [cb, el('span', { class: 'slider' })]),
        ]);
        listWrap.append(row);
      }
    }

    // "New list" shortcut
    const nameInput = el('input', { class: 'text-field', placeholder: t('detail.newListName') });
    const createBtn = el('button', { class: 'btn btn-primary' }, [
      lucideIcon('plus', 'btn-lucide'),
      el('span', { text: t('detail.createAndAdd') }),
    ]);
    createBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) {
        toast(t('detail.enterName'));
        return;
      }
      createBtn.disabled = true;
      try {
        const res = await api.createList(name, d.type);
        await api.addListItem(res.id, d.tmdb_id);
        nameInput.value = '';
        toast(t('detail.listCreated'), 'ok');
        await load();
      } catch (err) {
        toast(err.message || t('detail.failed'), 'bad');
      } finally {
        createBtn.disabled = false;
      }
    });

    modal.append(
      el('hr', { class: 'status-sep' }),
      el('div', { class: 'field-label', text: t('detail.newList') }),
      el('div', { class: 'stack' }, [nameInput, createBtn]),
      el('hr', { class: 'status-sep' }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('check', 'btn-lucide'),
      el('span', { text: t('common.done') }),
    ]),
      ])
    );
    load();
  });
}

// --- "···" menu -----------------------------------------------------------
// The options modal's heading: the title's clear logo when Fanart.tv has one,
// otherwise the plain text title. The text is what renders first and the logo
// fades in over it only once it has actually loaded, so a title with no logo
// never flashes an empty box. Both live in a fixed-height row, so the swap
// cannot move the bento cells below.
function logoUrl(d) {
  return withBase(`/api/logo/${d.tmdb_id}?type=${d.type}`);
}

// Warm the logo as soon as the detail page opens, so the options modal has it in
// the browser cache the moment it is built and the heading is right on the first
// frame instead of fading in a beat later. First visit to a title is also what
// makes the server fetch and cache it; after that both caches answer instantly.
// Fire and forget: a miss is a 404 and simply leaves the text title in place.
function preloadLogo(d) {
  if (!d || !d.tmdb_id) return;
  const img = new Image();
  img.decoding = 'async';
  img.src = logoUrl(d);
}

function menuHeading(d) {
  const text = el('h3', { class: 'menu-title-text', text: d.title_it });
  const head = el('div', { class: 'menu-title' }, [text]);

  // Decorative: the <h3> is only faded out, not removed, so it stays the
  // accessible name and the title is not announced twice.
  const logo = el('img', {
    class: 'menu-title-logo',
    alt: '',
    'aria-hidden': 'true',
    src: logoUrl(d),
  });
  // A 404 means the title has no logo, which is the common case; nothing is
  // logged and nothing changes on screen.
  logo.addEventListener('error', () => logo.remove());
  logo.addEventListener('load', () => head.classList.add('has-logo'));
  head.append(logo);
  // Already in the browser cache from preloadLogo(): mark it before the row is
  // ever painted, so the logo is simply there rather than transitioning in.
  if (logo.complete && logo.naturalWidth > 0) head.classList.add('has-logo');
  return head;
}

function openMenu(d, reload) {
  openModal((modal, close) => {
    // Same bento language as the status selector: each action is a cell with a
    // Lucide icon top-left and label bottom-left. Destructive actions carry a
    // muted-red tint (icon + label only, no filled background).
    // Even rows: the two metadata actions, the two destructive ones, then the
    // library ones (the favourite cell is appended after this list and spans the
    // row when the count is odd).
    const actions = [
      {
        icon: 'images',
        label: t('detail.customizeMetadata'),
        onClick: (_c, cl) => {
          cl();
          openImagePicker(d, api, reload);
        },
      },
      {
        icon: 'refresh-cw',
        label: t('detail.refreshMetadata'),
        onClick: async (c, cl) => {
          c.disabled = true;
          try {
            await api.refreshItem(d.type, d.tmdb_id);
            toast(t('detail.metadataRefreshed'), 'ok');
            cl();
            reload();
          } catch (err) {
            c.disabled = false;
            toast(err.message, 'bad');
          }
        },
      },
      {
        icon: 'eraser',
        label: t('detail.clearCache'),
        danger: true,
        onClick: async (_c, cl) => {
          try {
            await api.clearItemCache(d.type, d.tmdb_id);
            toast(t('detail.cacheCleared'), 'ok');
            cl();
          } catch (err) {
            toast(err.message, 'bad');
          }
        },
      },
      {
        icon: 'trash-2',
        label: t('common.remove'),
        danger: true,
        onClick: async (_c, cl) => {
          if (!confirm(t('detail.confirmRemove'))) return;
          try {
            await api.deleteMedia(d.id);
            cl();
            toast(t('detail.removed'), 'ok');
            navigate(d.type === 'movie' ? '/movies' : '/series');
          } catch (err) {
            toast(err.message, 'bad');
          }
        },
      },
      {
        icon: 'list-plus',
        label: t('detail.addToList'),
        onClick: (_c, cl) => {
          cl();
          openAddToListSheet(d);
        },
      },
    ];
    // Suggest this title to another member, offered only when someone else in
    // the household can sign in.
    if (suggestRecipients && suggestRecipients.length) {
      actions.push({
        icon: 'send',
        label: t('detail.suggest'),
        onClick: (_c, cl) => {
          cl();
          openSuggestSheet(d);
        },
      });
    }

    const grid = el('div', { class: 'status-bento menu-bento' });
    actions.forEach((a) => {
      const cell = el('button', { class: 'status-cell' + (a.danger ? ' danger' : '') }, [
        lucideIcon(a.icon, 'status-ico'),
        el('span', { class: 'status-cell-label', text: a.label }),
      ]);
      cell.addEventListener('click', () => a.onClick(cell, close));
      grid.append(cell);
    });
    // The favourite cell is appended below, so the row count is actions + 1. An
    // odd total would leave a gap, and the favourite cell spans to close it; the
    // five actions above plus the favourite already fill three even rows.

    // "The Wall" favourite toggle — one cell, movie OR show depending on what
    // this page is showing. Always full width, below Clear cache / Remove, in
    // gold. The current pick is fetched when the menu opens, so the label starts
    // as "Set as…" and flips to "Remove as favorite" if this title is already it.
    let isFav = false;
    const favIcon = lucideIcon('star', 'status-ico');
    const favLabel = el('span', { class: 'status-cell-label' });
    const favCell = el('button', {
      class: 'status-cell status-cell--fav' + ((actions.length + 1) % 2 ? ' full' : ''),
    }, [favIcon, favLabel]);
    const setFavText = d.type === 'movie' ? t('detail.setFavoriteFilm') : t('detail.setFavoriteSeries');
    // First paint is instant (nothing to crossfade FROM); every later toggle
    // crossfades both the label and the star ⇄ star-off mask.
    let favPainted = false;
    function paintFav() {
      const text = isFav ? t('detail.removeFavorite') : setFavText;
      const url = `url("${withBase(`/icons/lucide/${isFav ? 'star-off' : 'star'}.svg`)}")`;
      const applyIcon = () => {
        favIcon.style.webkitMaskImage = url;
        favIcon.style.maskImage = url;
      };
      if (!favPainted) {
        favPainted = true;
        favLabel.textContent = text;
        applyIcon();
        return;
      }
      setLabel(favLabel, text);
      fadeSwap(favIcon, applyIcon);
    }
    paintFav();
    api
      .favorites()
      .then((f) => {
        const cur = d.type === 'movie' ? f.movie : f.show;
        isFav = !!(cur && String(cur.tmdb_id) === String(d.tmdb_id));
        paintFav();
      })
      .catch(() => {
        /* leave it on "Set as…" — the click still works */
      });
    favCell.addEventListener('click', async () => {
      favCell.disabled = true;
      try {
        const save = d.type === 'movie' ? api.setFavoriteMovie : api.setFavoriteShow;
        await save(isFav ? null : d.tmdb_id);
        isFav = !isFav;
        paintFav();
        toast(isFav ? t('detail.pinnedToWall') : t('detail.removedFromWall'), 'ok');
      } catch (err) {
        toast(err.message || t('detail.favoriteFailed'), 'bad');
      } finally {
        favCell.disabled = false;
      }
    });
    grid.append(favCell);

    modal.append(
      menuHeading(d),
      grid,
      el('hr', { class: 'status-sep' }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.cancel') }),
    ]),
      ])
    );
  });
}
