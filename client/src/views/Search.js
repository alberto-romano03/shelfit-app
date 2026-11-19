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

import { collapsibleText } from '../collapsibleText.js';
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
  skelText,
  segmentedControl,
  typewriterPlaceholder,
  pressable,
  scrollMotion,
} from '../ui.js';
import { isServerReachable, markDegraded } from '../network.js';
import { buildStatusBento } from '../statusSelect.js';
import { pget, pset, PK } from '../persist.js';
import { getExplore, saveExplore, markExploreDirty, EXPLORE_MAX_MS } from '../offlineCache.js';
import { t } from '../i18n.js';

// A query to pre-fill and run automatically the next time the Search view mounts.
// Set by the Share Target handler (main.js) when a shared item carried no TMDB
// link, so the shared title/text becomes an immediate search. One-shot: consumed
// (and cleared) on the next Search mount so it never re-triggers.
let pendingQuery = null;
export function setPendingSearch(q) {
  pendingQuery = typeof q === 'string' && q.trim() ? q.trim() : null;
}

// Explore payload, valid for six hours (the same window as the server's TMDB
// memo, which says how long it has left). Within it, Search paints the rows
// straight from this copy, across visits and reloads (offlineCache keeps it per
// member), without fetching. Once it runs out the copy is removed and the next
// visit loads fresh rows.
//
// A library change keeps the rows but flags their "in your library" marks
// (`already_added`, overlaid per request server-side): the next visit paints the
// copy and checks it behind the render, which costs the server no TMDB call.
let exploreCache = null; // { expiresAt, data, dirty } | null
window.addEventListener('shelfit:library-changed', () => {
  if (exploreCache) exploreCache.dirty = true;
  markExploreDirty();
});

function currentExplore() {
  if (exploreCache && exploreCache.expiresAt > Date.now()) return exploreCache;
  exploreCache = getExplore(); // null, and the stored copy removed, once expired
  return exploreCache;
}

// The rows that stay a plain shelf, in the order they appear. The eyebrow says
// what the row IS; the title is the row's name.
const SHELVES = ['popular_tv', 'top_rated', 'popular_movies', 'on_the_air'];

// The mood strip. Each tile takes one of the design system's named palette
// triads (ink / mid / pale) and its own display face; the keys are the Explore
// section keys, so a tile maps straight onto a row the server already sends.
// One palette per shelf: the vibrant tone fills the tile, and `fg` is the
// partner that reads on it. Amber is the light one of the six, so it takes its
// palette's dark ink rather than the pale tone the others use.
const MOODS = [
  { key: 'feel_good', mid: 'clementine', fg: 'oat-milk' },
  { key: 'edge', mid: 'harbor', fg: 'fog' },
  { key: 'epic', mid: 'amber', fg: 'oat' },
  { key: 'binge', mid: 'rose', fg: 'shell' },
  { key: 'mindbending', mid: 'iris', fg: 'powder' },
  { key: 'easy', mid: 'teal', fg: 'chalk' },
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
    else openAddModal(r, { onChange: (itemId) => setInLibrary(r, itemId) });
  }

  // Every poster, button and row painted from a title can show it in (or out of)
  // the library. An add or a removal repaints them all in place, wherever that
  // title is on the page, so a card never keeps offering "+" for a title already
  // added (its tap would reopen the add sheet instead of the title).
  const keyOf = (r) => `${r.type}:${r.tmdb_id}`;
  // What this page has learnt about titles since it loaded (key -> library id, or
  // null once removed). A card drawn later from older data (a mood row, a
  // re-rendered list) is painted with it, not with what that data said.
  const known = new Map();
  function paintsLibrary(node, r, paint) {
    node.dataset.titleKey = keyOf(r);
    node._library = (itemId) => {
      r.already_added = itemId != null;
      r.item_id = itemId ?? null;
      paint(itemId != null);
    };
    if (known.has(keyOf(r))) node._library(known.get(keyOf(r)));
    return node;
  }
  function setInLibrary(r, itemId) {
    known.set(keyOf(r), itemId ?? null);
    r.already_added = itemId != null;
    r.item_id = itemId ?? null;
    for (const node of container.querySelectorAll(`[data-title-key="${keyOf(r)}"]`)) {
      if (node._library) node._library(itemId);
    }
  }

  // --- Shared pieces -------------------------------------------------------
  // A poster with the marks that belong ON the artwork: the collection tick,
  // and the TMDB score where we have one.
  // `badge` off for a card that shows the score in its own text, so the same
  // number is never printed twice on one card.
  function posterOf(item, { badge = true } = {}) {
    const card = poster(item.thumb_url, ''); // the name is printed right under it
    const mark = el('div', { class: 'ai-mark', html: icons.check });
    const score =
      badge && item.rating
        ? el('div', { class: 'rating-badge' }, [
            el('span', { text: '★' }),
            el('span', { text: String(item.rating) }),
          ])
        : null;
    const paint = (on) => {
      mark.remove();
      if (score) score.remove();
      if (on) card.append(mark);
      else if (score) card.append(score);
    };
    paint(!!item.already_added);
    return paintsLibrary(card, item, paint);
  }

  function cell(item) {
    const c = el('div', { class: 'ai-cell' }, [
      posterOf(item),
      el('div', { class: 'ai-name', text: item.title }),
      el('div', { class: 'ai-sub', text: item.year || '' }),
    ]);
    c.addEventListener('click', () => openTitle(item));
    return pressable(c);
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
      rail.scrollTo({ left: target, behavior: scrollMotion() });
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
      // The score rides on the artwork now, so this line is the year and the
      // genre, which is what tells two similar titles apart at a glance.
      const meta = el('div', { class: 'pk-meta' }, [
        item.year ? el('span', { text: item.year }) : null,
      ]);
      for (const g of (item.genres || []).slice(0, 2)) {
        meta.append(el('span', { class: 'gc', text: g }));
      }
      const open = el('button', { class: 'btn btn-primary', type: 'button', onClick: () => openTitle(item) });
      const paintOpen = (on) =>
        open.replaceChildren(
          lucideIcon(on ? 'library-big' : 'plus', 'btn-lucide'),
          el('span', { text: on ? t('search.inLibrary') : t('preview.addToLibrary') })
        );
      paintOpen(!!item.already_added);
      paintsLibrary(open, item, paintOpen);
      const card = el('article', { class: 'pk-card' }, [
        posterOf(item),
        el('div', { class: 'pk-body' }, [
          el('h3', { class: 'pk-title', text: item.title }),
          meta,
          el('p', { class: 'pk-over', text: item.overview || '' }),
        ]),
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
  // The numeral is drawn as SVG, not as text with -webkit-text-stroke: on iOS
  // the stroked glyph picks up its own internal contours, so a 2 comes out
  // with a notch through its foot and a 6 with a slash across its bowl. A path
  // stroke has none of that, and the two-digit pair is fitted to an exact
  // width instead of relying on negative tracking that made the digits touch.
  const NUM_FONT =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  // Drawn as an SVG path stroke, not text-stroke: on iOS -webkit-text-stroke
  // outlines every internal contour of the glyph, so a 2 came out notched
  // through its foot and a 6 slashed across its bowl. No textLength: forcing a
  // width squashes the glyph shapes ("10" stretched flat). The box is sized to
  // the digits' own advance and the whole thing is allowed to overflow, so a
  // heavy stroke is never clipped at the edges.
  function rankNumeral(n) {
    const text = String(n);
    const w = 44 * text.length;
    // SOLID fill, not a stroke. Stroking the glyph outlines its inner counters
    // too, and on iOS where those counters nearly touch (the bar of a 2, the
    // bowl of a 6) the strokes merge into a line across the digit. A fill has
    // no such seam, and a solid ghost number is the real top-10 treatment. It
    // reads as a ghost because the tone is a low-alpha neutral, set on .rk-num.
    return el('span', {
      class: 'rk-num',
      'aria-hidden': 'true',
      html:
        `<svg viewBox="0 0 ${w} 80" width="${w}" height="80" ` +
        `style="overflow:visible" focusable="false" aria-hidden="true">` +
        `<text x="${w / 2}" y="70" text-anchor="middle" font-size="74" ` +
        `font-weight="800" font-family="${NUM_FONT}" fill="currentColor">` +
        `${text}</text></svg>`,
    });
  }

  function rankCell(item, i) {
    const n = i + 1;
    const c = el('div', { class: 'rk-cell', 'data-wide': n >= 10 ? '1' : '0' }, [
      el('div', { class: 'rk-art' }, [rankNumeral(n), posterOf(item)]),
      el('div', { class: 'ai-name', text: item.title }),
      el('div', { class: 'ai-sub', text: item.year || '' }),
    ]);
    c.addEventListener('click', () => openTitle(item));
    return pressable(c);
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
      rail.replaceChildren();
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
        [
          el('span', { class: 'mx-name', text: sectionTitle(sec) }),
          el('span', {
            class: 'mx-check',
            'aria-hidden': 'true',
            html: icons.check,
          }),
        ]
      );
      tile.style.setProperty('--mid', `var(--color-${m.mid})`);
      tile.style.setProperty('--fg', `var(--color-${m.fg})`);
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
    const chips = el('div', { class: 'fc-recent-chips' });
    const row = el('div', { class: 'fc-recent' }, [
      el('span', { class: 'fc-recent-label', text: t('search.recent') }),
      chips,
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
      chips.append(chip);
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

  // The loading state stands in the same boxes the real thing will: an eyebrow
  // over a title, a picks card with its reserved synopsis, the ranked row's
  // inset cells, the mood grid. Rows below these append under the fold when the
  // data lands, so nothing already on screen moves.
  function skelHead() {
    return el('div', { class: 'ai-head' }, [
      el('div', { class: 'ai-heads' }, [
        el('span', { class: 'ai-eyebrow' }, [skelText('34%')]),
        el('h2', { class: 'ai-title' }, [skelText('56%')]),
      ]),
      el('div', { class: 'ai-arrows' }, [
        el('button', { class: 'ai-arrow', disabled: true, 'aria-hidden': 'true' }),
        el('button', { class: 'ai-arrow', disabled: true, 'aria-hidden': 'true' }),
      ]),
    ]);
  }

  function skelCell(rank) {
    return el('div', { class: rank ? 'rk-cell' : 'ai-cell' }, [
      el('div', { class: 'poster-card skeleton' }),
      el('div', { class: 'ai-name' }, [skelText('86%')]),
      el('div', { class: 'ai-sub' }, [skelText('42%')]),
    ]);
  }

  function skelRow(rank) {
    const rail = el('div', { class: 'ai-rail' });
    for (let i = 0; i < 6; i++) rail.append(skelCell(rank));
    return el('section', { class: 'ai' }, [skelHead(), rail]);
  }

  function skelPicks() {
    return el('section', { class: 'ai' }, [
      skelHead(),
      el('div', { class: 'pk-rail' }, [
        el('article', { class: 'pk-card' }, [
          el('div', { class: 'poster-card skeleton' }),
          // display:block overrides the line-clamped boxes so the bars stack.
          el('div', { class: 'pk-body' }, [
            el('div', { class: 'pk-title' }, [skelText('82%')]),
            el('div', { class: 'pk-meta' }, [skelText('34%')]),
            el('div', { class: 'pk-over', style: { display: 'block' } }, [skelText('100%'), skelText('94%'), skelText('86%')]),
          ]),
          el('div', { class: 'pk-actions' }, [
            el('div', { class: 'skeleton skel-pill', style: { height: '44px', flex: '1 1 auto' } }),
          ]),
        ]),
      ]),
      el('div', { class: 'pk-dots' }, [
        el('span', { class: 'pk-dot' }),
        el('span', { class: 'pk-dot' }),
        el('span', { class: 'pk-dot' }),
        el('span', { class: 'pk-dot' }),
      ]),
    ]);
  }

  function skelMood() {
    const grid = el('div', { class: 'mx-grid' });
    for (let i = 0; i < 6; i++) grid.append(el('div', { class: 'mx-skel skeleton' }));
    const rail = el('div', { class: 'ai-rail' });
    for (let i = 0; i < 6; i++) rail.append(skelCell());
    return el('section', { class: 'mx' }, [skelHead(), grid, rail]);
  }

  function exploreSkeleton() {
    exploreEl.replaceChildren();
    // The chips come from storage, so they paint now rather than shimmering.
    recentEl = null;
    paintRecent();
    exploreEl.append(skelPicks(), skelRow(true), skelMood());
  }

  function renderExplore(data) {
    const sections = (data && data.sections) || [];
    exploreEl.replaceChildren();
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
    const cached = currentExplore();
    if (cached) {
      exploreLoaded = true;
      renderExplore(cached.data);
      if (!cached.dirty) return; // valid and unchanged: no request at all
      // The library changed: check the marks behind the render already on screen.
    } else {
      exploreSkeleton();
    }
    try {
      const res = await api.explore();
      if (ac.signal.aborted) return;
      const { expires_in: expiresIn, ...data } = res || {};
      const sameRows = cached && JSON.stringify(data) === JSON.stringify(cached.data);
      const left = Math.min(Number(expiresIn) || 0, EXPLORE_MAX_MS);
      if (left > 0) {
        saveExplore(data, left);
        exploreCache = { expiresAt: Date.now() + left, data, dirty: false };
      }
      // left 0: rows served from an expired server copy after a failed rebuild.
      // They are shown, not kept, so the next visit asks again.
      exploreLoaded = true;
      if (!sameRows) crossfadeSwap(() => renderExplore(data));
    } catch (err) {
      if (isAbortError(err)) return;
      // A revalidation that fails leaves the copy already on screen alone — the
      // view isn't degraded, so it must not be flagged for a recovery re-mount.
      if (cached) return;
      if (!isServerReachable()) {
        markDegraded(); // server unreachable; keep the skeleton rows, recovery re-renders
        return;
      }
      exploreEl.replaceChildren();
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
  // The one action on a row: put it on the shelf without opening anything.
  // Plan to Watch, because that is what "I'll get to this" means, and the
  // status is changed from the detail page like any other.
  function addButton(r) {
    const btn = el('button', { class: 'ht-add', type: 'button' });
    const paint = (on) => {
      btn.classList.toggle('on', on);
      btn.innerHTML = on ? icons.check : icons.plus;
      // With the title: every row's button would otherwise have the same name.
      btn.setAttribute('aria-label', `${on ? t('search.inLibrary') : t('search.quickAdd')}: ${r.title || ''}`);
    };
    paint(!!r.already_added);
    paintsLibrary(btn, r, paint);
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
        setInLibrary(r, res && res.id);
        toast(t('search.quickAdded'), 'ok');
      } catch (err) {
        if (err.status === 409 && err.data && err.data.item_id) {
          setInLibrary(r, err.data.item_id);
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

  function hitRow(r) {
    const meta = el('div', { class: 'ht-meta' }, [
      el('span', { class: 'ht-kind' }, [
        lucideIcon(r.type === 'movie' ? 'clapperboard' : 'tv', 'lc'),
        el('span', { text: r.type === 'movie' ? t('media.movie') : t('media.series') }),
      ]),
      r.year ? el('span', { text: r.year }) : null,
    ]);
    const thumb = poster(r.thumb_url, ''); // the row prints the title beside it
    thumb.classList.add('ht-thumb');
    const row = el('div', { class: 'ht', role: 'button', tabindex: '0' }, [
      thumb,
      el('div', { class: 'ht-main' }, [
        el('div', { class: 'ht-title', text: r.title }),
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
    resultsEl.replaceChildren();
    resultsEl.append(resultsBar, hitSkeleton(7));
  }

  // Draw whatever the last search answered, under the current scope. Switching
  // scope re-draws from this list rather than asking again: the request always
  // covers every type, which is also where the per-scope counts come from.
  function paintResults() {
    const list = state.results;
    if (!list) return;
    const movies = list.filter((r) => r.type === 'movie');
    const shows = list.filter((r) => r.type === 'show');
    // The filter carries its own counts, so it says where the answers are
    // instead of making you try all three.
    scope.setLabel(0, `${t('search.scopeAll')} ${list.length}`);
    scope.setLabel(1, `${t('search.scopeMovies')} ${movies.length}`);
    scope.setLabel(2, `${t('search.scopeSeries')} ${shows.length}`);

    const shown = state.scope === 'movie' ? movies : state.scope === 'show' ? shows : list;
    countEl.textContent = t('lists.titles', { n: shown.length }); // "1 title", not "1 titles"

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
      for (const r of shown) rows.append(hitRow(r));
      frag.append(rows);
    } else {
      const grid = el('div', { class: 'ht-grid' });
      for (const r of shown) grid.append(cell(r));
      frag.append(grid);
    }
    crossfadeSwap(() => {
      resultsEl.replaceChildren();
      resultsEl.append(frag);
    });
  }

  let reqId = 0;
  async function run(remember) {
    const q = input.value.trim();
    state.query = q;
    if (!q) {
      reqId++; // an answer still on its way is for a search no longer asked
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
        showBudgetReached();
        return;
      }
      state.results = data.results || [];
      paintResults();
      if (remember !== false) rememberQuery(q);
    } catch (err) {
      if (isAbortError(err)) return; // navigated away or superseded — ignore
      if (myReq !== reqId) return;
      // The month's TMDB budget is spent: the server answers 429 with capReached,
      // which arrives here as an error. Not a failure to retry, a pause to explain.
      if (err.data && err.data.capReached) {
        showBudgetReached();
        return;
      }
      if (!isServerReachable()) {
        // Server unreachable; keep the ghost rows, recovery re-renders. The
        // re-render mounts Search afresh, so hand it the query to run again.
        pendingQuery = q;
        markDegraded();
        showSkeleton();
        return;
      }
      resultsEl.replaceChildren();
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

  function showBudgetReached() {
    resultsEl.replaceChildren();
    resultsEl.append(
      stateBlock({
        icon: 'wallet',
        title: t('search.searchPaused'),
        detail: t('search.budgetReached'),
      })
    );
  }

  // --- Wiring --------------------------------------------------------------
  let timer = null;
  // A pending debounce would fire after navigate-away and run a whole search
  // against this view's detached DOM; drop it with the view.
  onCleanup(() => clearTimeout(timer));

  input.addEventListener('input', () => {
    clearTimeout(timer);
    // The text changed: the answer to the old text must not land (nor be saved
    // to Recent), and a scope tap meanwhile has no old results to repaint.
    reqId++;
    state.results = null;
    const q = input.value.trim();
    counter.classList.toggle('has-query', !!q);
    if (q) {
      showExplore(false);
      showSkeleton();
    }
    timer = setTimeout(run, 400);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
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

// Shared "Add to library" dialog. Title + collapsible summary, a separator, then
// the same status bento used on the detail page — tapping a status adds the
// title with it. onAdded runs on the first add (collection views handle it in
// place); onChange runs on every change the sheet makes (added, a new status,
// removed again), with the library id or null (Search repaints the cards showing
// that title, a collection repaints itself).
export function openAddModal(r, { onAdded, onChange } = {}) {
  openModal((modal, close) => {
    // --- Title + type ---
    const heading = el('h3', { text: `${r.title}${r.year ? ' (' + r.year + ')' : ''}` });
    const typeLine = el('div', { class: 'muted', text: r.type === 'movie' ? t('media.movie') : t('media.tvSeries') });

    // --- Summary with Show more / Show less (kept compact) ---
    let summary = null;
    if (r.overview) summary = el('div', { class: 'add-summary' }, collapsibleText(r.overview));

    // --- Status bento — tap to add with that status (highlighted); tap the same
    // one again to undo (removes from library, un-highlights); tap a different
    // one to change the status. The modal never auto-closes — the user dismisses
    // it via Cancel / View full details themselves. ---
    let itemId = null; // library id once added; null when not in the library
    let currentStatus = null;
    // Found already in the library (the card was out of date): this sheet did not
    // add it, so a second tap on its status must not delete it.
    let adopted = false;
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
            // onAdded may leave for the new title's page: it gets `close` so the
            // sheet doesn't stay open over it (a second tap would delete the title).
            if (onAdded) onAdded(itemId, close);
            if (onChange) onChange(itemId);
          } else if (status === currentStatus) {
            if (adopted) {
              // Not added here: undoing would delete the title, its progress and
              // its lists. It stays; the sheet only says so.
              toast(t('search.alreadyInLibrary'));
              return;
            }
            // Reclick the active status → undo (remove from library).
            await api.deleteMedia(itemId);
            itemId = null;
            currentStatus = null;
            cell.classList.remove('selected');
            toast(t('search.removedFromLibrary'), 'ok');
            if (onChange) onChange(null);
          } else {
            // Added already → just change the status.
            await api.updateMedia(itemId, { status });
            currentStatus = status;
            clearHighlights();
            cell.classList.add('selected');
            toast(t('search.statusUpdated'), 'ok');
            if (onChange) onChange(itemId);
          }
        } catch (err) {
          if (err.status === 409 && err.data && err.data.item_id) {
            // Already in the library (added elsewhere, the card out of date):
            // adopt it and give it the status just picked, which is what the tap
            // asked for.
            itemId = err.data.item_id;
            adopted = true;
            if (onChange) onChange(itemId);
            try {
              await api.updateMedia(itemId, { status });
              currentStatus = status;
              clearHighlights();
              cell.classList.add('selected');
              toast(t('search.alreadyInLibraryStatus'), 'ok');
            } catch (e) {
              toast(e.message || t('search.somethingWrong'), 'bad');
            }
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
