// Search screen (/search) — the counter you ask at, and the aisles you browse
// when you have not asked anything yet.
//
// Two coexisting modes under one sticky search field. With a query: a live
// search, either against TMDB or (with the collection toggle on) against the
// user's own rows, answered as one list ordered the way the search returned it.
// Empty: the Explore feed, laid out as rows that each say what they are —
// a handful of picks with their synopsis, one ranked row, a mood strip that
// swaps its own row, then the plain shelves.
//
// Also exports the shared "Add to library" modal (openAddModal) used here and
// by other views.

import { api, createApi, isAbortError } from '../api.js';
import { navigate, openDetail, onCleanup } from '../router.js';
import {
  el,
  poster,
  toast,
  openModal,
  crossfadeSwap,
  stateBlock,
  lucideIcon,
  icons,
  segmentedControl,
  typewriterPlaceholder,
} from '../ui.js';
import { isServerReachable, markDegraded } from '../network.js';
import { buildStatusBento } from '../statusSelect.js';
import { pget, pset, PK } from '../persist.js';
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
// rows instantly instead of refetching and rebuilding them on every visit.
//
// The server already memoizes the expensive TMDB half for ~90 min; this removes
// the round-trip and the rebuild layered on top of it. A copy older than the TTL
// still paints immediately and is revalidated behind the render, so the rows are
// never blank while waiting.
//
// Invalidated on any library mutation: `already_added` is overlaid per request
// server-side, so without this a title you just added would still show without
// its "in your collection" mark when you came back.
const EXPLORE_TTL_MS = 10 * 60 * 1000;
let exploreCache = null; // { at, data } | null
window.addEventListener('shelfit:library-changed', () => {
  exploreCache = null;
});

// The rows that stay a plain shelf, in the order they appear. The eyebrow says
// what the row IS; the title is the row's name.
const SHELVES = ['popular_tv', 'top_rated', 'popular_movies', 'on_the_air'];

// The mood strip. Each tile takes one of the design system's named palette
// triads (ink / mid / pale) and its own display face; the keys are the Explore
// section keys, so a tile maps straight onto a row the server already sends.
const MOODS = [
  { key: 'feel_good', ink: 'espresso', mid: 'clementine', pale: 'oat-milk' },
  { key: 'edge', ink: 'slate-ink', mid: 'harbor', pale: 'fog' },
  { key: 'epic', ink: 'bark', mid: 'amber', pale: 'oat' },
  { key: 'binge', ink: 'rose-ink', mid: 'rose', pale: 'shell' },
  { key: 'mindbending', ink: 'plum-ink', mid: 'iris', pale: 'powder' },
  { key: 'easy', ink: 'deepsea', mid: 'teal', pale: 'chalk' },
];

// Examples for the typed placeholder. Titles are proper nouns, so they read the
// same in either language and are deliberately not translated. One is picked at
// random per mount, so the field does not always open with the same suggestion.
const PLACEHOLDER_TITLES = [
  'Blade Runner',
  'Il padrino',
  'Interstellar',
  'Breaking Bad',
  'La vita è bella',
  'Twin Peaks',
  'Parasite',
  "C'era una volta il West",
  'Arcane',
  'Dune',
];

const RECENT_MAX = 5;
const RECENT_MIN_LEN = 3;

function recentQueries() {
  const list = pget(PK.recentSearches);
  return Array.isArray(list) ? list.filter((q) => typeof q === 'string') : [];
}

// A row title translated by its stable key, falling back to the English text
// the server sent for a key we do not know.
function sectionTitle(sec) {
  const key = `search.explore.${sec.key}`;
  const label = t(key);
  return label === key ? sec.title : label;
}

export default async function Search(container) {
  const ac = new AbortController();
  onCleanup(() => ac.abort());
  const api = createApi(ac.signal); // shadows the default client for these fetches

  const state = {
    query: '',
    scope: 'all', // all | movie | show
    view: 'rows', // rows | posters
    mine: false, // search the collection instead of TMDB
    mood: MOODS[0].key,
    results: null, // the last answered search
  };

  // --- The counter ---------------------------------------------------------
  const input = el('input', {
    class: 'fc-input',
    type: 'search',
    autocomplete: 'off',
    autocapitalize: 'none',
    'aria-label': t('search.placeholder'),
  });
  const example = PLACEHOLDER_TITLES[Math.floor(Math.random() * PLACEHOLDER_TITLES.length)];
  onCleanup(typewriterPlaceholder(input, example, { speed: 100 }));

  const clearBtn = el('button', {
    class: 'fc-clear',
    type: 'button',
    'aria-label': t('search.clear'),
    html: icons.close,
  });
  // Collection scope. A plain on/off: there are only two answers, and the glyph
  // carries the meaning.
  const mineBtn = el(
    'button',
    {
      class: 'fc-mine',
      type: 'button',
      'aria-pressed': 'false',
      'aria-label': t('search.mineLabel'),
    },
    [lucideIcon('library-big', 'lc')]
  );
  const scope = segmentedControl({
    options: [
      ['all', t('search.scopeAll')],
      ['movie', t('search.scopeMovies')],
      ['show', t('search.scopeSeries')],
    ],
    value: 'all',
    ariaLabel: t('search.scopeAll'),
    onChange: (v) => {
      state.scope = v;
      paintResults();
    },
  });
  const counter = el('div', { class: 'fc' }, [
    el('div', { class: 'fc-row' }, [
      el('div', { class: 'fc-field' }, [
        el('span', { class: 'fc-ico', 'aria-hidden': 'true', html: icons.search }),
        input,
        clearBtn,
      ]),
      mineBtn,
    ]),
    el('div', { class: 'fc-tools' }, [scope.el]),
  ]);

  const resultsEl = el('div', { class: 'search-results' });
  const exploreEl = el('div', { class: 'explore' });
  container.append(counter, resultsEl, exploreEl);
  input.focus();

  // The results toolbar lives outside the sticky chrome, so the sticky block
  // stays short. One element, reused across renders.
  const countEl = el('div', { class: 'ht-count' });
  const viewBtn = el('button', {
    class: 'ht-view',
    type: 'button',
    'aria-label': t('search.viewPosters'),
    html: icons.grid,
  });
  const resultsBar = el('div', { class: 'ht-bar' }, [countEl, viewBtn]);

  function showExplore(on) {
    exploreEl.style.display = on ? '' : 'none';
    resultsEl.style.display = on ? 'none' : '';
    counter.classList.toggle('has-query', !on);
  }

  // Tapping any poster (search result OR explore) behaves as it always has:
  // open the existing detail if the title is already in the library, otherwise
  // open the add-to-library sheet.
  function openTitle(r) {
    if (r.already_added && r.item_id) openDetail(`/detail/${r.item_id}`);
    else openAddModal(r);
  }

  // --- Shared pieces -------------------------------------------------------
  // A poster with the marks that belong ON the artwork: the collection tick,
  // and the TMDB score where we have one.
  function posterOf(item) {
    const card = poster(item.thumb_url, item.title);
    if (item.already_added) card.append(el('div', { class: 'ai-mark', html: icons.check }));
    else if (item.rating) {
      card.append(
        el('div', { class: 'rating-badge' }, [
          el('span', { text: '★' }),
          el('span', { text: String(item.rating) }),
        ])
      );
    }
    return card;
  }

  function cell(item) {
    const c = el('div', { class: 'ai-cell' }, [
      posterOf(item),
      el('div', { class: 'ai-name', text: item.title }),
      el('div', { class: 'ai-sub', text: item.year || '' }),
    ]);
    c.addEventListener('click', () => openTitle(item));
    return c;
  }

  // The desktop arrows for a rail. A pointer has no swipe, so without these a
  // row cannot be moved at all without a trackpad gesture.
  function arrowsFor(rail) {
    const prev = el('button', {
      class: 'ai-arrow',
      type: 'button',
      'aria-label': t('search.scrollLeft'),
      html: icons.back,
    });
    const next = el('button', {
      class: 'ai-arrow',
      type: 'button',
      'aria-label': t('search.scrollRight'),
      html: icons.forward,
    });
    const maxScroll = () => Math.max(0, rail.scrollWidth - rail.clientWidth);
    function sync() {
      prev.disabled = rail.scrollLeft <= 1;
      next.disabled = rail.scrollLeft >= maxScroll() - 1;
    }
    // Same rule as the horizon railway: move about 80% of a viewport and land
    // on a card edge, so a row never stops mid-poster.
    function go(dir) {
      const max = maxScroll();
      const here = rail.scrollLeft;
      const edges = [...rail.children].map((c) => Math.min(max, Math.max(0, c.offsetLeft - 16)));
      const desired = Math.min(max, Math.max(0, here + dir * rail.clientWidth * 0.8));
      const ahead = dir > 0 ? edges.filter((e) => e > here + 1) : edges.filter((e) => e < here - 1);
      let target;
      if (desired <= 0 || desired >= max || !ahead.length) target = dir > 0 ? max : 0;
      else
        target = ahead.reduce((best, e) =>
          Math.abs(e - desired) < Math.abs(best - desired) ? e : best
        );
      rail.scrollTo({ left: target, behavior: 'smooth' });
    }
    prev.addEventListener('click', () => go(-1));
    next.addEventListener('click', () => go(1));
    rail.addEventListener('scroll', sync, { passive: true });
    requestAnimationFrame(sync);
    // The rail is retained across renders of the same mount, so its width can
    // change under it (rotation, a resized window); re-sync rather than leaving
    // an arrow enabled that no longer has anywhere to go.
    new ResizeObserver(sync).observe(rail);
    return el('div', { class: 'ai-arrows' }, [prev, next]);
  }

  function rowHead(eyebrow, title, rail) {
    return el('div', { class: 'ai-head' }, [
      el('div', { class: 'ai-heads' }, [
        el('span', { class: 'ai-eyebrow', text: eyebrow }),
        el('h2', { class: 'ai-title', text: title }),
      ]),
      rail ? arrowsFor(rail) : null,
    ]);
  }

  // Row head + rail + the board the posters stand on.
  function aisle({ eyebrow, title, items, build = cell }) {
    const rail = el('div', { class: 'ai-rail' });
    items.forEach((it, i) => rail.append(build(it, i)));
    return el('section', { class: 'ai' }, [rowHead(eyebrow, title, rail), rail]);
  }

  // --- The picks: the page's one editorial spot ----------------------------
  function picksRow(items) {
    const rail = el('div', { class: 'pk-rail' });
    const dots = el('div', { class: 'pk-dots' });
    items.forEach((item, i) => {
      const meta = el('div', { class: 'pk-meta' }, [
        item.year ? el('span', { text: item.year }) : null,
        item.rating
          ? el('span', { class: 'pk-score', text: `★ ${item.rating}` })
          : null,
      ]);
      const open = el(
        'button',
        { class: 'btn btn-primary', type: 'button', onClick: () => openTitle(item) },
        [
          lucideIcon(item.already_added ? 'library-big' : 'plus', 'btn-lucide'),
          el('span', { text: item.already_added ? t('search.inLibrary') : t('preview.addToLibrary') }),
        ]
      );
      const card = el('article', { class: 'pk-card' }, [
        posterOf(item),
        el('div', { class: 'pk-head' }, [
          el('div', { class: 'pk-kicker', text: t('search.row.picks.kicker') }),
          el('h3', { class: 'pk-title', text: item.title }),
          meta,
        ]),
        el('p', { class: 'pk-over', text: item.overview || '' }),
        el('div', { class: 'pk-actions' }, [open]),
      ]);
      rail.append(card);
      dots.append(el('span', { class: 'pk-dot' + (i === 0 ? ' on' : '') }));
    });
    // The dots follow the rail rather than driving it: swiping is the gesture.
    rail.addEventListener(
      'scroll',
      () => {
        const first = rail.firstElementChild;
        if (!first) return;
        const i = Math.round(rail.scrollLeft / (first.offsetWidth + 12));
        [...dots.children].forEach((d, n) => d.classList.toggle('on', n === i));
      },
      { passive: true }
    );
    return el('section', { class: 'ai' }, [
      rowHead(t('search.row.picks.eyebrow'), t('search.row.picks.title'), rail),
      rail,
      dots,
    ]);
  }

  // --- Trending: the one row that is genuinely ordered ---------------------
  function rankCell(item, i) {
    const n = i + 1;
    const c = el('div', { class: 'rk-cell', 'data-wide': n >= 10 ? '1' : '0' }, [
      el('div', { class: 'rk-art' }, [
        el('span', { class: 'rk-num', 'aria-hidden': 'true', text: String(n) }),
        posterOf(item),
      ]),
      el('div', { class: 'ai-name', text: item.title }),
      el('div', { class: 'ai-sub', text: item.year || '' }),
    ]);
    c.addEventListener('click', () => openTitle(item));
    return c;
  }

  // --- The mood strip: six rows become one block ---------------------------
  function moodStrip(byKey) {
    const grid = el('div', { class: 'mx-grid' });
    const rail = el('div', { class: 'ai-rail' });
    const tiles = [];
    const available = MOODS.filter((m) => (byKey.get(m.key) || {}).items);
    if (!available.length) return null;
    if (!available.some((m) => m.key === state.mood)) state.mood = available[0].key;

    function fill(key) {
      const sec = byKey.get(key);
      rail.innerHTML = '';
      for (const it of (sec && sec.items) || []) rail.append(cell(it));
      rail.scrollLeft = 0;
    }

    available.forEach((m) => {
      const sec = byKey.get(m.key);
      const tile = el(
        'button',
        {
          class: 'mx-tile' + (m.key === state.mood ? ' on' : ''),
          type: 'button',
          'data-mood': m.key,
          'aria-pressed': String(m.key === state.mood),
        },
        [el('span', { class: 'mx-name', text: sectionTitle(sec) })]
      );
      tile.style.setProperty('--ink', `var(--color-${m.ink})`);
      tile.style.setProperty('--mid', `var(--color-${m.mid})`);
      tile.style.setProperty('--pale', `var(--color-${m.pale})`);
      tile.addEventListener('click', () => {
        state.mood = m.key;
        tiles.forEach((x) => {
          const on = x.dataset.mood === m.key;
          x.classList.toggle('on', on);
          x.setAttribute('aria-pressed', String(on));
        });
        fill(m.key);
      });
      tiles.push(tile);
      grid.append(tile);
    });
    fill(state.mood);

    return el('section', { class: 'mx' }, [
      rowHead(t('search.mood.eyebrow'), t('search.mood.title'), rail),
      grid,
      rail,
    ]);
  }

  // --- Recent queries ------------------------------------------------------
  // The chips are rebuilt rather than mutated: the list is at most five items,
  // and a search run since the last Explore render has to show up in them.
  let recentEl = null;
  function paintRecent() {
    const next = recentRow();
    if (recentEl && recentEl.isConnected) {
      if (next) recentEl.replaceWith(next);
      else recentEl.remove();
    } else if (next) {
      if (exploreEl.firstChild) exploreEl.prepend(next);
      else exploreEl.append(next);
    }
    recentEl = next;
  }

  function recentRow() {
    const list = recentQueries();
    if (!list.length) return null;
    const row = el('div', { class: 'fc-recent' }, [
      el('span', { class: 'fc-recent-label', text: t('search.recent') }),
    ]);
    list.forEach((q) => {
      const x = el('span', {
        class: 'fc-q-x',
        role: 'button',
        'aria-label': t('search.forget'),
        html: icons.close,
      });
      const chip = el('button', { class: 'fc-q', type: 'button' }, [el('span', { text: q }), x]);
      chip.addEventListener('click', () => {
        input.value = q;
        state.query = q;
        run(true);
      });
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        pset(
          PK.recentSearches,
          recentQueries().filter((r) => r !== q)
        );
        paintRecent();
      });
      row.append(chip);
    });
    return row;
  }

  function rememberQuery(q) {
    const key = q.trim().toLowerCase();
    if (key.length < RECENT_MIN_LEN) return;
    const list = recentQueries().filter((r) => r !== key);
    list.unshift(key);
    pset(PK.recentSearches, list.slice(0, RECENT_MAX));
  }

  // --- Explore -------------------------------------------------------------
  // Guards re-entry within THIS mount; the payload itself is cached at module
  // scope above, so it survives navigating away and back.
  let exploreLoaded = false;

  function exploreSkeleton() {
    exploreEl.innerHTML = '';
    for (let s = 0; s < 3; s++) {
      const cards = [];
      for (let i = 0; i < 6; i++) cards.push(el('div', { class: 'ai-cell skeleton poster-card' }));
      exploreEl.append(
        el('section', { class: 'ai' }, [
          el('div', { class: 'ai-head' }, [
            el('div', { class: 'ai-heads' }, [skelLineTitle()]),
          ]),
          el('div', { class: 'ai-rail' }, cards),
        ])
      );
    }
  }

  function renderExplore(data) {
    const sections = (data && data.sections) || [];
    exploreEl.innerHTML = '';
    recentEl = null;
    paintRecent();
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
      exploreEl.append(stateBlock({ icon: 'popcorn', title: t('search.noSuggestions') }));
      return;
    }

    const byKey = new Map(sections.map((s) => [s.key, s]));

    // The picks come off the cinema row: a handful of titles, with the synopsis
    // the rest of the page has no room for. Skipped entirely when that row is
    // empty (no local releases, or the region returned nothing).
    const cinema = byKey.get('theaters');
    const picks = ((cinema && cinema.items) || []).filter((i) => i.overview).slice(0, 4);
    if (picks.length >= 2) exploreEl.append(picksRow(picks));

    const trending = byKey.get('trending');
    if (trending && trending.items.length) {
      exploreEl.append(
        aisle({
          eyebrow: t('search.row.trending.eyebrow'),
          title: t('search.row.trending.title'),
          items: trending.items,
          build: rankCell,
        })
      );
    }

    const moods = moodStrip(byKey);
    if (moods) exploreEl.append(moods);

    for (const key of SHELVES) {
      const sec = byKey.get(key);
      if (!sec || !sec.items.length) continue;
      const eyebrowKey = `search.row.${key}.eyebrow`;
      const titleKey = `search.row.${key}.title`;
      const eyebrow = t(eyebrowKey);
      const title = t(titleKey);
      exploreEl.append(
        aisle({
          eyebrow: eyebrow === eyebrowKey ? '' : eyebrow,
          title: title === titleKey ? sectionTitle(sec) : title,
          items: sec.items,
        })
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
        markDegraded(); // server unreachable; keep the skeleton rows, recovery re-renders
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

  // --- Results -------------------------------------------------------------
  // The match, marked in the title. The only place the query itself appears in
  // the answers, and the fastest way to see why a row came back.
  function markTitle(text, q) {
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (!q || i < 0) return el('div', { class: 'ht-title', text });
    return el('div', { class: 'ht-title' }, [
      el('span', { text: text.slice(0, i) }),
      el('mark', { text: text.slice(i, i + q.length) }),
      el('span', { text: text.slice(i + q.length) }),
    ]);
  }

  // The one action on a row: put it on the shelf without opening anything.
  // Plan to Watch, because that is what "I'll get to this" means, and the
  // status is changed from the detail page like any other.
  function addButton(r) {
    const btn = el('button', {
      class: 'ht-add' + (r.already_added ? ' on' : ''),
      type: 'button',
      'aria-label': r.already_added ? t('search.inLibrary') : t('search.quickAdd'),
      html: r.already_added ? icons.check : icons.plus,
    });
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (r.already_added) {
        // Already on the shelf: this is a state, not a second action. Removing
        // a title on one tap is not something a search row should do.
        toast(t('search.inLibrary'));
        return;
      }
      if (btn.dataset.busy) return;
      btn.dataset.busy = '1';
      try {
        const res = await api.addMedia(r.tmdb_id, r.type, 'plan_to_watch');
        r.already_added = true;
        r.item_id = res && res.id;
        btn.classList.add('on');
        btn.innerHTML = icons.check;
        btn.setAttribute('aria-label', t('search.inLibrary'));
        toast(t('search.quickAdded'), 'ok');
      } catch (err) {
        if (err.status === 409 && err.data && err.data.item_id) {
          r.already_added = true;
          r.item_id = err.data.item_id;
          btn.classList.add('on');
          btn.innerHTML = icons.check;
          toast(t('search.alreadyInLibrary'));
        } else {
          toast(err.message || t('search.somethingWrong'), 'bad');
        }
      } finally {
        delete btn.dataset.busy;
      }
    });
    return btn;
  }

  function hitRow(r, q) {
    const meta = el('div', { class: 'ht-meta' }, [
      el('span', { class: 'ht-kind' }, [
        lucideIcon(r.type === 'movie' ? 'clapperboard' : 'tv', 'lc'),
        el('span', { text: r.type === 'movie' ? t('media.movie') : t('media.series') }),
      ]),
      r.year ? el('span', { text: r.year }) : null,
    ]);
    const thumb = poster(r.thumb_url, r.title);
    thumb.classList.add('ht-thumb');
    const row = el('div', { class: 'ht', role: 'button', tabindex: '0' }, [
      thumb,
      el('div', { class: 'ht-main' }, [
        markTitle(r.title, q),
        r.original_title && r.original_title !== r.title
          ? el('div', { class: 'ht-orig', text: r.original_title })
          : null,
        meta,
      ]),
      addButton(r),
    ]);
    row.addEventListener('click', () => openTitle(r));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openTitle(r);
      }
    });
    return row;
  }

  function hitSkeleton(n) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      frag.append(
        el('div', { class: 'ht-skel' }, [
          el('div', { class: 'ht-skel-thumb skeleton' }),
          el('div', {}, [
            el('div', { class: 'skeleton skel-line', style: { width: '58%' } }),
            el('div', {
              class: 'skeleton skel-line sm',
              style: { width: '34%', marginTop: '7px' },
            }),
          ]),
          el('div', { class: 'ht-skel-add skeleton' }),
        ])
      );
    }
    return frag;
  }

  function showSkeleton() {
    countEl.textContent = '';
    resultsEl.innerHTML = '';
    resultsEl.append(resultsBar, hitSkeleton(7));
  }

  // Draw whatever the last search answered, under the current scope. Switching
  // scope re-draws from this list rather than asking again: the request always
  // covers every type, which is also where the per-scope counts come from.
  function paintResults() {
    const list = state.results;
    if (!list) return;
    const q = state.query.trim();
    const movies = list.filter((r) => r.type === 'movie');
    const shows = list.filter((r) => r.type === 'show');
    // The filter carries its own counts, so it says where the answers are
    // instead of making you try all three.
    scope.setLabel(0, `${t('search.scopeAll')} ${list.length}`);
    scope.setLabel(1, `${t('search.scopeMovies')} ${movies.length}`);
    scope.setLabel(2, `${t('search.scopeSeries')} ${shows.length}`);

    const shown = state.scope === 'movie' ? movies : state.scope === 'show' ? shows : list;
    countEl.textContent = `${shown.length} ${t('search.titlesCount')}`;

    const frag = document.createDocumentFragment();
    frag.append(resultsBar);
    if (!shown.length) {
      frag.append(
        stateBlock({
          title: state.mine ? t('search.mineNoResults') : t('search.noResults'),
          detail: state.mine ? t('search.mineNoResultsDetail') : t('search.noResultsDetail'),
        })
      );
    } else if (state.view === 'rows') {
      const rows = el('div', { class: 'ht-list' });
      for (const r of shown) rows.append(hitRow(r, q));
      frag.append(rows);
    } else {
      const grid = el('div', { class: 'ht-grid' });
      for (const r of shown) grid.append(cell(r));
      frag.append(grid);
    }
    crossfadeSwap(() => {
      resultsEl.innerHTML = '';
      resultsEl.append(frag);
    });
  }

  let reqId = 0;
  async function run(remember) {
    const q = input.value.trim();
    state.query = q;
    if (!q) {
      state.results = null;
      scope.setLabel(0, t('search.scopeAll'));
      scope.setLabel(1, t('search.scopeMovies'));
      scope.setLabel(2, t('search.scopeSeries'));
      showExplore(true);
      loadExplore();
      // Explore may already be rendered from an earlier visit, in which case
      // loadExplore() returns without touching the DOM; the chips still have to
      // pick up whatever was just searched.
      paintRecent();
      return;
    }
    showExplore(false);
    const myReq = ++reqId;
    showSkeleton();
    try {
      // Always ask for every type: the scope filter then narrows locally, and
      // the counts on it are real rather than a guess.
      const data = await api.search(q, 'all', state.mine ? 'library' : undefined);
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
      state.results = data.results || [];
      paintResults();
      if (remember !== false) rememberQuery(q);
    } catch (err) {
      if (isAbortError(err)) return; // navigated away or superseded — ignore
      if (myReq !== reqId) return;
      if (!isServerReachable()) {
        // Server unreachable; keep the ghost rows, recovery re-renders.
        markDegraded();
        showSkeleton();
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

  // --- Wiring --------------------------------------------------------------
  let timer = null;
  // A pending debounce would fire after navigate-away and run a whole search
  // against this view's detached DOM; drop it with the view.
  onCleanup(() => clearTimeout(timer));

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    counter.classList.toggle('has-query', !!q);
    if (q) {
      showExplore(false);
      showSkeleton();
    }
    timer = setTimeout(run, 400);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(timer);
      run();
    } else if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      input.value = '';
      run();
    }
  });
  clearBtn.addEventListener('click', () => {
    clearTimeout(timer);
    input.value = '';
    input.focus();
    run();
  });
  mineBtn.addEventListener('click', () => {
    state.mine = !state.mine;
    mineBtn.setAttribute('aria-pressed', String(state.mine));
    toast(state.mine ? t('search.mineOn') : t('search.mineOff'));
    if (state.query) {
      clearTimeout(timer);
      run(false);
    }
  });
  viewBtn.addEventListener('click', () => {
    state.view = state.view === 'rows' ? 'posters' : 'rows';
    viewBtn.innerHTML = state.view === 'rows' ? icons.grid : icons.list;
    viewBtn.setAttribute(
      'aria-label',
      state.view === 'rows' ? t('search.viewPosters') : t('search.viewRows')
    );
    paintResults();
  });

  // Empty on open → Explore is the landing content.
  showExplore(true);
  loadExplore();

  // Shared-in search (via the Share Target handler): pre-fill the input and run
  // the search immediately, then clear the one-shot so a later visit opens empty.
  if (pendingQuery) {
    input.value = pendingQuery;
    pendingQuery = null;
    counter.classList.add('has-query');
    run();
  }
}

// A shimmer stand-in for a row's title line.
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
