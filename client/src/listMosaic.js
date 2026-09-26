// Asymmetric mosaic layout for a custom list's detail page (List.js only).
//
// A 6-column CSS Grid with dense auto-flow: every card is a backdrop-first tile
// spanning a shape's worth of columns and rows. The shape sequence is chosen by
// a constraint-based, deterministic PRNG seeded on the list id — so the same
// list always renders the identical mosaic, with no runtime randomness and no
// JS layout calculation (CSS Grid does all the placing).
//
// The one measured value is the row unit: a ResizeObserver keeps the grid's
// auto-row height equal to a single column's width, so a 2x2 tile reads square,
// a 4x2 tile wide, a 3x4 tile tall — the aspect ratios the shapes are named for.

import { el } from './ui.js';
import { withBase } from './basePath.js';
import { imageCache } from './imageCache.js';
import { t } from './i18n.js';

const COLS = 6;
const GAP = 8; // must match .mosaic-grid gap in styles.css

// Tile shapes in grid units. Aspect feel holds because auto-row height == col
// width. Every pattern below fills a full 6-column band, so the mosaic packs
// with no gaps — larger shapes are always preferred.
const FULL = { cols: 6, rows: 4, kind: 'hrect' }; // full-width cinematic hero (~16:9)
const HALF = { cols: 3, rows: 4, kind: 'half' }; // one of a balanced side-by-side pair
const SQUARE = { cols: 2, rows: 2, kind: 'square' }; // 1:1, three to a row

// Three row-patterns, each a complete 6-column band:
//   A — one full-width hero (dominant, most impactful)
//   B — two large half-width cards side by side, equal weight
//   C — three squares (used sparingly to break the rhythm)
const PATTERNS = {
  A: [FULL],
  B: [HALF, HALF],
  C: [SQUARE, SQUARE, SQUARE],
};

// FNV-1a string hash → 32-bit seed. Same list id ⇒ same seed ⇒ same layout.
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32 — tiny, deterministic PRNG.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Walk the pattern picker, one row at a time, until every title has a shape.
// A is the default (larger shapes preferred); B and C appear only when the
// constraint rules invite them. Rules:
//   • never C more than once every 4 rows (and so never two C in a row)
//   • alternate A and B at least once every 3 rows — no 3 identical A/B rows
//   • a trailing partial pattern is filled with the largest shape (full-width A)
function shapeSequence(count, seed) {
  const rng = mulberry32(seed);
  const shapes = [];
  let rowsSinceC = 4; // large ⇒ a C is permitted from the start
  let lastAB = null; // last A-or-B letter chosen (C does not reset the rhythm)
  let abRun = 0; // consecutive A/B rows of that same letter

  while (shapes.length < count) {
    const remaining = count - shapes.length;

    // Choose the row's pattern under the constraints.
    let p;
    if (remaining <= 2) {
      // Not enough titles for a fresh B/C band → fill with the largest shape.
      p = remaining === 2 ? 'B' : 'A';
    } else {
      const forcedAB = abRun >= 2 ? (lastAB === 'A' ? 'B' : 'A') : null; // rhythm
      const cAllowed = rowsSinceC >= 4;
      let choices;
      if (forcedAB) {
        choices = [forcedAB];
      } else {
        // A dominant, B for rhythm, C rare and only when its spacing allows.
        choices = ['A', 'A', 'A', 'B', 'B'];
        if (cAllowed) choices.push('C');
      }
      p = choices[Math.floor(rng() * choices.length)];
    }

    rowsSinceC = p === 'C' ? 0 : rowsSinceC + 1;
    if (p === 'A' || p === 'B') {
      abRun = p === lastAB ? abRun + 1 : 1;
      lastAB = p;
    }

    const run = PATTERNS[p];
    if (run.length > remaining) {
      for (let i = 0; i < remaining; i++) shapes.push(FULL); // largest that fits
    } else {
      for (const s of run) shapes.push(s);
    }
  }
  return shapes.slice(0, count);
}

// Backdrop-first image paint with a poster fallback and a shimmer until decoded.
// imageCache.load resolves to the original URL on a 404 (never null), so we lean
// on the <img> load/error events to detect a missing backdrop and step down.
function paintImage(card, img, item) {
  const sources = [];
  if (item.backdrop_url) sources.push({ url: item.backdrop_url, poster: false });
  if (item.poster_url) sources.push({ url: item.poster_url, poster: true });
  card.classList.add('skeleton');
  if (!sources.length) return; // no imagery cached → keep the shimmer skeleton

  let alive = true;
  const attempt = (i) => {
    if (!alive || i >= sources.length) return; // exhausted → shimmer stays
    const s = sources[i];
    imageCache
      .load(s.url)
      .then((u) => {
        if (!alive) return;
        img.onload = () => {
          card.classList.remove('skeleton');
        };
        img.onerror = () => attempt(i + 1);
        img.classList.toggle('mosaic-img--poster', s.poster);
        img.src = u || s.url;
      })
      .catch(() => attempt(i + 1));
  };
  attempt(0);
  return () => {
    alive = false;
  };
}

// A small masked-lucide corner badge (owned disc / cinema ticket).
function cornerBadge(iconPath, label, mod) {
  const ic = el('span', { class: 'mosaic-badge-ico' });
  const url = `url("${withBase(iconPath)}")`;
  ic.style.webkitMaskImage = url;
  ic.style.maskImage = url;
  return el('span', { class: `mosaic-badge mosaic-badge--${mod}`, 'aria-label': label, title: label }, [ic]);
}

function ratingEl(rating) {
  return el('span', { class: 'mosaic-rating' }, [`★ ${rating}`]);
}

// Build one mosaic card for a title in the given shape.
function buildCard(item, shape, onOpen) {
  const card = el('div', { class: `mosaic-card mosaic-card--${shape.kind}` });
  card.style.gridColumn = `span ${shape.cols}`;
  card.style.gridRow = `span ${shape.rows}`;

  const img = el('img', { class: 'mosaic-img', alt: '', loading: 'lazy' });
  const grad = el('div', { class: 'mosaic-grad' });
  card.append(img, grad);

  // Text block, anchored bottom-left, content scaled to the shape.
  const name = item.title || `#${item.tmdb_id}`;
  const lines = [el('div', { class: 'mosaic-title', text: name })];
  // Squares stay title-only; the large hero (hrect) and half cards carry the
  // full line-up: year, genre tags, and the user rating.
  if (shape.kind !== 'square') {
    const metaParts = [];
    if (item.year) metaParts.push(el('span', { class: 'mosaic-year', text: String(item.year) }));
    if (Array.isArray(item.genres) && item.genres.length) {
      const tags = el('span', { class: 'mosaic-genres' });
      for (const g of item.genres.slice(0, 2)) tags.append(el('span', { class: 'mosaic-genre', text: g }));
      metaParts.push(tags);
    }
    if (metaParts.length) lines.push(el('div', { class: 'mosaic-meta' }, metaParts));
    if (item.rating) lines.push(ratingEl(item.rating));
  }
  card.append(el('div', { class: 'mosaic-text' }, lines));

  // Top-right status badges (same intent as elsewhere in the app).
  const badges = [];
  if (item.owned) badges.push(cornerBadge('/icons/DVD_logo.svg', t('lists.ownedOnDisc'), 'dvd'));
  if (item.watched_in_cinema) badges.push(cornerBadge('/icons/lucide/ticket.svg', t('lists.watchedInCinema'), 'cine'));
  if (badges.length) card.append(el('div', { class: 'mosaic-badges' }, badges));

  paintImage(card, img, item);

  card.addEventListener('click', () => onOpen(item));
  return card;
}

// Public: build the mosaic grid for a list. Returns { el, destroy }.
export function createMosaic(items, seedKey, onOpen) {
  const grid = el('div', { class: 'mosaic-grid' });
  const shapes = shapeSequence(items.length, hashSeed(seedKey));
  items.forEach((it, i) => grid.append(buildCard(it, shapes[i], onOpen)));

  // Keep the row unit equal to one column's width so the shapes' aspect ratios
  // hold at every viewport width (the content is capped at 900px on desktop).
  const applyRowUnit = () => {
    const w = grid.clientWidth;
    if (!w) return;
    const colW = (w - (COLS - 1) * GAP) / COLS;
    grid.style.setProperty('--mrow', `${colW}px`);
  };
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(applyRowUnit);
    ro.observe(grid);
  } else {
    window.addEventListener('resize', applyRowUnit);
  }
  // First measure once attached (clientWidth is 0 until in the DOM).
  requestAnimationFrame(applyRowUnit);

  return {
    el: grid,
    destroy() {
      if (ro) ro.disconnect();
      else window.removeEventListener('resize', applyRowUnit);
    },
  };
}
