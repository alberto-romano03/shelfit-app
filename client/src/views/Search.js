// Search screen (/search) — a live TMDB search with debounced input, falling
// back to browsable Explore rows while the query is empty. Also exports the
// shared "Add to library" modal (openAddModal) used here and by other views.

import { api, createApi, isAbortError } from '../api.js';
import { navigate, openDetail, onCleanup } from '../router.js';
import {
  el,
  poster,
  toast,
  openModal,
  skelGrid,
  crossfadeSwap,
  stateBlock,
  lucideIcon,
} from '../ui.js';
import { isServerReachable, markDegraded } from '../network.js';
import { buildStatusBento } from '../statusSelect.js';
import { t } from '../i18n.js';

// A query to pre-fill and run automatically the next time the Search view mounts.
// Set by the Share Target handler (main.js) when a shared item carried no TMDB
// link, so the shared title/text becomes an immediate search. One-shot: consumed
// (and cleared) on the next Search mount so it never re-triggers.
let pendingQuery = null;
export function setPendingSearch(q) {
  pendingQuery = typeof q === 'string' && q.trim() ? q.trim() : null;
}

// Explore payload, cached for the life of the tab so reopening Search paints the
// rows instantly instead of refetching and rebuilding them on every visit. (The
// per-mount flag below only ever guarded re-entry WITHIN one mount, so every
// visit paid a full round-trip plus a four-row re-render.)
//
// The server already memoizes the expensive TMDB half for ~90 min; this removes
// the round-trip and the rebuild layered on top of it. A copy older than the TTL
// still paints immediately and is revalidated behind the render, so the rows are
// never blank while waiting.
//
// Invalidated on any library mutation: `already_added` is overlaid per request
// server-side, so without this a title you just added would still show without
// its "Added" badge when you came back.
const EXPLORE_TTL_MS = 10 * 60 * 1000;
let exploreCache = null; // { at, data } | null
window.addEventListener('shelfit:library-changed', () => {
  exploreCache = null;
});

export default async function Search(container) {
  const ac = new AbortController();
  onCleanup(() => ac.abort());
  const api = createApi(ac.signal); // shadows the default client for these fetches

  // Two coexisting modes in one scroll view: the search input at the top, then
  // either the live results (while typing) or the Explore rows (while empty).
  const input = el('input', {
    class: 'search-input',
    type: 'search',
    placeholder: t('search.placeholder'),
    autocomplete: 'off',
    autocapitalize: 'none',
  });
  const searchHeader = el('div', { class: 'search-header' }, [input]);
  const resultsEl = el('div', { class: 'search-results' });
  const exploreEl = el('div', { class: 'explore' });
  container.append(searchHeader, resultsEl, exploreEl);
  input.focus();

  // Tapping any poster (search result OR explore) behaves like the old search:
  // open the existing detail if the title is already in the library, otherwise
  // open the add-to-library sheet.
  function openTitle(r) {
    if (r.already_added && r.item_id) openDetail(`/detail/${r.item_id}`);
    else openAddModal(r);
  }

  function showExplore(on) {
    exploreEl.style.display = on ? '' : 'none';
    resultsEl.style.display = on ? 'none' : '';
  }

  // --- Explore -------------------------------------------------------------
  // Guards re-entry within THIS mount; the payload itself is cached at module
  // scope above, so it survives navigating away and back.
  let exploreLoaded = false;

  function exploreSkeleton() {
    exploreEl.innerHTML = '';
    for (let s = 0; s < 4; s++) {
      const cards = [];
      for (let i = 0; i < 6; i++) cards.push(el('div', { class: 'poster-card explore-card skeleton' }));
      exploreEl.append(
        el('div', { class: 'explore-row' }, [
          skelLineTitle(),
          el('div', { class: 'explore-scroller' }, cards),
        ])
      );
    }
  }

  function renderExplore(data) {
    const sections = (data && data.sections) || [];
    exploreEl.innerHTML = '';
    if (data && data.capped && !sections.length) {
      exploreEl.append(
        stateBlock({
          icon: 'wallet',
          title: t('search.suggestionsPaused'),
          detail: t('search.budgetReached'),
        })
      );
      return;
    }
    if (!sections.length) {
      exploreEl.append(
        stateBlock({ icon: 'popcorn', title: t('search.noSuggestions') })
      );
      return;
    }
    for (const sec of sections) {
      const scroller = el('div', { class: 'explore-scroller' });
      for (const it of sec.items) {
        const card = poster(it.thumb_url, it.title);
        card.classList.add('explore-card');
        if (it.already_added) card.append(el('div', { class: 'added-badge', text: t('search.added') }));
        card.addEventListener('click', () => openTitle(it));
        scroller.append(card);
      }
      // Row titles come from the server in English; translate by the row's stable
      // key, falling back to the server text for a key we don't know.
      const titleKey = `search.explore.${sec.key}`;
      const rowTitle = t(titleKey);
      exploreEl.append(
        el('div', { class: 'explore-row' }, [
          el('div', { class: 'explore-row-title', text: rowTitle === titleKey ? sec.title : rowTitle }),
          scroller,
        ])
      );
    }
  }

  async function loadExplore() {
    if (exploreLoaded) return;
    // A cached payload paints straight away — no skeleton, no wait. Only a cold
    // cache shows the shimmer. `exploreLoaded` is set before the await either way,
    // so a second call within this mount can't start a duplicate fetch.
    const cached = exploreCache;
    if (cached) {
      exploreLoaded = true;
      renderExplore(cached.data);
      if (Date.now() - cached.at < EXPLORE_TTL_MS) return; // fresh — done
      // Stale: fall through and revalidate behind the render already on screen.
    } else {
      exploreSkeleton();
    }
    try {
      const data = await api.explore();
      if (ac.signal.aborted) return;
      exploreCache = { at: Date.now(), data };
      exploreLoaded = true;
      renderExplore(data);
    } catch (err) {
      if (isAbortError(err)) return;
      // A revalidation that fails leaves the copy already on screen alone — the
      // view isn't degraded, so it must not be flagged for a recovery re-mount.
      if (cached) return;
      if (!isServerReachable()) {
        markDegraded(); // server unreachable (transport failure or backend 5xx); keep the skeleton rows, recovery re-renders
        return;
      }
      exploreEl.innerHTML = '';
      exploreEl.append(
        stateBlock({
          kind: 'error',
          tier: 'section',
          title: t('search.suggestionsError'),
          action: { onClick: () => loadExplore() },
        })
      );
    }
  }

  // --- Search ---------------------------------------------------------------
  let timer = null;
  // A pending debounce would fire after navigate-away and run a whole search
  // against this view's detached DOM; drop it with the view.
  onCleanup(() => clearTimeout(timer));
  let reqId = 0;

  async function run() {
    const q = input.value.trim();
    if (!q) {
      showExplore(true);
      loadExplore();
      return;
    }
    showExplore(false);
    const myReq = ++reqId;
    resultsEl.innerHTML = '';
    resultsEl.append(skelGrid(9)); // poster-grid ghost (matches the result layout)
    try {
      const data = await api.search(q, 'all');
      if (myReq !== reqId) return; // a newer request superseded this one
      if (data && data.capReached) {
        resultsEl.innerHTML = '';
        resultsEl.append(
          stateBlock({
            icon: 'wallet',
            title: t('search.searchPaused'),
            detail: t('search.budgetReached'),
          })
        );
        return;
      }
      renderResults(data.results || []);
    } catch (err) {
      if (isAbortError(err)) return; // navigated away or superseded — ignore
      if (myReq !== reqId) return;
      if (!isServerReachable()) {
        // Server unreachable (transport failure or backend 5xx); keep the ghost grid, recovery re-renders.
        markDegraded();
        resultsEl.innerHTML = '';
        resultsEl.append(skelGrid(9));
        return;
      }
      resultsEl.innerHTML = '';
      resultsEl.append(
        stateBlock({
          kind: 'error',
          title: t('search.searchError'),
          error: err.message,
          action: { label: t('search.searchAgain'), onClick: () => run() },
        })
      );
    }
  }

  function renderResults(list) {
    if (!list.length) {
      crossfadeSwap(() => {
        resultsEl.innerHTML = '';
        resultsEl.append(
        stateBlock({
          title: t('search.noResults'),
          detail: t('search.noResultsDetail'),
        })
      );
      });
      return;
    }
    const movies = list.filter((r) => r.type === 'movie');
    const shows = list.filter((r) => r.type === 'show');
    const frag = document.createDocumentFragment();
    if (movies.length) frag.append(resultSection(t('media.movies'), movies));
    if (shows.length) frag.append(resultSection(t('media.series'), shows));
    crossfadeSwap(() => {
      resultsEl.innerHTML = '';
      resultsEl.append(frag);
    });
  }

  function resultSection(title, list) {
    const grid = el('div', { class: 'grid' });
    for (const r of list) {
      const cell = el('div', {});
      const card = poster(r.thumb_url, r.title);
      card.classList.add('result-card');
      if (r.already_added) card.append(el('div', { class: 'added-badge', text: t('search.added') }));
      card.addEventListener('click', () => openTitle(r));
      cell.append(
        card,
        el('div', {
          class: 'wc-title',
          style: { marginTop: '4px', fontSize: '12px' },
          text: `${r.title}${r.year ? ' (' + r.year + ')' : ''}`,
        })
      );
      grid.append(cell);
    }
    return el('div', { class: 'search-section' }, [
      el('div', { class: 'search-section-title', text: title }),
      grid,
    ]);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 400);
  });

  // Empty on open → Explore is the landing content.
  showExplore(true);
  loadExplore();

  // Shared-in search (via the Share Target handler): pre-fill the input and run
  // the search immediately, then clear the one-shot so a later visit opens empty.
  if (pendingQuery) {
    input.value = pendingQuery;
    pendingQuery = null;
    run();
  }
}

// A shimmer stand-in for an Explore row's title line.
function skelLineTitle() {
  const n = el('div', { class: 'skeleton skel-line' });
  n.style.width = '38%';
  n.style.height = '16px';
  n.style.margin = '0 0 10px';
  return n;
}

// Shared "Add to library" dialog. Title + collapsible summary, a separator, then
// the same status bento used on the detail page — tapping a status adds the
// title with it. By default it navigates to the new title's detail page (Search
// behaviour); pass onAdded to instead handle it in place (collection views).
export function openAddModal(r, { onAdded } = {}) {
  openModal((modal, close) => {
    // --- Title + type ---
    const heading = el('h3', { text: `${r.title}${r.year ? ' (' + r.year + ')' : ''}` });
    const typeLine = el('div', { class: 'muted', text: r.type === 'movie' ? t('media.movie') : t('media.tvSeries') });

    // --- Summary with Show more / Show less (kept compact) ---
    let summary = null;
    if (r.overview) {
      const ov = el('div', { class: 'overview clamp', text: r.overview });
      const toggle = el('div', { class: 'overview-toggle', text: t('common.showMore') });
      let expanded = false;
      toggle.addEventListener('click', () => {
        expanded = !expanded;
        ov.classList.toggle('clamp', !expanded);
        toggle.textContent = expanded ? t('search.showLess') : t('common.showMore');
      });
      summary = el('div', { class: 'add-summary' }, [ov, toggle]);
    }

    // --- Status bento — tap to add with that status (highlighted); tap the same
    // one again to undo (removes from library, un-highlights); tap a different
    // one to change the status. The modal never auto-closes — the user dismisses
    // it via Cancel / View full details themselves. ---
    let itemId = null; // library id once added; null when not in the library
    let currentStatus = null;
    let busy = false;
    let bento;
    const clearHighlights = () =>
      bento.querySelectorAll('.status-cell').forEach((c) => c.classList.remove('selected'));

    bento = buildStatusBento({
      onSelect: async (status, cell) => {
        if (busy) return;
        busy = true;
        try {
          if (itemId === null) {
            // Not yet added → add with this status.
            const res = await api.addMedia(r.tmdb_id, r.type, status);
            itemId = res && res.id;
            currentStatus = status;
            clearHighlights();
            cell.classList.add('selected');
            toast(t('search.addedToLibrary'), 'ok');
            if (onAdded) onAdded(itemId);
          } else if (status === currentStatus) {
            // Reclick the active status → undo (remove from library).
            await api.deleteMedia(itemId);
            itemId = null;
            currentStatus = null;
            cell.classList.remove('selected');
            toast(t('search.removedFromLibrary'), 'ok');
          } else {
            // Added already → just change the status.
            await api.updateMedia(itemId, { status });
            currentStatus = status;
            clearHighlights();
            cell.classList.add('selected');
            toast(t('search.statusUpdated'), 'ok');
          }
        } catch (err) {
          if (err.status === 409 && err.data && err.data.item_id) {
            // Already in the library (e.g. added elsewhere) — adopt it.
            itemId = err.data.item_id;
            currentStatus = status;
            clearHighlights();
            cell.classList.add('selected');
            toast(t('search.alreadyInLibrary'));
          } else {
            toast(err.message || t('search.somethingWrong'), 'bad');
          }
        } finally {
          busy = false;
        }
      },
    });

    // Explicit way to open the full details page (Preview route; it forwards to
    // the real detail if the title is already in the library).
    const detailsBtn = el(
      'button',
      {
        class: 'btn btn-secondary',
        onClick: () => {
          close();
          navigate(`/preview/${r.type}/${r.tmdb_id}`);
        },
      },
      [lucideIcon('eye', 'btn-lucide'), el('span', { text: t('search.viewDetails') })]
    );

    modal.append(
      heading,
      typeLine,
      summary,
      el('hr', { class: 'status-sep' }),
      el('div', { class: 'field-label', text: t('search.addAs') }),
      bento,
      el('hr', { class: 'status-sep' }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.cancel') }),
    ]),
        detailsBtn,
      ])
    );
  });
}
