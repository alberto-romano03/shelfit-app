// Season screen (/season/:id/:n) — the episode list for one season of a show.
// Each row supports optimistic watch toggling, rewatch/remove, per-episode
// notes (a bottom sheet), "mark all watched", and a catch-up prompt for skipped
// earlier episodes.
//
// The list is VIRTUALISED: episodes are fetched a page at a time from the
// paginated season endpoint, and only the rows near the viewport are ever in the
// DOM (a recycled pool of ~viewport+buffer nodes), so a season with hundreds of
// episodes loads its first page instantly and never grows the DOM as you scroll.
// A tall spacer (total × row-height) keeps the scrollbar honest. Off-screen /
// not-yet-fetched ranges render shimmer skeletons; a failed page shows a retry
// row. Scroll position is remembered per season (in memory) for the session.

import { createApi, isAbortError } from '../api.js';
import { navigate, onCleanup } from '../router.js';
import {
  el,
  icons,
  skelLine,
  toast,
  openModal,
  openSheet,
  openWatchCountModal,
  epLabel,
  formatDate,
  crossfadeSwap,
  lucideIcon,
  clear,
  stateBlock,
  typewriterPlaceholder,
} from '../ui.js';
import { imageCache } from '../imageCache.js';
import { isServerReachable, markDegraded } from '../network.js';
import { confetti } from '../confetti.js';
import { offerShelve } from '../finishSeries.js';
import { withBase } from '../basePath.js';
import { t } from '../i18n.js';

// Diary-style openers used as a random placeholder each time the note sheet opens.
const NOTE_PLACEHOLDERS = [
  'season.notePlaceholder1',
  'season.notePlaceholder2',
  'season.notePlaceholder3',
  'season.notePlaceholder4',
  'season.notePlaceholder5',
  'season.notePlaceholder6',
  'season.notePlaceholder7',
  'season.notePlaceholder8',
  'season.notePlaceholder9',
  'season.notePlaceholder10',
  'season.notePlaceholder11',
  'season.notePlaceholder12',
  'season.notePlaceholder13',
  'season.notePlaceholder14',
];

// Virtual-scroll tuning.
const PAGE_SIZE = 50; // episodes fetched per request
const BUFFER = 15; // rows rendered above AND below the viewport
const AHEAD_PAGES = 1.5; // prefetch pages within this many pages of the viewport
const FALLBACK_ROW_H = 77; // used only if a live row can't be measured

// Remembered scroll offset per season (`${id}:${n}`), in memory only — lost on
// reload, which the spec accepts. Lets closing and reopening a season restore
// the previous position within the episode list.
const scrollMemory = new Map();

// Ghost-frame for the season view. Mirrors the real layout so nothing shifts when
// the data swaps in: header (real back button + title line), the two action
// buttons ("Watched all" / "Jump to latest") as equal-width shimmer blocks, the
// separator, then the episode rows.
function seasonSkeleton() {
  const view = el('div', { class: 'season-view' });

  // Header — the back button is chrome (available immediately); only the
  // data-driven title is a shimmer.
  view.append(
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '22px' } }, [
      el('button', { class: 'icon-btn', html: icons.back, 'aria-label': t('common.back'), onClick: () => history.back() }),
      skelLine({ width: '150px', height: '20px', margin: '0' }),
    ])
  );

  // Action buttons row — two equal-width shimmer blocks matching .season-actions.
  view.append(
    el('div', { class: 'season-actions' }, [
      el('div', { class: 'skeleton', style: { flex: '1', height: '48px', borderRadius: '12px' } }),
      el('div', { class: 'skeleton', style: { flex: '1', height: '48px', borderRadius: '12px' } }),
    ])
  );

  // Separator, identical to the real list.
  view.append(el('hr', { class: 'status-sep season-sep' }));

  for (let i = 0; i < 6; i++) {
    view.append(
      el('div', { class: 'episode' }, [
        el('div', { style: { display: 'flex', gap: '10px', flex: '1', minWidth: '0' } }, [
          el('div', { class: 'thumb skeleton' }),
          el('div', { class: 'ep-main' }, [
            skelLine({ width: '70%' }),
            skelLine({ cls: 'sm', width: '40%', margin: '6px 0 0' }),
          ]),
        ]),
      ])
    );
  }
  return view;
}

export default async function Season(container, params) {
  const ac = new AbortController();
  onCleanup(() => ac.abort());
  const api = createApi(ac.signal);

  container.append(seasonSkeleton());
  const id = params.id;
  const n = params.n;
  const scrollKey = `${id}:${n}`;

  // First page (with total/totalPages) — everything the initial paint needs.
  let first;
  try {
    first = await api.seasonPage(id, n, 1, PAGE_SIZE);
  } catch (err) {
    if (isAbortError(err)) return; // navigated away — ignore silently
    if (!isServerReachable()) {
      markDegraded(); // server unreachable (transport failure or backend 5xx); a 4xx shows an error
      return;
    }
    clear(container);
    container.append(
      stateBlock({
        kind: 'error',
        title: t('season.loadError'),
        error: err.message,
        action: { onClick: () => navigate(location.pathname + location.search, { replace: true }) },
      })
    );
    return;
  }

  // Season-level fields shared by the note sheet / labels / catch-up.
  const data = {
    item_id: first.item_id,
    season_number: first.season_number,
    name: first.name,
    overview: first.overview,
  };

  // --- Paged episode store ------------------------------------------------
  // A flat, sparse array indexed by absolute episode position; pages fill their
  // own slice. An older, non-paginated server (no `total`) degrades to a single
  // fully-loaded page.
  const pageSize = first.pageSize || (first.episodes || []).length || PAGE_SIZE;
  const total = Number.isFinite(first.total) ? first.total : (first.episodes || []).length;
  const totalPages = first.totalPages || 1;
  // Absolute index to jump to (first unwatched, else last episode) — see server.
  const nextIndex = Number.isFinite(first.next_index) ? first.next_index : 0;
  const episodes = new Array(total); // position → episode object (or empty)
  const indexByEp = new Map(); // episode_number → absolute index (loaded eps only)
  const pageStatus = new Array(totalPages + 1); // 1-indexed: undefined | 'loading' | 'loaded' | 'error'

  function pageOf(index) {
    return Math.floor(index / pageSize) + 1; // 1-indexed
  }
  function placePage(pageNum, eps) {
    const start = (pageNum - 1) * pageSize;
    for (let k = 0; k < eps.length; k++) {
      const idx = start + k;
      const ep = eps[k];
      ep._i = idx;
      episodes[idx] = ep;
      indexByEp.set(ep.episode_number, idx);
    }
  }
  placePage(1, first.episodes || []);
  pageStatus[1] = 'loaded';

  // --- Chrome -------------------------------------------------------------
  const header = el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '22px' } }, [
    el('button', { class: 'icon-btn', html: icons.back, 'aria-label': t('common.back'), onClick: () => history.back() }),
    el('h2', { style: { margin: 0, fontSize: '20px' }, text: data.name || t('season.title', { num: n }) }),
  ]);

  const markAllBtn = el(
    'button',
    {
      class: 'btn btn-secondary',
      onClick: async () => {
        try {
          const res = await api.markSeason(id, parseInt(n, 10));
          toast(t('season.allMarked'), 'ok');
          if (res.caught_up) confetti.trigger(); // finished the last available episode
          navigate(location.pathname, { replace: true }); // re-mount → scroll restored from memory
          offerShelve(res, { id, onShelved: () => navigate(location.pathname, { replace: true }) });
        } catch (err) {
          toast(err.message, 'bad');
        }
      },
    },
    [lucideIcon('check-check', 'btn-lucide'), el('span', { text: t('season.watchedAll') })]
  );

  // Jump straight to where the viewer left off — the next unwatched episode (or
  // the last one, once caught up). Invaluable for very long single-season shows
  // (e.g. Detective Conan) where scrolling to the frontier by hand is painful.
  const jumpBtn = el(
    'button',
    { class: 'btn btn-secondary season-jump', onClick: () => jumpToCurrent() },
    [lucideIcon('signpost', 'btn-lucide'), el('span', { text: t('season.jumpLatest') })]
  );
  const actionRow = el('div', { class: 'season-actions' }, [markAllBtn, jumpBtn]);

  // --- Virtual scroller scaffolding ---------------------------------------
  const spacer = el('div', { class: 'ep-spacer' });
  const scroller = el('div', { class: 'ep-scroller' }, [spacer]);
  const listSep = el('hr', { class: 'status-sep season-sep' });
  const seasonView = el('div', { class: 'season-view' }, [header, actionRow, listSep, scroller]);

  let ROW_H = FALLBACK_ROW_H;
  const pool = []; // recycled row objects, ready for reuse
  const activeRows = new Map(); // absolute index → row object currently mounted

  // Size the scroll container to fill the space between its top and the fixed
  // bottom tab bar, so it has a real fixed height with its own scrollbar.
  function sizeScroller() {
    const top = scroller.getBoundingClientRect().top;
    const nav = document.querySelector('.tabbar');
    const navH = nav ? nav.getBoundingClientRect().height : 64;
    const h = Math.max(220, Math.round(window.innerHeight - top - navH - 8));
    scroller.style.height = `${h}px`;
  }

  // Measure one real row (in flow, hidden) to get the fixed row height.
  function measureRowHeight() {
    // The title span MUST carry .ep-title-text (nowrap) exactly like real rows,
    // so the probe's height is width-independent — otherwise, if measured while
    // the scroller has a transient narrow width (e.g. mid view-transition), a
    // plain span would wrap to several lines and over-measure the row height.
    const probe = el('div', { class: 'episode ep-virtual is-measure' }, [
      el('div', { class: 'ep-real' }, [
        el('div', { class: 'thumb' }),
        el('div', { class: 'ep-main' }, [
          el('div', { class: 'ep-title' }, [
            el('span', { class: 'ep-title-text', text: 'S01 E01 — Sample Episode' }),
          ]),
          el('div', { class: 'ep-sub', text: '1 Jan 2020 · 45 min' }),
        ]),
        el('div', { class: 'ep-right' }, [el('div', { class: 'check' })]),
      ]),
    ]);
    scroller.appendChild(probe);
    const h = probe.getBoundingClientRect().height;
    scroller.removeChild(probe);
    return h > 0 ? Math.round(h) : FALLBACK_ROW_H;
  }

  // --- Recyclable episode row ---------------------------------------------
  // One fixed DOM structure per pooled row, with three modes toggled by class:
  // real episode / skeleton / retry. Reuse only mutates text, classes and the
  // thumbnail src — no new nodes are created while scrolling.
  function createEpisodeRow() {
    const img = el('img', { class: 'ep-thumb-img', alt: '' });
    img.addEventListener('error', () => {
      img.removeAttribute('src');
      img.style.visibility = 'hidden';
    });
    const thumb = el('div', { class: 'thumb' }, [img]);
    const titleText = el('span', { class: 'ep-title-text' });
    const noteDot = el('span', { class: 'ep-note-dot', title: t('season.hasNote') });
    noteDot.style.display = 'none';
    const titleRow = el('div', { class: 'ep-title' }, [titleText, noteDot]);
    const sub = el('div', { class: 'ep-sub' });
    const main = el('div', { class: 'ep-main' }, [titleRow, sub]);
    const check = el('div', { class: 'check' });
    const right = el('div', { class: 'ep-right' }, [check]);
    const real = el('div', { class: 'ep-real' }, [thumb, main, right]);

    const skel = el('div', { class: 'ep-skel' }, [
      el('div', { class: 'thumb skeleton' }),
      el('div', { class: 'ep-main' }, [
        skelLine({ width: '70%' }),
        skelLine({ cls: 'sm', width: '40%', margin: '6px 0 0' }),
      ]),
    ]);
    const retryBtn = el('button', { class: 'link-btn ep-retry-btn', text: t('season.retryRow') });
    const retry = el('div', { class: 'ep-retry' }, [retryBtn]);

    const node = el('div', { class: 'episode ep-virtual' }, [real, skel, retry]);
    node.style.height = `${ROW_H}px`;
    node.style.display = 'none';

    let currentEp = null;
    let retryHandler = null;
    main.addEventListener('click', () => {
      if (currentEp) openNoteSheet(currentEp);
    });
    check.addEventListener('click', () => {
      if (currentEp) onCheck(currentEp);
    });
    retryBtn.addEventListener('click', () => {
      if (retryHandler) retryHandler();
    });

    function showEpisode(ep) {
      currentEp = ep;
      retryHandler = null;
      node.classList.remove('is-skel', 'is-retry');
      titleText.textContent = `${epLabel(data.season_number, ep.episode_number)} — ${ep.name || ''}`;
      noteDot.style.display = ep.notes ? '' : 'none';
      const bits = [];
      if (ep.air_date) bits.push(formatDate(ep.air_date));
      if (ep.runtime) bits.push(t('season.runtime', { min: ep.runtime }));
      sub.textContent = bits.join(' · ');
      check.classList.toggle('done', !!ep.watched);
      if (ep.watched && ep.watch_count > 1) check.innerHTML = `<span class="check-count">×${ep.watch_count}</span>`;
      else if (ep.watched) check.innerHTML = icons.check;
      else check.innerHTML = '';
      if (ep.still_url) {
        img.style.visibility = '';
        // Reuse the in-memory image cache; guard against the row being recycled
        // to a different episode before the (possibly async) load resolves.
        imageCache
          .load(ep.still_url)
          .then((u) => {
            if (currentEp === ep && u) img.src = u;
          })
          .catch(() => {});
      } else {
        img.removeAttribute('src');
        img.style.visibility = 'hidden';
      }
    }
    function showSkeleton() {
      currentEp = null;
      retryHandler = null;
      node.classList.add('is-skel');
      node.classList.remove('is-retry');
    }
    function showRetry(fn) {
      currentEp = null;
      retryHandler = fn;
      node.classList.add('is-retry');
      node.classList.remove('is-skel');
    }
    return { node, showEpisode, showSkeleton, showRetry, _i: -1, _sig: null };
  }

  // Set a row's content to reflect the current state of absolute index `i`
  // (loaded episode / skeleton / retry), skipping work when nothing changed.
  function applyContent(r, i) {
    const ep = episodes[i];
    const p = pageOf(i);
    let sig;
    if (ep) sig = `e${ep.episode_number}:${ep.watched ? 1 : 0}:${ep.watch_count || 0}:${ep.notes ? 1 : 0}`;
    else if (pageStatus[p] === 'error') sig = `r${p}`;
    else sig = 's';
    if (r._i === i && r._sig === sig) return;
    r._i = i;
    r._sig = sig;
    if (ep) r.showEpisode(ep);
    else if (pageStatus[p] === 'error') r.showRetry(() => fetchPage(p));
    else r.showSkeleton();
  }

  // The core virtual render: reconcile which absolute indices are on screen,
  // recycling rows out of range and (re)populating rows in range.
  function render() {
    if (!total) return;
    const scrollTop = scroller.scrollTop;
    const clientH = scroller.clientHeight || 1;
    const firstVisible = Math.floor(scrollTop / ROW_H);
    const lastVisible = Math.ceil((scrollTop + clientH) / ROW_H);
    const start = Math.max(0, firstVisible - BUFFER);
    const end = Math.min(total, lastVisible + BUFFER);

    // Recycle rows that scrolled out of the buffer back into the pool.
    for (const [i, r] of activeRows) {
      if (i < start || i >= end) {
        r.node.style.display = 'none';
        activeRows.delete(i);
        pool.push(r);
      }
    }
    // Mount / update rows now in range.
    for (let i = start; i < end; i++) {
      let r = activeRows.get(i);
      if (!r) {
        r = pool.pop() || createEpisodeRow();
        if (!r.node.isConnected) spacer.appendChild(r.node);
        r.node.style.top = `${i * ROW_H}px`;
        r.node.style.display = '';
        r._i = -1;
        r._sig = null;
        activeRows.set(i, r);
      }
      applyContent(r, i);
    }
    ensurePagesForRange(start, end);
    scrollMemory.set(scrollKey, scrollTop);
  }

  // Scroll to the "jump to next" target. Instant (not smooth): a long series can
  // be thousands of rows, and animating across them would thrash the virtual
  // renderer. The target sits ~2 rows below the top for a little context above;
  // if its page isn't fetched yet the landing shows skeletons that fill in.
  function jumpToCurrent() {
    if (!total) return;
    const target = Math.max(0, Math.min(nextIndex, total - 1));
    const maxTop = Math.max(0, total * ROW_H - scroller.clientHeight);
    scroller.scrollTop = Math.min(Math.max(0, target * ROW_H - ROW_H * 2), maxTop);
    render();
  }

  // Fetch any page overlapping [start, viewport-end + AHEAD_PAGES] that hasn't
  // been fetched yet — the lead time keeps the next page ready before its rows
  // scroll into view.
  function ensurePagesForRange(start, end) {
    const aheadEnd = Math.min(total - 1, end - 1 + Math.ceil(AHEAD_PAGES * pageSize));
    const from = pageOf(start);
    const to = pageOf(Math.max(start, aheadEnd));
    for (let p = from; p <= to; p++) {
      if (!pageStatus[p]) fetchPage(p);
    }
  }

  async function fetchPage(p) {
    if (p < 1 || p > totalPages) return;
    if (pageStatus[p] === 'loading' || pageStatus[p] === 'loaded') return;
    pageStatus[p] = 'loading'; // in-range rows already show skeletons while pending
    try {
      const res = await api.seasonPage(id, n, p, pageSize);
      placePage(p, res.episodes || []);
      pageStatus[p] = 'loaded';
    } catch (err) {
      if (isAbortError(err)) {
        pageStatus[p] = undefined; // navigated away — allow a fresh attempt next mount
        return;
      }
      pageStatus[p] = 'error';
    }
    render(); // swap skeletons for real rows (or retry rows) in the current range
  }

  // Refresh the row currently displaying episode `ep` after its data mutated
  // (mark watched, note edited, catch-up). No-op when that row is off-screen —
  // it will show the new state whenever it scrolls back in.
  function refreshEp(ep) {
    if (!ep || ep._i == null) return;
    const r = activeRows.get(ep._i);
    if (r) {
      r._sig = null; // force applyContent to re-render
      applyContent(r, ep._i);
    }
  }

  // --- Per-episode interactions (unchanged behaviour; row updates go through
  // refreshEp instead of replacing DOM nodes) --------------------------------
  function openNoteSheet(ep) {
    const existing = ep.notes || '';
    openSheet(
      (sheet, close) => {
        const notePlaceholder = t(NOTE_PLACEHOLDERS[Math.floor(Math.random() * NOTE_PLACEHOLDERS.length)]);
        const textarea = el('textarea', {
          class: 'text-field note-sheet-input',
          rows: '6',
        });
        textarea.value = existing;
        // Type the placeholder out letter by letter (stops on cleanup / first keypress).
        const stopNoteTypewriter = typewriterPlaceholder(textarea, notePlaceholder);

        async function save(value) {
          stopNoteTypewriter();
          if (value === existing) return close();
          try {
            await api.episodeNotes(id, data.season_number, ep.episode_number, value);
            ep.notes = value;
            refreshEp(ep); // refresh the note dot
            toast(value ? t('season.noteSaved') : t('season.noteDeleted'), 'ok');
          } catch (err) {
            toast(err.message, 'bad');
          }
          close();
        }

        const footerChildren = [
          el('div', { class: 'note-sheet-actions' }, [
            el('button', { class: 'btn btn-secondary', onClick: () => { stopNoteTypewriter(); close(); } }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.cancel') }),
    ]),
            el('button', { class: 'btn btn-primary', onClick: () => save(textarea.value.trim()) }, [
      lucideIcon('check', 'btn-lucide'),
      el('span', { text: t('season.confirm') }),
    ]),
          ]),
        ];
        if (existing) {
          footerChildren.push(
            el('button', { class: 'link-btn link-danger note-delete', text: t('season.deleteNote'), onClick: () => save('') })
          );
        }

        sheet.append(
          el('div', { class: 'sheet-header' }, [
            el('h3', { text: t('season.noteTitle', { ep: epLabel(data.season_number, ep.episode_number) }) }),
          ]),
          el('div', { class: 'sheet-body' }, [textarea]),
          el('div', { class: 'sheet-footer note-sheet-footer' }, footerChildren)
        );
        setTimeout(() => textarea.focus(), 60);
      },
      { compact: true }
    );
  }

  async function onCheck(ep) {
    if (!ep.watched) {
      // Optimistic tick; reconcile / roll back once the server responds.
      const prevCount = ep.watch_count;
      ep.watched = true;
      ep.watch_count = ep.watch_count || 1;
      refreshEp(ep);
      try {
        const res = await api.markEpisode(id, data.season_number, ep.episode_number);
        if ((res.watch_count || 1) !== ep.watch_count) {
          ep.watch_count = res.watch_count || 1;
          refreshEp(ep);
        }
        if (res.caught_up) confetti.trigger(); // finished the last available episode
        const gap = (res.previous_unseen || []).length;
        if (gap > 0) promptCatchUp(ep, gap);
        else offerShelve(res, { id, onShelved: () => navigate(location.pathname, { replace: true }) });
      } catch (err) {
        if (isAbortError(err)) return; // navigated away — leave the optimistic tick
        ep.watched = false;
        ep.watch_count = prevCount;
        refreshEp(ep);
        toast(err.message, 'bad');
      }
      return;
    }
    // Already watched → the reusable watch-count stepper (0 fully unwatches).
    openWatchCountModal({
      title: epLabel(data.season_number, ep.episode_number),
      count: ep.watch_count || 1,
      min: 0,
      onConfirm: async (count) => {
        const res = await api.setEpisodeCount(id, data.season_number, ep.episode_number, count);
        const newCount = res.watch_count || 0;
        if (newCount <= 0) {
          ep.watched = false;
          ep.watch_count = 0;
        } else {
          ep.watched = true;
          ep.watch_count = newCount;
        }
        refreshEp(ep);
      },
    });
  }

  function promptCatchUp(ep, count) {
    openModal((modal, close) => {
      const yes = el('button', { class: 'btn btn-primary btn-catchup' }, [
        lucideIcon('check-check', 'btn-lucide'),
        el('span', { text: t('season.markN', { n: count }) }),
      ]);
      yes.addEventListener('click', async () => {
        yes.disabled = true;
        try {
          const res = await api.catchUpEpisodes(id, data.season_number, ep.episode_number);
          close();
          if (res.caught_up) confetti.trigger(); // catching up finished the series
          toast(t('season.caughtUp', { n: count }), 'ok');
          offerShelve(res, { id, onShelved: () => navigate(location.pathname, { replace: true }) });
          // Reconcile the affected episodes in place. Prefer the server-returned
          // list; fall back to re-fetching page 1 (where earlier episodes live).
          if (Array.isArray(res.marked_episodes)) {
            for (const m of res.marked_episodes) {
              if (m.season !== data.season_number) continue;
              const idx = indexByEp.get(m.episode);
              if (idx == null) continue; // its page isn't loaded → reflects on fetch
              const cur = episodes[idx];
              if (cur && !cur.watched) {
                cur.watched = true;
                if (!cur.watch_count) cur.watch_count = 1;
                refreshEp(cur);
              }
            }
          } else {
            try {
              const fresh = await api.seasonPage(id, n, 1, pageSize);
              for (const nu of fresh.episodes || []) {
                const idx = indexByEp.get(nu.episode_number);
                if (idx == null) continue;
                const cur = episodes[idx];
                if (cur && (cur.watched !== nu.watched || cur.watch_count !== nu.watch_count)) {
                  Object.assign(cur, nu);
                  cur._i = idx;
                  refreshEp(cur);
                }
              }
            } catch (e) {
              if (isAbortError(e)) return;
            }
          }
        } catch (err) {
          yes.disabled = false;
          toast(err.message, 'bad');
        }
      });
      modal.append(
        el('h3', { text: t('season.catchUpTitle') }),
        el('div', {
          class: 'muted',
          text: t('season.catchUpBody', { n: count }),
        }),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('season.no') }),
    ]),
          yes,
        ])
      );
    });
  }

  // --- Scroll / resize wiring ---------------------------------------------
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
    sizeScroller();
    render();
  }
  scroller.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  onCleanup(() => {
    scroller.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    document.body.classList.remove('season-active');
  });

  // Once the scroller is in the DOM: measure the row height, size the spacer +
  // container, restore the last scroll offset, do the first virtual render, and
  // eagerly prefetch page 2 so scrolling past the first page has no loading gap.
  function setupVirtual() {
    ROW_H = measureRowHeight();
    spacer.style.height = `${total * ROW_H}px`;
    sizeScroller();
    const saved = scrollMemory.get(scrollKey);
    if (saved) {
      scroller.scrollTop = Math.min(saved, Math.max(0, total * ROW_H - scroller.clientHeight));
    }
    render();
    if (totalPages > 1) fetchPage(2);
  }

  // --- Mount --------------------------------------------------------------
  // Setup runs INSIDE the swap callback (not in a later rAF): crossfadeSwap
  // applies the DOM change asynchronously via startViewTransition, so measuring
  // afterwards would race the append. Running it here guarantees the scroller is
  // connected and laid out (getBoundingClientRect forces sync layout) before we
  // size and render.
  crossfadeSwap(() => {
    container.innerHTML = '';
    container.append(seasonView);
    // Turn #app into a flex column so the scroller fills down to the navbar (see
    // body.season-active rules); must be on before setupVirtual measures heights.
    document.body.classList.add('season-active');
    setupVirtual();
  });
}
