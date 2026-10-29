// Virtual poster grid for the Movies / Series pages.
//
// A 2-D sibling to the episode-list virtual scroller (views/Season.js): the
// library is fetched a page at a time from the paginated /api/media endpoint,
// and only the poster cards near the viewport are ever in the DOM (a recycled
// pool of ~viewport+buffer nodes). A tall spacer (all rows × their height, with
// section dividers counted in) keeps the scrollbar honest, so a huge library
// paints its first page instantly and never grows the DOM as you scroll.
//
// Layout is driven by metadata the server sends on page 1: `total` (for the flat
// row count) and, for the grouped sorts (title / rating), `groups` — the ordered
// [{label,count}] runs that become full-width section dividers. From those the
// full scroll height (dividers included) is known up front, before any later
// page loads. Item cells map to absolute positions → pages fetched on demand,
// with a 1.5-page lead so the next page is ready before its rows scroll in.
//
// Fetched pages + scroll offset are cached per (type + active filter) for the
// session, so switching chips, returning from a detail page or tapping the tab
// never re-fetches or reloads a poster. Like What's Next, a library mutation
// (api.js → 'shelfit:library-changed') only marks the cache STALE: the next visit
// still paints the saved pages at once, then fetches page 1 in the background and
// swaps in what changed (a grid on screen updates in place). A copy older than
// FRESH_MS is quietly revalidated too, which catches what the server changes on
// its own (the nightly Kodi sync).

import { createApi, isAbortError } from './api.js';
import { el, stateBlock } from './ui.js';
import { imageCache } from './imageCache.js';
import { isServerReachable, markDegraded } from './network.js';
import { t } from './i18n.js';

const COLS = 3; // matches .grid { grid-template-columns: repeat(3, 1fr) }
const GAP = 10; // matches .grid gap
const PAGE_SIZE = 48; // items per page (multiple of the 3-column grid)
const ROW_BUFFER = 3; // rows rendered above AND below the viewport
const AHEAD_PAGES = 1.5; // prefetch pages within this many pages of the viewport
const FALLBACK_DIVIDER_H = 34;
const FRESH_MS = 30 * 60 * 1000;

// Session caches, keyed by `${type}:${status}:${genre}:${sort}`. `store` holds a
// filter's fetched pages + layout meta; `scrollMem` its last scroll offset. Both
// are lost on reload (acceptable per spec); a library mutation marks them stale.
//
// CACHE is bounded as an LRU: a store keeps one array slot PER LIBRARY ITEM for
// its filter, and with many genres × sorts × chips it would otherwise keep
// growing for the whole session. Touch on read, evict from the front.
const CACHE = new Map();
const scrollMem = new Map();
const CACHE_MAX = 12;

function touchStore(key) {
  const s = CACHE.get(key);
  if (s) {
    CACHE.delete(key);
    CACHE.set(key, s); // move to most-recently-used
  }
  return s;
}
function rememberStore(key, s) {
  CACHE.set(key, s);
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
}

function normFilter(f) {
  return {
    status: f.status || 'all',
    genre: f.genre || '',
    sort: f.sort || 'added_at',
    owned: !!f.owned,
  };
}

function keyOf(type, f) {
  return `${type}:${f.status || 'all'}:${f.genre || ''}:${f.sort || 'added_at'}:${f.owned ? 'owned' : ''}`;
}

// A filter's store from its page-1 response: layout meta, one slot per library
// item, page 1 filled in. `filter` is kept so a stale store can fetch itself again.
function newStore(filter, res) {
  const items = res.items || [];
  const total = Number.isFinite(res.total) ? res.total : items.length;
  const totalPages = res.totalPages || 1;
  const s = {
    filter,
    total,
    pageSize: res.pageSize || PAGE_SIZE,
    totalPages,
    groups: res.groups || null,
    genres: res.genres || [],
    items: new Array(total),
    pageStatus: new Array(totalPages + 1),
    at: Date.now(),
    stale: false,
  };
  for (let k = 0; k < items.length; k++) s.items[k] = items[k];
  s.pageStatus[1] = 'loaded';
  return s;
}

// Seed a filter's page-1 store from a response the splash preloader already
// fetched, so the first grid load for that filter is a cache hit (instant paint,
// no refetch). No-op if a current store for that filter already exists; a stale
// one is replaced (a grid showing it keeps its copy until its own check swaps).
// `filter` is { status, genre, sort }.
export function seedGridPage(type, filter, res) {
  if (!res || !res.items) return;
  const f = normFilter(filter || {});
  const key = keyOf(type, f);
  if (hasGridPage(type, f)) return;
  rememberStore(key, newStore(f, res));
}

// Whether a filter's pages are cached and current (not stale), so a warm-up can
// skip fetching them again.
export function hasGridPage(type, filter) {
  const s = CACHE.get(keyOf(type, normFilter(filter || {})));
  return !!s && !s.stale;
}

// Send a section back to the top of its lists on the next visit (a bottom-nav
// tap). Its pages stay cached: no request, no poster reloads.
export function forgetGridScroll(type) {
  const prefix = `${type}:`;
  for (const k of [...scrollMem.keys()]) if (k.startsWith(prefix)) scrollMem.delete(k);
}

// A mutation anywhere may have changed library data: mark every cached filter
// stale (its next load checks it again) and update the grid on screen now.
// Scroll offsets stay; a changed layout clamps them.
let liveRevalidate = null; // set while a grid is mounted
window.addEventListener('shelfit:library-changed', () => {
  for (const s of CACHE.values()) s.stale = true;
  if (liveRevalidate) liveRevalidate();
});

// Build one recyclable poster cell: a persistent .poster-card whose <img> src,
// rating badge and click target are mutated on reuse — no nodes created while
// scrolling. Three modes (poster / skeleton / retry) toggled by class.
function createCell(onItemClick) {
  const img = el('img', { class: 'gc-img', alt: '' });
  img.addEventListener('error', () => {
    img.removeAttribute('src');
  });
  const badge = el('div', { class: 'rating-badge' });
  badge.style.display = 'none';
  const retryBtn = el('button', { class: 'gc-retry', type: 'button', text: '↻' });
  const node = el('div', { class: 'poster-card gc-cell' }, [img, badge, retryBtn]);

  let currentItem = null;
  let retryHandler = null;
  node.addEventListener('click', () => {
    if (node.classList.contains('is-retry')) {
      if (retryHandler) retryHandler();
      return;
    }
    if (currentItem && onItemClick) onItemClick(currentItem);
  });

  function show(item) {
    currentItem = item;
    retryHandler = null;
    node.classList.remove('is-skel', 'is-retry');
    if (item.rating) {
      badge.style.display = '';
      badge.innerHTML = `★ ${item.rating}`;
    } else {
      badge.style.display = 'none';
    }
    // A poster already in the image cache goes up at once, with no shimmer (the
    // usual case when coming back to the grid).
    const cached = item.poster_url ? imageCache.get(item.poster_url) : null;
    if (cached) {
      if (img.getAttribute('src') !== cached) img.src = cached;
      node.classList.remove('skeleton');
      return;
    }
    // Otherwise shimmer until it decodes, never over the previous title's poster.
    // Guard against the cell being recycled to another item mid-load.
    img.removeAttribute('src');
    node.classList.add('skeleton');
    if (!item.poster_url) return;
    imageCache
      .load(item.poster_url)
      .then((u) => {
        if (currentItem !== item) return;
        if (u) img.src = u;
        node.classList.remove('skeleton');
      })
      .catch(() => {
        /* keep the shimmer; never a broken-image icon */
      });
  }
  function showSkeleton() {
    currentItem = null;
    retryHandler = null;
    node.classList.remove('is-retry');
    node.classList.add('is-skel', 'skeleton');
    img.removeAttribute('src');
    badge.style.display = 'none';
  }
  function showRetry(fn) {
    currentItem = null;
    retryHandler = fn;
    node.classList.remove('is-skel', 'skeleton');
    node.classList.add('is-retry');
    img.removeAttribute('src');
    badge.style.display = 'none';
  }
  return { node, show, showSkeleton, showRetry, _i: -1, _sig: null };
}

function createDivider() {
  const label = el('span', { class: 'grid-divider-label' });
  return el('div', { class: 'gc-divider' }, [label]);
}

// One virtual poster grid bound to a section (movie/show). grid.js inserts
// `.el`, then calls `.load(filter)` on mount and on every chip/genre/sort change.
// `onUpdate` gets the same summary as `.load` when a background check swaps in
// newer content.
export function createPosterGrid({ type, onItemClick, onActiveGroup, onUpdate }) {
  const ac = new AbortController();
  const api = createApi(ac.signal);

  const spacer = el('div', { class: 'gc-spacer' });
  const scroller = el('div', { class: 'gc-scroller' }, [spacer]);
  const emptyNode = el('div', { class: 'gc-empty' });
  emptyNode.style.display = 'none';
  scroller.append(emptyNode);

  // Active filter view (swapped by .load). `store` is the shared CACHE entry.
  let store = null;
  let currentFilter = { status: 'all', genre: '', sort: 'added_at', owned: false };
  let filterKey = '';
  let loadSeq = 0;
  let lastActiveGroup; // last section label reported to onActiveGroup (dedupe)

  // Layout (rebuilt on load + resize).
  let metrics = { colW: 1, cardH: 1, rowStride: 1 };
  let dividerStride = FALLBACK_DIVIDER_H;
  let dividerMeasured = false;
  let rows = []; // { kind:'div'|'items', y, h, label?|startItem?,count? }
  let rowTops = [];
  let totalHeight = 0;

  const activeCells = new Map(); // absolute item index → cell
  const activeDivs = new Map(); // row index → divider node
  const cellPool = [];
  const divPool = [];

  function pageOf(index) {
    return Math.floor(index / store.pageSize) + 1; // 1-indexed
  }
  function placePage(s, pageNum, items) {
    const start = (pageNum - 1) * s.pageSize;
    for (let k = 0; k < items.length; k++) s.items[start + k] = items[k];
  }

  function sizeScroller() {
    const top = scroller.getBoundingClientRect().top;
    const nav = document.querySelector('.tabbar');
    const navH = nav ? nav.getBoundingClientRect().height : 64;
    const h = Math.max(220, Math.round(window.innerHeight - top - navH - 8));
    scroller.style.height = `${h}px`;
  }

  function computeMetrics() {
    const w = spacer.clientWidth || scroller.clientWidth || 0;
    const colW = Math.max(1, (w - (COLS - 1) * GAP) / COLS);
    const cardH = Math.round(colW * 1.5); // 2:3 poster
    return { colW, cardH, rowStride: cardH + GAP };
  }

  // Measure a real divider's height once (label + breathing room) so its rows
  // are counted correctly in the total scroll height.
  function ensureDividerStride() {
    if (dividerMeasured) return;
    const probe = createDivider();
    probe.querySelector('.grid-divider-label').textContent = 'A';
    probe.style.visibility = 'hidden';
    probe.style.top = '0';
    spacer.appendChild(probe);
    const h = probe.getBoundingClientRect().height;
    spacer.removeChild(probe);
    if (h > 0) dividerStride = Math.round(h) + 12;
    dividerMeasured = true;
  }

  // Turn `total` + `groups` into the flat row model (dividers + item rows) with
  // cumulative y-offsets, then size the spacer to the full height.
  function buildLayout() {
    const { rowStride } = metrics;
    rows = [];
    let y = 0;
    const groups = store.groups;
    if (groups && groups.length) {
      let base = 0; // running absolute item index across groups
      for (const g of groups) {
        rows.push({ kind: 'div', y, h: dividerStride, label: g.label });
        y += dividerStride;
        const nRows = Math.ceil(g.count / COLS);
        for (let r = 0; r < nRows; r++) {
          const count = Math.min(COLS, g.count - r * COLS);
          rows.push({ kind: 'items', y, h: rowStride, startItem: base, count });
          base += count;
          y += rowStride;
        }
      }
    } else {
      const nRows = Math.ceil(store.total / COLS);
      for (let r = 0; r < nRows; r++) {
        const startItem = r * COLS;
        const count = Math.min(COLS, store.total - startItem);
        rows.push({ kind: 'items', y, h: rowStride, startItem, count });
        y += rowStride;
      }
    }
    totalHeight = y;
    rowTops = rows.map((r) => r.y);
    spacer.style.height = `${totalHeight}px`;
  }

  // Largest row index whose top is ≤ scrollTop (first row overlapping the top of
  // the viewport). Binary search — a big library can be thousands of rows.
  function firstRowAt(scrollTop) {
    let lo = 0;
    let hi = rowTops.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rowTops[mid] <= scrollTop) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  // The section-divider label at the top of the viewport (drives the letter
  // picker's active highlight). Walks back from the first row at the scroll offset
  // to its heading divider. Cheap: binary search + a short backward scan.
  function currentGroupLabel(scrollTop) {
    if (!rows.length) return null;
    for (let i = firstRowAt(scrollTop + 4); i >= 0; i--) {
      if (rows[i].kind === 'div') return rows[i].label;
    }
    return null;
  }
  // Smooth-scroll the internal scroller so a section divider sits at the top of
  // the viewport. Used by the alphabetical letter picker (grid.js) — pure scroll,
  // no re-fetch; the scroll drives the normal recycling render().
  function scrollToGroup(label) {
    if (!rows.length) return;
    const row = rows.find((r) => r.kind === 'div' && r.label === label);
    if (row) scroller.scrollTo({ top: row.y, behavior: 'smooth' });
  }

  function applyCell(cell, idx) {
    const item = store.items[idx];
    const p = pageOf(idx);
    let sig;
    if (item) sig = `i${item.id}:${item.rating || 0}:${item.poster_url || ''}`;
    else if (store.pageStatus[p] === 'error') sig = `r${p}`;
    else sig = 's';
    if (cell._i === idx && cell._sig === sig) return;
    cell._i = idx;
    cell._sig = sig;
    if (item) cell.show(item);
    else if (store.pageStatus[p] === 'error') cell.showRetry(() => fetchPage(p, store));
    else cell.showSkeleton();
  }

  function recycleAll() {
    for (const [, cell] of activeCells) {
      cell.node.style.display = 'none';
      cellPool.push(cell);
    }
    for (const [, node] of activeDivs) {
      node.style.display = 'none';
      divPool.push(node);
    }
    activeCells.clear();
    activeDivs.clear();
  }

  function render() {
    if (!store || !rows.length) return;
    const scrollTop = scroller.scrollTop;
    const clientH = scroller.clientHeight || 1;
    const firstRow = firstRowAt(scrollTop);
    let lastRow = firstRow;
    while (lastRow < rows.length && rows[lastRow].y < scrollTop + clientH) lastRow++;
    const rStart = Math.max(0, firstRow - ROW_BUFFER);
    const rEnd = Math.min(rows.length, lastRow + ROW_BUFFER);

    const wantCells = new Set();
    const wantDivs = new Set();
    let minItem = Infinity;
    let maxItem = -1;
    for (let ri = rStart; ri < rEnd; ri++) {
      const row = rows[ri];
      if (row.kind === 'div') {
        wantDivs.add(ri);
        continue;
      }
      for (let c = 0; c < row.count; c++) {
        const idx = row.startItem + c;
        wantCells.add(idx);
        if (idx < minItem) minItem = idx;
        if (idx > maxItem) maxItem = idx;
      }
    }

    // Recycle out-of-range nodes back to their pools.
    for (const [idx, cell] of activeCells) {
      if (!wantCells.has(idx)) {
        cell.node.style.display = 'none';
        activeCells.delete(idx);
        cellPool.push(cell);
      }
    }
    for (const [ri, node] of activeDivs) {
      if (!wantDivs.has(ri)) {
        node.style.display = 'none';
        activeDivs.delete(ri);
        divPool.push(node);
      }
    }

    // Mount / position dividers in range.
    for (const ri of wantDivs) {
      let node = activeDivs.get(ri);
      if (!node) {
        node = divPool.pop() || createDivider();
        if (!node.isConnected) spacer.appendChild(node);
        activeDivs.set(ri, node);
      }
      const row = rows[ri];
      // 'Unrated' is the server's fixed label for the rating-0 group; the letter
      // and "N ★" labels are symbolic and shown as-is.
      node.querySelector('.grid-divider-label').textContent = row.label === 'Unrated' ? t('grid.unrated') : row.label;
      node.style.top = `${row.y}px`;
      node.style.height = `${row.h}px`;
      node.style.display = '';
    }

    // Mount / position + fill item cells in range.
    for (let ri = rStart; ri < rEnd; ri++) {
      const row = rows[ri];
      if (row.kind !== 'items') continue;
      for (let c = 0; c < row.count; c++) {
        const idx = row.startItem + c;
        let cell = activeCells.get(idx);
        if (!cell) {
          cell = cellPool.pop() || createCell(onItemClick);
          if (!cell.node.isConnected) spacer.appendChild(cell.node);
          cell.node.style.display = '';
          cell._i = -1;
          cell._sig = null;
          activeCells.set(idx, cell);
        }
        cell.node.style.left = `${c * (metrics.colW + GAP)}px`;
        cell.node.style.top = `${row.y}px`;
        cell.node.style.width = `${metrics.colW}px`;
        cell.node.style.height = `${metrics.cardH}px`;
        applyCell(cell, idx);
      }
    }

    ensurePages(minItem, maxItem);
    scrollMem.set(filterKey, scrollTop);

    // Report the section now at the top of the viewport (letter-picker highlight).
    if (onActiveGroup && store.groups) {
      const label = currentGroupLabel(scrollTop);
      if (label !== lastActiveGroup) {
        lastActiveGroup = label;
        onActiveGroup(label);
      }
    }
  }

  function ensurePages(minItem, maxItem) {
    if (maxItem < 0) return;
    const lead = Math.ceil(AHEAD_PAGES * store.pageSize);
    const from = pageOf(minItem);
    const to = pageOf(Math.min(store.total - 1, maxItem + lead));
    for (let p = from; p <= to; p++) {
      if (!store.pageStatus[p]) fetchPage(p, store);
    }
  }

  async function fetchPage(p, s) {
    if (p < 1 || p > s.totalPages) return;
    if (s.pageStatus[p] === 'loading' || s.pageStatus[p] === 'loaded') return;
    s.pageStatus[p] = 'loading';
    try {
      const res = await api.mediaPage(type, {
        status: currentFilter.status,
        genre: currentFilter.genre,
        sort: currentFilter.sort,
        owned: currentFilter.owned,
        page: p,
        pageSize: s.pageSize,
      });
      placePage(s, p, res.items || []);
      s.pageStatus[p] = 'loaded';
    } catch (err) {
      if (isAbortError(err)) {
        s.pageStatus[p] = undefined; // teardown — allow a fresh attempt next mount
        return;
      }
      if (!isServerReachable()) {
        markDegraded();
        s.pageStatus[p] = undefined; // transient — a reconnect/scroll retries
        return;
      }
      s.pageStatus[p] = 'error';
    }
    if (s === store) render(); // ignore late pages from a superseded filter
  }

  function showEmpty(on, msg) {
    emptyNode.style.display = on ? '' : 'none';
    if (on) {
      emptyNode.innerHTML = '';
      emptyNode.append(
        msg && typeof msg === 'object'
          ? stateBlock(msg)
          : stateBlock({
              icon: 'shelving-unit',
              title: msg || t('grid.empty'),
              detail: t('grid.emptyDetail'),
            })
      );
      spacer.style.height = '0px';
    }
  }

  // Fill the visible area with shimmer cards while page 1 is in flight (only for
  // an uncached filter — a cached one renders real posters immediately). The
  // scroller must already be visible so its width measures correctly. These
  // transient cells are pooled back by recycleAll() before the first real render.
  function paintSkeleton() {
    showEmpty(false);
    metrics = computeMetrics();
    sizeScroller();
    recycleAll();
    const stride = metrics.cardH + GAP;
    spacer.style.height = `${scroller.clientHeight || stride * 3}px`;
    const rowsToShow = Math.ceil((scroller.clientHeight || stride * 3) / stride) + 1;
    let n = 0;
    for (let r = 0; r < rowsToShow; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = cellPool.pop() || createCell(onItemClick);
        if (!cell.node.isConnected) spacer.appendChild(cell.node);
        cell.node.style.display = '';
        cell.node.style.left = `${c * (metrics.colW + GAP)}px`;
        cell.node.style.top = `${r * stride}px`;
        cell.node.style.width = `${metrics.colW}px`;
        cell.node.style.height = `${metrics.cardH}px`;
        cell.showSkeleton();
        cell._i = -1;
        cell._sig = null;
        activeCells.set(`skel:${n++}`, cell); // transient key; cleared by recycleAll
      }
    }
  }

  // (Re)initialise for a filter: reuse the cached pages if we have them, else
  // fetch page 1. Returns { total, genres } so grid.js can fill the genre
  // dropdown and know whether anything is here. Throws on a hard page-1 failure
  // (grid.js maps that to its offline / error handling).
  // What grid.js needs about the view on screen: whether anything is here, the
  // genre list, and the ordered labels of its sections (title/rating sorts, else
  // null), which the letter picker uses as its active set + scroll targets.
  function summary() {
    return {
      total: store.total,
      genres: store.genres,
      groups: store.total && store.groups ? store.groups.map((g) => g.label) : null,
    };
  }

  // Swap a newer copy of the active filter in where it stands. Cells whose title,
  // rating and poster didn't change keep their node and image, so an unchanged
  // grid doesn't move at all.
  function swapIn(fresh) {
    const top = scroller.scrollTop;
    store = fresh;
    if (!store.total) {
      rows = [];
      recycleAll();
      showEmpty(true, null);
    } else {
      showEmpty(false);
      metrics = computeMetrics();
      buildLayout();
      sizeScroller();
      scroller.scrollTop = Math.min(top, Math.max(0, totalHeight - scroller.clientHeight));
      render();
    }
    if (onUpdate) onUpdate(summary());
  }

  // Fetch the active filter's page 1 again and swap it in. When the library kept
  // its size, the other saved pages stay on screen until they are fetched again
  // as they come into view; otherwise their rows shimmer until then.
  async function revalidate() {
    const s = store;
    if (!s) return;
    if (s.revalidating) {
      s.recheck = true; // another change landed mid-check: check once more after
      return;
    }
    s.revalidating = true;
    let fresh;
    try {
      const res = await api.mediaPage(type, { ...s.filter, page: 1, pageSize: s.pageSize });
      fresh = newStore(s.filter, res);
    } catch {
      return; // navigated away or offline: the saved copy stays, still stale
    } finally {
      s.revalidating = false;
    }
    const again = !!s.recheck;
    s.recheck = false;
    if (fresh.total === s.total) {
      for (let i = fresh.pageSize; i < s.total; i++) fresh.items[i] = s.items[i];
    }
    rememberStore(keyOf(type, s.filter), fresh);
    // Another filter on screen, or the grid hidden (collections, the offline
    // grid): the next load picks the fresh copy up from the cache.
    if (s !== store || !scroller.offsetWidth) {
      if (again) fresh.stale = true;
      return;
    }
    swapIn(fresh);
    if (again) revalidate();
  }

  async function load(filter) {
    currentFilter = normFilter(filter);
    const key = keyOf(type, currentFilter);
    filterKey = key;
    loadSeq += 1;
    const mySeq = loadSeq;

    let s = touchStore(key);
    const cached = !!s;
    if (!s) {
      paintSkeleton(); // shimmer while page 1 loads (scroller must be visible)
      const res = await api.mediaPage(type, { ...currentFilter, page: 1, pageSize: PAGE_SIZE });
      if (mySeq !== loadSeq) return null; // a newer load superseded us
      s = newStore(currentFilter, res);
      rememberStore(key, s);
    }
    if (mySeq !== loadSeq) return null;

    store = s;
    lastActiveGroup = undefined; // force onActiveGroup to re-fire for the new view
    recycleAll();
    // A saved copy is painted as it is; if the library changed since (or it is
    // old), it is checked in the background and updated in place.
    if (cached && (s.stale || Date.now() - s.at > FRESH_MS)) revalidate();

    if (!store.total) {
      rows = []; // a later scroll event's render() must no-op
      showEmpty(true, null);
      return summary();
    }
    showEmpty(false);

    metrics = computeMetrics();
    ensureDividerStride();
    buildLayout();
    sizeScroller();

    // Restore the remembered scroll offset for this filter. The synchronous set
    // can be dropped when the mount happens inside a route View Transition (the
    // transition resets internal-scroller positions as it commits), so re-apply it
    // over the next couple of frames — guarded so a filter change or a user scroll
    // in the meantime wins.
    const savedTop = scrollMem.get(key) || 0;
    const applyScroll = () => {
      if (s !== store) return;
      const clamped = Math.min(savedTop, Math.max(0, totalHeight - scroller.clientHeight));
      if (clamped > 0 && Math.abs(scroller.scrollTop - clamped) > 2) {
        scroller.scrollTop = clamped;
        render();
      }
    };
    scroller.scrollTop = Math.min(savedTop, Math.max(0, totalHeight - scroller.clientHeight));
    render();
    if (savedTop > 0) {
      requestAnimationFrame(applyScroll);
      requestAnimationFrame(() => requestAnimationFrame(applyScroll));
    }
    // Eagerly prefetch page 2 so scrolling past the first page has no gap.
    if (store.totalPages > 1 && !store.pageStatus[2]) fetchPage(2, store);
    return summary();
  }

  // --- scroll / resize wiring ---------------------------------------------
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      render();
    });
  }
  function onResize() {
    if (!store || !store.total) return;
    const prevTop = scroller.scrollTop;
    metrics = computeMetrics();
    buildLayout();
    sizeScroller();
    scroller.scrollTop = Math.min(prevTop, Math.max(0, totalHeight - scroller.clientHeight));
    recycleAll();
    render();
  }
  scroller.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  const live = () => revalidate();
  liveRevalidate = live;

  function destroy() {
    scroller.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    if (liveRevalidate === live) liveRevalidate = null;
    ac.abort();
  }

  return { el: scroller, load, destroy, scrollToGroup };
}
