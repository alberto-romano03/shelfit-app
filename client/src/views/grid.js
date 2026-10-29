// Shared filtered poster grid for the Movies and Series screens. Renders the
// status chips, genre/sort filters, a movies-only Collections view, and an
// offline Plan-to-Watch fallback from a durable copy.
//
// The online library grid is VIRTUALISED (see ../gridVirtual.js): titles are
// fetched a page at a time from the paginated /api/media endpoint and only the
// poster cards near the viewport are ever in the DOM, so a large library loads
// its first page instantly and never grows the DOM as you scroll. This view owns
// the chrome (chips / filters / offline handling / collections); the scroller
// module owns fetching, layout (section dividers included), recycling and
// per-filter scroll memory.

import { createApi, isAbortError } from '../api.js';
import { navigate, openDetail, onCleanup, cameBack, afterTransition } from '../router.js';
import {
  el,
  icons,
  poster,
  skelGrid,
  skelLine,
  crossfadeSwap,
  segmentedBar,
  stateBlock,
  selectPill,
} from '../ui.js';
import { isServerReachable, markDegraded } from '../network.js';
import { pget, planKey } from '../persist.js';
import { savePlanDetail, getPlanDetail, prunePlanDetails, savePlanTitles } from '../offlineCache.js';
import { createPosterGrid, forgetGridScroll } from '../gridVirtual.js';
import { t } from '../i18n.js';

const STATUSES = [
  { key: 'all', labelKey: 'common.all' },
  { key: 'completed', labelKey: 'status.completed' },
  { key: 'watching', labelKey: 'status.watching' },
  { key: 'plan_to_watch', labelKey: 'status.plan_to_watch' },
  { key: 'paused', labelKey: 'status.paused' },
  { key: 'dropped', labelKey: 'status.dropped' },
];

// TMDB names every collection "<saga> - Collezione" / "<saga> Collection" and so
// on; on the Collections chip and a collection's own page the suffix only
// repeats itself.
const COLLECTION_SUFFIX = /\s*[-–:]?\s*(Collezione|Collection|Colección|Coleção|Filmreihe|Sammlung)$/i;
export function collectionName(name) {
  return String(name || '').replace(COLLECTION_SUFFIX, '').trim() || name;
}
const isComplete = (c) => c.total > 0 && c.owned >= c.total;

// The Collections chip's data for the session, shared by every mount of the
// Movies grid, plus where the list was scrolled when it was left. Coming back
// from a collection paints it at once, in place, with no skeleton. A library
// change marks it stale: the next visit still paints it, then checks quietly.
let collectionsCache = null; // { data, stale } | null
let collectionsScrollY = 0;
window.addEventListener('shelfit:library-changed', () => {
  if (collectionsCache) collectionsCache.stale = true;
});

// Per-section (movie/show) chip / genre / sort selection that survives navigation,
// so opening a poster and coming back restores the same filter. (Scroll position
// is remembered separately, per filter, inside the virtual grid module.) Reset on
// a full page reload.
const gridState = {};

// type -> the next mount opens on the default filter (ignores the remembered one).
const gridFresh = {};

// Where the status bar's chip was when a grid page was left ({ type, geometry,
// collapsed }), so the other grid can glide its chip from there. Read once by the
// next grid mount.
let statusHandoff = null;

// A bottom-nav tab tap: the section opens on its default chip/sort, at the top of
// the list. Its cached pages stay, so it paints at once with no poster reloads;
// they update themselves when the library changes (see ../gridVirtual.js).
export function resetGridSection(path) {
  const type = path === '/movies' ? 'movie' : path === '/series' ? 'show' : null;
  if (!type) return;
  gridFresh[type] = true;
  forgetGridScroll(type);
}

// Shared filtered poster grid for Series and Movies.
export async function gridView(container, type) {
  const ac = new AbortController();
  const api = createApi(ac.signal);

  // A bottom-nav tap flags this section to load fresh: ignore the remembered
  // selection for this one mount.
  const fresh = !!gridFresh[type];
  delete gridFresh[type];

  const saved = fresh ? null : gridState[type];
  const defaultStatus = type === 'movie' ? 'completed' : 'watching';
  // `coll`: the Collections view's filter ('' every collection, 'open', 'done').
  const state = saved
    ? { status: saved.status, genre: saved.genre, sort: saved.sort, coll: saved.coll || '' }
    : { status: defaultStatus, genre: '', sort: 'added_at', coll: '' };

  // Offline lockdown: when the server is unreachable, Movies/Series expose ONLY
  // the Plan to Watch chip (served from the durable cache). Force it active from
  // the first paint. Server reachability — never navigator.onLine — is the single
  // source of truth (the device can be online while the backend is off).
  if (!isServerReachable()) state.status = 'plan_to_watch';

  // Offline Plan-to-Watch data (durable copy whose posters the SW warmed online).
  let planItems = null; // null = not loaded; [] or [{id,title,poster_url,rating}]
  let collectionsData = null; // what the Collections chip shows (from collectionsCache)
  let standaloneOpen = false; // the standalone films grid, kept open across repaints
  // Back on the Collections chip: return to where the list was left.
  let restoreCollectionsScroll = cameBack() && state.status === 'collections';
  let genresShown = null; // the genre list in the pill, joined (skips identical refills)
  let planWarmed = false;

  // "Owned" filters to titles marked as owned on disc (any status). Movies also
  // get a "Collections" chip that reorganizes the grid.
  const chipDefs = STATUSES.slice();
  chipDefs.push({ key: 'owned', labelKey: 'common.owned' });
  if (type === 'movie') chipDefs.push({ key: 'collections', labelKey: 'grid.collections' });

  // --- Status filter ------------------------------------------------------
  // One scrolling segmented track (the app's pattern for a single choice too wide
  // to fit), replacing the old row of loose .chip buttons. The divider after
  // "All" is kept: it separates the no-filter option from the watch statuses.
  const statusBar = segmentedBar({
    options: chipDefs.map((s) => [s.key, t(s.labelKey)]),
    value: state.status,
    ariaLabel: t('grid.libraryFilter'),
    dividerAfter: 'all',
    onChange: (key) => {
      state.status = key;
      syncChrome();
      renderGrid();
    },
  });
  const chipRow = statusBar.el;
  chipRow.classList.add('grid-status'); // the bar held still across Movies <-> Series
  const chipByKey = {};
  chipDefs.forEach((s) => {
    chipByKey[s.key] = statusBar.optionEl(s.key);
  });

  const offlineNote = el('div', {
    class: 'offline-chip-note muted',
    text: t('grid.offlineNote'),
  });
  offlineNote.style.display = 'none';

  // --- Genre / sort filters ----------------------------------------------
  // Both are select pills: our trigger, the OS's list. `short` keeps the pill
  // legible at half width — "Recently Added" does not fit beside its own label.
  const ALL_GENRES = { value: '', text: t('common.allGenres'), short: t('common.all') };
  const genrePill = selectPill({
    label: t('common.genre'),
    options: [ALL_GENRES],
    value: state.genre,
    placeholder: t('common.all'),
    clearable: true,
    onChange: (v) => {
      state.genre = v;
      renderGrid();
    },
  });

  const sortPill = selectPill({
    label: t('grid.sort'),
    options: [
      { value: 'added_at', text: t('grid.sortRecent'), short: t('grid.sortRecentShort') },
      { value: 'title', text: t('grid.sortTitle'), short: 'A\u2013Z' },
      { value: 'rating', text: t('common.rating') },
    ],
    value: state.sort,
    onChange: (v) => {
      state.sort = v;
      renderGrid();
    },
  });
  const filterBar = el('div', { class: 'filter-bar' }, [genrePill.el, sortPill.el]);

  // --- Collections filter (movies only) -----------------------------------
  // Takes the genre/sort row's place on the Collections chip: every collection,
  // the ones still missing films, or the complete ones.
  const collPill = selectPill({
    label: t('grid.collShow'),
    options: [
      { value: '', text: t('common.all') },
      { value: 'open', text: t('grid.collOpen') },
      { value: 'done', text: t('grid.collDone') },
    ],
    value: state.coll,
    placeholder: t('common.all'),
    clearable: true,
    onChange: (v) => {
      state.coll = v;
      if (collectionsData && state.status === 'collections') paintCollections();
    },
  });
  const collBar = el('div', { class: 'filter-bar coll-filter' }, [collPill.el]);

  // --- Alphabetical letter picker (shown only for the Title A–Z sort) ------
  // A secondary nav strip: tap a letter to jump the grid to that section. Only
  // letters with titles in the current filtered view are active; the section
  // currently at the top of the grid is highlighted (fed by the virtual scroller).
  const PICKER_LETTERS = ['#', ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))];
  const letterEls = {};
  const letterPicker = el('div', { class: 'letter-picker' });
  letterPicker.hidden = true; // no reserved space until the A–Z sort is active

  // Show/hide the A–Z picker with a fade in BOTH directions. `hidden` stays the
  // resting state (it must reserve no space in the flex column), so showing flips
  // hidden off first and adds `.in` on the next frame, and hiding drops `.in`
  // first and only sets hidden once the fade has run. Re-entrant: a flip during a
  // pending hide cancels it.
  let letterHideTimer = null;
  function showLetterPicker(on) {
    clearTimeout(letterHideTimer);
    if (on) {
      letterPicker.hidden = false;
      requestAnimationFrame(() => letterPicker.classList.add('in'));
      return;
    }
    if (letterPicker.hidden) return; // already gone — nothing to fade
    letterPicker.classList.remove('in');
    letterHideTimer = setTimeout(() => {
      letterPicker.hidden = true;
    }, 200); // > --dur-short
  }
  for (const L of PICKER_LETTERS) {
    const b = el('button', { class: 'letter-pick', type: 'button', text: L });
    b.addEventListener('click', () => {
      if (!b.disabled) virtual.scrollToGroup(L);
    });
    letterEls[L] = b;
    letterPicker.append(b);
  }
  // Enable only the letters present in the current view (labels from the server's
  // section groups). The active highlight is owned by highlightLetter (fed by the
  // scroller during load), so it isn't touched here.
  function updatePicker(groupLabels) {
    const present = new Set(groupLabels || []);
    for (const L of PICKER_LETTERS) {
      const off = !present.has(L);
      letterEls[L].disabled = off;
      letterEls[L].classList.toggle('is-disabled', off);
    }
  }
  // Highlight the section currently at the top of the grid (from the scroller).
  function highlightLetter(label) {
    for (const L of PICKER_LETTERS) letterEls[L].classList.toggle('is-active', L === label);
  }

  // --- Content region -----------------------------------------------------
  // Two elements share the content area, one visible at a time: the virtual
  // scroller (online library) and a classic .grid (collections + offline
  // Plan-to-Watch + empty/error states).
  const virtual = createPosterGrid({
    type,
    onItemClick: (item) => openDetail(`/detail/${item.id}`),
    onActiveGroup: highlightLetter,
    onUpdate: applyViewInfo, // a background check swapped in newer content
  });
  const simpleGrid = skelGrid(12);

  container.append(chipRow, offlineNote, filterBar, collBar, letterPicker, simpleGrid, virtual.el);

  function setMode(mode) {
    const useVirtual = mode === 'virtual';
    virtual.el.style.display = useVirtual ? '' : 'none';
    simpleGrid.style.display = useVirtual ? 'none' : '';
    // In virtual mode the shell becomes a flex column (see styles.css) so the
    // scroller stretches from the chrome down to the navbar. The view class scopes
    // the view's flex layout; the body class scopes the #app flex column. The
    // simple grid (collections / offline) flows normally without these.
    container.classList.toggle('view-grid-virtual', useVirtual);
    document.body.classList.toggle('grid-virtual-active', useVirtual);
  }
  setMode('simple'); // start on the skeleton grid until the first load resolves

  // Genre/sort filters don't apply to the collections view, which has its own
  // (and neither shows offline, where only Plan to Watch is available).
  function syncChrome() {
    const offline = !isServerReachable();
    const inCollections = state.status === 'collections';
    filterBar.style.display = inCollections || offline ? 'none' : '';
    collBar.style.display = inCollections && !offline ? '' : 'none';
  }

  // Fill the genre pill from the type-wide list the server returns with page 1
  // (genres reflect the whole type library regardless of status), again only
  // when that list changes.
  function populateGenres(genres) {
    if (!Array.isArray(genres)) return;
    const sig = genres.join('\n');
    if (sig === genresShown) return;
    genresShown = sig;
    genrePill.setOptions([ALL_GENRES, ...genres.map((g) => ({ value: g, text: g }))]);
    genrePill.set(state.genre);
  }

  // Genres and the letter picker for the view the virtual grid shows.
  function applyViewInfo(res) {
    if (res) populateGenres(res.genres);
    // Letter picker: only for the alphabetical (Title A–Z) sort.
    if (res && state.sort === 'title' && res.groups && res.groups.length) {
      updatePicker(res.groups);
      showLetterPicker(true);
    } else {
      showLetterPicker(false);
    }
  }

  // --- Offline chip lockdown ---------------------------------------------
  function lockChips(offline) {
    // Offline the grid serves only Plan to Watch, so every other option is hidden
    // outright — INCLUDING "All", which used to sit there greyed out. A track
    // holding one live option and one dead one reads as broken; the collapsed
    // state below drops the track chrome so the lone chip stands on its own.
    for (const key of Object.keys(chipByKey)) {
      if (key === 'plan_to_watch') continue; // always available offline
      const chip = chipByKey[key];
      if (!chip) continue;
      chip.style.display = offline ? 'none' : '';
      chip.disabled = offline;
    }
    chipRow.classList.toggle('segbar--collapsed', offline);
    // Widths just changed — re-measure so the chip sits on its option.
    statusBar.refresh();
    offlineNote.style.display = offline ? '' : 'none';
  }
  // The chip the user had selected before an outage forced Plan to Watch, so
  // recovery can put them back where they were. Without this, any offline blip —
  // including a spurious one — silently moved the section to Plan to Watch for the
  // rest of the session (teardown persists state.status into gridState).
  let statusBeforeOffline = null;
  function goOffline() {
    if (state.status !== 'plan_to_watch') {
      statusBeforeOffline = state.status;
      state.status = 'plan_to_watch';
      statusBar.set('plan_to_watch');
    }
    lockChips(true);
    syncChrome();
    renderGrid();
  }
  // Undo goOffline's forced chip change. Only ever restores a chip WE replaced —
  // if the user picked Plan to Watch themselves, or changed chips while offline,
  // there is nothing to put back.
  function restoreStatusAfterOffline() {
    if (!statusBeforeOffline) return;
    if (state.status === 'plan_to_watch') {
      state.status = statusBeforeOffline;
      statusBar.set(state.status);
    }
    statusBeforeOffline = null;
  }
  function onServerChange(ev) {
    const reachable = ev.detail && ev.detail.reachable;
    if (reachable) {
      restoreStatusAfterOffline();
      lockChips(false);
      syncChrome();
      renderGrid(); // swap the offline plan grid back to the live virtual grid
    } else {
      goOffline();
    }
  }
  window.addEventListener('shelfit:server-change', onServerChange);
  // Single teardown for the whole view (the router runs every registered
  // callback, in order):
  // abort in-flight fetches, tear down the virtual scroller (its scroll/resize
  // listeners + api), drop the server-change listener, and remember the chip /
  // genre / sort so returning to this section restores the same filter.
  onCleanup(() => {
    ac.abort();
    clearTimeout(letterHideTimer); // a pending picker-hide must not outlive the view
    virtual.destroy();
    window.removeEventListener('shelfit:server-change', onServerChange);
    // The .view container and body persist across views — clear our layout classes
    // so the next view doesn't inherit the grid's flex layout.
    container.classList.remove('view-grid-virtual');
    document.body.classList.remove('grid-virtual-active');
    gridState[type] = { status: state.status, genre: state.genre, sort: state.sort, coll: state.coll };
    statusHandoff = {
      type,
      geometry: statusBar.geometry(),
      collapsed: chipRow.classList.contains('segbar--collapsed'),
    };
    if (state.status === 'collections') collectionsScrollY = window.scrollY;
  });

  // Bumped on every renderGrid() call; an async render whose token is stale (a
  // newer chip/sort/genre change started meanwhile) aborts its swap.
  let renderSeq = 0;

  async function renderGrid() {
    const seq = ++renderSeq;

    if (state.status === 'collections') {
      setMode('simple');
      showLetterPicker(false);
      renderCollections();
      return;
    }

    // Offline → Plan to Watch from the durable cache (the only offline view).
    if (!isServerReachable()) {
      setMode('simple');
      showLetterPicker(false);
      filterBar.style.display = 'none';
      if (planItems) renderPlanGrid();
      else loadPlanOffline();
      return;
    }

    // Online → the virtual library grid for the active status/genre/sort. The
    // "Owned" chip isn't a real status: it drops the status filter and asks the
    // server for owned titles across every status instead.
    try {
      setMode('virtual');
      const owned = state.status === 'owned';
      const res = await virtual.load({
        status: owned ? '' : state.status,
        genre: state.genre,
        sort: state.sort,
        owned,
      });
      if (seq !== renderSeq) return; // superseded by a newer selection
      applyViewInfo(res);
      if (!planWarmed) {
        planWarmed = true;
        warmAndPersistPlan(); // fire-and-forget: keep the offline copy fresh
      }
    } catch (err) {
      if (isAbortError(err)) return; // navigated away
      if (!isServerReachable()) {
        // Transport failure OR a 5xx from the reverse proxy while the backend is
        // down (api.js flags both) → switch the whole view to offline mode.
        markDegraded();
        goOffline();
        return;
      }
      setMode('simple');
      showLetterPicker(false);
      simpleGrid.className = 'grid';
      simpleGrid.innerHTML = '';
      simpleGrid.append(
        stateBlock({
          kind: 'error',
          title: t('grid.loadError'),
          action: { onClick: () => navigate(location.pathname + location.search, { replace: true }) },
        })
      );
    }
  }

  // --- Plan to Watch: durable cache for offline --------------------------
  async function warmAndPersistPlan() {
    try {
      const data = await api.planToWatch();
      const titles = data.titles || [];
      // Persist BOTH types' lists — one online visit to EITHER grid makes the
      // OTHER grid's Plan to Watch available offline too.
      savePlanTitles(titles);
      planItems = pget(planKey(type)) || [];
      warmPlanDetails(titles); // warm each planned title's read-only offline detail
    } catch (err) {
      if (isAbortError(err)) return;
      /* offline — the persisted copy, if any, still serves */
    }
  }

  async function warmPlanDetails(titles) {
    try {
      prunePlanDetails(titles.map((t) => t.id));
      let budget = 30; // max detail fetches per grid mount
      for (const t of titles) {
        if (budget <= 0) break;
        if (getPlanDetail(t.id)) continue; // already cached
        budget--;
        try {
          const detail = await api.mediaDetail(t.id);
          savePlanDetail(detail);
        } catch (err) {
          if (isAbortError(err)) return; // navigated away — stop warming
          /* skip this title; the rest may still cache */
        }
      }
    } catch {
      /* best-effort — a disabled/full store just means no offline details */
    }
  }

  // When the library can't be loaded, render the Plan to Watch poster grid from
  // the durable copy (posters come from the SW-warmed cache).
  async function loadPlanOffline() {
    if (planItems) return;
    const stored = pget(planKey(type));
    if (Array.isArray(stored)) {
      planItems = stored;
      if (state.status === 'plan_to_watch') renderPlanGrid();
      return;
    }
    // Last resort: the SW-cached endpoint. Persist both types from whatever it
    // returns so a later visit to either grid is covered.
    try {
      const data = await api.planToWatch();
      savePlanTitles(data.titles || []);
      planItems = pget(planKey(type)) || [];
    } catch (err) {
      if (isAbortError(err)) return;
      // Nothing cached anywhere — show a clear message but leave planItems
      // UNLOADED (null) so a later render (chip tap / reconnect) retries.
      if (state.status === 'plan_to_watch') {
        crossfadeSwap(() => {
          simpleGrid.className = 'grid';
          simpleGrid.innerHTML = '';
          simpleGrid.append(
            stateBlock({
              kind: 'offline',
              title: t('grid.noOfflineCopy'),
              detail:
                t('grid.noOfflineCopyDetail'),
            })
          );
        });
      }
      return;
    }
    if (state.status === 'plan_to_watch') renderPlanGrid();
  }

  function renderPlanGrid() {
    filterBar.style.display = 'none';
    setMode('simple');
    if (!planItems.length) {
      crossfadeSwap(() => {
        simpleGrid.className = 'grid';
        simpleGrid.innerHTML = '';
        simpleGrid.append(
          stateBlock({
            icon: 'popcorn',
            title: t('grid.planEmpty'),
            detail: t('grid.planEmptyDetail'),
          })
        );
      });
      return;
    }
    const cards = planItems.map((it) => {
      const card = poster(it.poster_url, it.title);
      if (it.rating) {
        card.append(el('div', { class: 'rating-badge', html: `★ ${it.rating}` }));
      }
      card.addEventListener('click', () => openDetail(`/detail/${it.id}`));
      return card;
    });
    crossfadeSwap(() => {
      simpleGrid.className = 'grid';
      simpleGrid.innerHTML = '';
      simpleGrid.append(...cards);
    });
  }

  // --- Collections view (movies only) ------------------------------------
  // A saved copy paints at once (back from a collection, or the chip picked
  // again), where the list was left when you came back; a stale one is then
  // fetched again quietly and repainted only if something changed. With no copy
  // yet, rows of shimmer hold the shape of the list until it loads.
  async function renderCollections() {
    filterBar.style.display = 'none';
    simpleGrid.className = '';
    const saved = collectionsCache;
    if (saved) {
      collectionsData = saved.data;
      paintCollections();
      if (restoreCollectionsScroll) {
        restoreCollectionsScroll = false;
        const y = collectionsScrollY;
        window.scrollTo(0, y);
        requestAnimationFrame(() => window.scrollTo(0, y));
      }
      if (!saved.stale) return;
      await afterTransition(); // check once the page has faded in
    } else {
      simpleGrid.innerHTML = '';
      simpleGrid.append(collectionsSkeleton());
    }
    let data;
    try {
      data = await api.collections();
    } catch (err) {
      if (isAbortError(err) || saved) return; // the saved copy stays on screen
      if (!isServerReachable()) {
        markDegraded();
        return; // keep the shimmer; recovery re-renders
      }
      simpleGrid.innerHTML = '';
      simpleGrid.append(
        stateBlock({
          kind: 'error',
          title: t('grid.collectionsError'),
          action: { onClick: () => navigate(location.pathname + location.search, { replace: true }) },
        })
      );
      return;
    }
    collectionsCache = { data, stale: false };
    if (saved && JSON.stringify(data) === JSON.stringify(saved.data)) return; // unchanged
    collectionsData = data;
    if (state.status !== 'collections') return; // user switched away meanwhile
    paintCollections();
  }

  function collectionsSkeleton() {
    return el(
      'div',
      { class: 'cset-rows' },
      Array.from({ length: 3 }, () =>
        el('div', { class: 'cset-row' }, [
          el('div', { class: 'poster-card cset-poster skeleton' }),
          el('div', { class: 'cset-side' }, [
            skelLine({ width: '65%', height: '16px' }),
            skelLine({ cls: 'sm', width: '45%' }),
          ]),
        ])
      )
    );
  }

  function paintCollections() {
    const { collections = [], standalone = [] } = collectionsData || {};
    const out = document.createDocumentFragment();

    if (!collections.length && !standalone.length) {
      out.append(
        stateBlock({
          icon: 'layers',
          title: t('grid.collectionsEmpty'),
          detail: t('grid.collectionsEmptyDetail'),
        })
      );
    }

    if (collections.length) {
      // What the whole shelf adds up to, then the collections the filter keeps.
      const owned = collections.reduce((a, c) => a + c.owned, 0);
      const total = collections.reduce((a, c) => a + c.total, 0);
      out.append(
        el('div', { class: 'cset-summary' }, [
          el('div', {
            class: 'cset-summary-title',
            text: t('grid.collSummary', { n: collections.length, done: collections.filter(isComplete).length }),
          }),
          el('div', { class: 'cset-summary-sub', text: t('grid.collFilms', { owned, total }) }),
        ])
      );
      const shown = collections.filter((c) => !state.coll || (state.coll === 'done') === isComplete(c));
      if (shown.length) {
        out.append(el('div', { class: 'cset-rows' }, shown.map(collectionRow)));
      } else {
        out.append(
          el('div', { class: 'muted cset-none', text: t(state.coll === 'done' ? 'grid.collNoneDone' : 'grid.collNoneOpen') })
        );
      }
    }

    if (standalone.length) out.append(standaloneSection(standalone));

    crossfadeSwap(() => {
      simpleGrid.className = '';
      simpleGrid.innerHTML = '';
      simpleGrid.append(out);
    });
  }

  // One collection: its own poster large on the left; on the right the name, how
  // much of it is in the library, and the owned films along the bottom (release
  // order, the last slot turning into "+N" past four).
  const SHELF_MAX = 4;
  function collectionRow(c) {
    const films = c.owned_movies || [];
    const shown = films.length > SHELF_MAX ? films.slice(0, SHELF_MAX - 1) : films;
    const shelf = el(
      'div',
      { class: 'cset-shelf' },
      shown.map((m) => {
        const card = poster(m.poster_url, m.title);
        card.classList.add('cset-film');
        return card;
      })
    );
    if (films.length > shown.length) {
      shelf.append(el('span', { class: 'cset-more', text: `+${films.length - shown.length}` }));
    }
    const done = isComplete(c);
    const art = poster(c.poster_url, c.name);
    art.classList.add('cset-poster');
    return el('button', { class: 'cset-row', type: 'button', onClick: () => navigate(`/collection/${c.id}`) }, [
      art,
      el('div', { class: 'cset-side' }, [
        el('div', { class: 'cset-name', text: collectionName(c.name) }),
        el('div', {
          class: `cset-meta${done ? ' is-done' : ''}`,
          text: done ? t('grid.collComplete', { n: c.total }) : t('grid.inLibrary', { owned: c.owned, total: c.total }),
        }),
        shelf,
      ]),
    ]);
  }

  // Movies in no collection: a row (three of their posters stacked, a count, a
  // chevron) that opens their poster grid underneath. The grid is built on the
  // first open.
  function standaloneSection(films) {
    const grid = el('div', { class: 'grid cset-sa-grid' });
    function fill() {
      if (grid.childElementCount) return;
      for (const m of films) {
        const card = poster(m.poster_url, m.title);
        if (m.rating) card.append(el('div', { class: 'rating-badge', html: `★ ${m.rating}` }));
        card.addEventListener('click', () => openDetail(`/detail/${m.item_id}`));
        grid.append(card);
      }
    }
    function sync() {
      if (standaloneOpen) fill();
      grid.style.display = standaloneOpen ? '' : 'none';
      row.setAttribute('aria-expanded', String(standaloneOpen));
    }
    const row = el(
      'button',
      {
        class: 'cset-sa',
        type: 'button',
        onClick: () => {
          standaloneOpen = !standaloneOpen;
          sync();
        },
      },
      [
        el(
          'div',
          { class: 'cset-sa-art' },
          films.slice(0, 3).map((m) => poster(m.poster_url, ''))
        ),
        el('div', { class: 'cset-sa-text' }, [
          el('div', { class: 'cset-sa-name', text: t('grid.standaloneTitle') }),
          el('div', { class: 'cset-sa-meta', text: t('grid.standaloneCount', { n: films.length }) }),
        ]),
        el('span', { class: 'cset-sa-chev', html: icons.forward }),
      ]
    );
    sync();
    return el('div', { class: 'cset-sa-section' }, [row, grid]);
  }

  // --- Mount --------------------------------------------------------------
  lockChips(!isServerReachable());
  // Arriving from the other grid (Movies <-> Series): the bar is held still
  // through the page fade (styles.css, data-vt='grid') and its chip glides over
  // from where the other page's chip was. Not when either bar is down to its
  // single offline chip: there's nothing to travel between.
  const handoff = statusHandoff;
  statusHandoff = null;
  if (
    handoff &&
    handoff.type !== type &&
    !handoff.collapsed &&
    !chipRow.classList.contains('segbar--collapsed') &&
    document.documentElement.dataset.vt === 'grid'
  ) {
    statusBar.glideFrom(handoff.geometry);
  }
  syncChrome();
  renderGrid();
}
