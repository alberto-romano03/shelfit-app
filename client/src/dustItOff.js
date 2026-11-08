import { haptic } from './haptic.js';
import { api } from './api.js';
import { navigate } from './router.js';
import {
  el,
  icons,
  cachedImg,
  mountPoster,
  toast,
  spinner,
  openSheet,
  setLabel,
  showMoreToggle,
  segmentedControl,
  stateBlock,
  lucideIcon,
} from './ui.js';
import { withBase } from './basePath.js';
import { imageCache } from './imageCache.js';
import { pget, pset, pequal, PK } from './persist.js';
import { t, locale } from './i18n.js';
import { collapsibleText } from './collapsibleText.js';

// A cached genre payload is usable only when it carries both lists as arrays.
function validGenres(g) {
  return !!g && Array.isArray(g.movie) && Array.isArray(g.tv);
}

// [value, label key] — resolved with t() at render time.
const TYPES = [
  ['movie', 'media.movies'],
  ['show', 'media.tvShows'],
];
// The animated mood emojis are Google's Animated Noto Emoji (CC BY 4.0,
// https://googlefonts.github.io/noto-emoji-animation/), the 512px WebP files
// resized to 128px: 1f601 grin, 1f622 cry, 1f631 scream, 1f92f mind blown,
// 1f3ac clapper, 1f634 sleep. stills/ holds the first frame of each.
// [value, animated image file (icons/animated-genre/), label key, soft accent color, one loop in ms]
const MOODS = [
  ['light', 'light-fun.webp', 'dust.mood.light', '#f2c94c', 2340],
  ['emotional', 'emotional.webp', 'dust.mood.emotional', '#5b8def', 1650],
  ['tense', 'tense.webp', 'dust.mood.tense', '#eb5757', 1530],
  ['mindbending', 'mind-bending.webp', 'dust.mood.mindbending', '#9b6dff', 2610],
  ['epic', 'epic.webp', 'dust.mood.epic', '#f2994a', 1351],
  ['easy', 'easy-watch.webp', 'dust.mood.easy', '#3bb58f', 1800],
];
const MOOD_LOOPS = 2;
const MOOD_REST_MS = 5000;
const moodFiles = new Map(); // file -> Promise<Blob>, each fetched once

// The animation's bytes, fetched once per session (a failure is forgotten, so the
// next open tries again).
function moodFile(file) {
  if (!moodFiles.has(file)) {
    const p = fetch(withBase(`/icons/animated-genre/${file}`)).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.blob();
    });
    p.catch(() => moodFiles.delete(file));
    moodFiles.set(file, p);
  }
  return moodFiles.get(file);
}

// Warm on intent (a finger on the Dust It Off spine): decode the six stills and
// fetch the six animations, so the mood grid opens with every emoji in place and
// moving on time. Small files the service worker already keeps; once a session.
const warmedStills = []; // held so the decoded stills stay in memory
let moodsWarmed = false;
export function warmDustItOff() {
  if (moodsWarmed) return;
  moodsWarmed = true;
  // The stills paint first, so they go first; the animations follow once the
  // stills are in, never competing with them for the connection.
  const stills = MOODS.map(([, file]) => {
    const img = new Image();
    img.decoding = 'async';
    img.fetchPriority = 'high'; // six tiny files the sheet shows first: not left in the low image queue
    img.src = withBase(`/icons/animated-genre/stills/${file}`);
    warmedStills.push(img);
    return img.decode ? img.decode().catch(() => {}) : Promise.resolve();
  });
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  Promise.all(stills).then(() => {
    for (const [, file] of MOODS) moodFile(file).catch(() => {});
  });
}

// A mood emoji plays a couple of loops, rests on its first frame, then plays again. An
// animated image can't be paused, so it swaps with its still; a new blob URL is what makes
// it start over from that same frame, as the same URL would carry on where it had got to.
// Only the still is shown with reduced motion, or when the animation can't be fetched.
function moodEmoji(cls, file, loopMs) {
  const still = withBase(`/icons/animated-genre/stills/${file}`);
  const img = el('img', { class: cls, src: still, alt: '', 'aria-hidden': 'true' });
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return img;

  const play = async () => {
    if (!img.isConnected) return; // the sheet closed or redrew: this one is done
    let blob;
    try {
      blob = await moodFile(file);
    } catch {
      return; // moodFile forgot it: the next open tries again
    }
    if (!img.isConnected) return;
    const url = URL.createObjectURL(blob);
    img.addEventListener(
      'load',
      () => {
        setTimeout(() => {
          URL.revokeObjectURL(url);
          if (!img.isConnected) return;
          img.src = still;
          setTimeout(play, MOOD_REST_MS);
        }, MOOD_LOOPS * loopMs);
      },
      { once: true }
    );
    img.src = url;
  };
  // Once it's in the sheet and its still has loaded, so the stills (what paints
  // first) never queue behind the bigger animations.
  const start = () => setTimeout(play);
  if (img.complete) start();
  else {
    img.addEventListener('load', start, { once: true });
    img.addEventListener('error', start, { once: true });
  }
  return img;
}
// Duration snap points (movies only). null = "Any" (no filter).
// [value, tick label key, floating-label key showing the actual runtime range]
const DURATIONS = [
  ['short', 'dust.duration.short', 'dust.duration.shortRange'],
  ['standard', 'dust.duration.standard', 'dust.duration.standardRange'],
  ['long', 'dust.duration.long', 'dust.duration.longRange'],
  [null, 'dust.duration.any', 'dust.duration.any'],
];
// Where each level sits along the bar, in %: the ends near the edges, the rest evenly between.
const DURATION_STOPS = [8, 36, 64, 92];
// [value, label key, filled-star level out of 5]
const RATINGS = [
  [null, 'dust.rating.any', 0],
  [6, 'dust.rating.6', 3],
  [7, 'dust.rating.7', 3.5],
  [8, 'dust.rating.8', 4],
];
// [value, name key, year-range key, css class]
const ERAS = [
  ['classic', 'dust.era.classic', 'dust.era.classicRange', 'era-classic'],
  ['90s00s', 'dust.era.90s00s', 'dust.era.90s00sRange', 'era-90s00s'],
  ['recent', 'dust.era.recent', 'dust.era.recentRange', 'era-recent'],
  ['latest', 'dust.era.latest', 'dust.era.latestRange', 'era-latest'],
];

// Thematic font per genre (CSS class → font stack in styles.css), keyed by TMDB
// genre id. The ids are the same in every language, while the names arrive in the
// configured TMDB language (Italian by default), so matching names alone left
// "Commedia", "Avventura", "Azione"… on the default font. Movie and TV ids differ
// for a few genres (e.g. 878 vs 10765), so both are listed.
const GENRE_FONTS = {
  27: 'gf-horror', // Horror
  53: 'gf-horror', // Thriller
  37: 'gf-western', // Western (movie + tv)
  10749: 'gf-romance', // Romance
  36: 'gf-classic', // History
  99: 'gf-classic', // Documentary
  10752: 'gf-classic', // War
  10768: 'gf-classic', // War & Politics (tv)
  878: 'gf-scifi', // Science Fiction
  14: 'gf-scifi', // Fantasy
  10765: 'gf-scifi', // Sci-Fi & Fantasy (tv)
  16: 'gf-fun', // Animation
  35: 'gf-fun', // Comedy
  10751: 'gf-fun', // Family
  10762: 'gf-fun', // Kids (tv)
  10402: 'gf-fun', // Music
  10764: 'gf-fun', // Reality (tv)
  80: 'gf-noir', // Crime
  9648: 'gf-noir', // Mystery
  28: 'gf-action', // Action
  12: 'gf-action', // Adventure
  10759: 'gf-action', // Action & Adventure (tv)
  18: 'gf-drama', // Drama
  10766: 'gf-drama', // Soap (tv)
};

// `g` is a TMDB genre ({ id, name }). The id decides; the English-name match is
// only a fallback for an id TMDB might add later.
function genreFontClass(g) {
  if (GENRE_FONTS[g.id]) return GENRE_FONTS[g.id];
  const n = String(g.name || '').toLowerCase();
  if (/horror|thriller/.test(n)) return 'gf-horror';
  if (/western/.test(n)) return 'gf-western';
  if (/romance/.test(n)) return 'gf-romance';
  if (/history|documentary|war|politics/.test(n)) return 'gf-classic';
  if (/science fiction|sci-fi|fantasy/.test(n)) return 'gf-scifi';
  if (/animation|comedy|family|kids|music|reality/.test(n)) return 'gf-fun';
  if (/crime|mystery/.test(n)) return 'gf-noir';
  if (/action|adventure/.test(n)) return 'gf-action';
  if (/drama|soap/.test(n)) return 'gf-drama';
  return 'gf-default';
}

export function openDustItOff() {
  openSheet((sheet, close) => {
    const state = {
      type: 'movie',
      genres: new Set(),
      mood: null,
      duration: null,
      minRating: null,
      era: null,
    };
    let genreData = null;

    // --- Header: title, centred type toggle, and (result-mode) adjust button ---
    // Shared segmented control (the app default for this choice). Switching type
    // resets the genre/duration filters, exactly as the old chip pair did.
    const typeSeg = segmentedControl({
      options: TYPES.map(([val, key]) => [val, t(key)]),
      value: state.type,
      ariaLabel: t('dust.libraryType'),
      center: true,
      onChange: (val) => {
        state.type = val;
        state.genres = new Set();
        state.duration = null;
        renderFilters();
      },
    });
    const typeToggle = typeSeg.el;

    const adjustBtn = el('button', { class: 'chip dust-adjust', html: `${icons.back}<span>${t('dust.adjustFilters')}</span>` });
    adjustBtn.style.display = 'none';
    adjustBtn.addEventListener('click', renderFilters);

    const header = el('div', { class: 'sheet-header dust-header' }, [
      el('div', { class: 'sheet-title-row' }, [el('h3', { text: t('dust.title') })]),
      typeToggle,
      adjustBtn,
    ]);

    const body = el('div', { class: 'sheet-body' });
    const footer = el('div', { class: 'sheet-footer' });
    sheet.append(header, body, footer);

    function label(text) {
      return el('div', { class: 'dust-label', text });
    }
    function group(text, node) {
      return el('div', { class: 'dust-group' }, [label(text), node]);
    }

    // --- Genre (rounded chips, thematic fonts, no emoji) ---
    // Collapsed to a few rows with a "Show more"/"Show less" toggle, mirroring
    // the overview toggle on the detail page.
    function buildGenres() {
      const list = genreData ? (state.type === 'movie' ? genreData.movie : genreData.tv) : null;
      const row = el('div', { class: 'genre-grid' });
      if (!list) {
        row.append(el('div', { class: 'muted', text: t('dust.loadingGenres') }));
        return row;
      }
      list.forEach((g) => {
        const c = el('button', {
          class: `genre-chip ${genreFontClass(g)}` + (state.genres.has(g.id) ? ' active' : ''),
          // Display-only shortening: the sci-fi face is wide and tracked, so the
          // long name ("Science Fiction", "Fantascienza") would ellipsize.
          text: g.id === 878 ? 'SCI-FI' : g.name,
        });
        c.addEventListener('click', () => {
          if (state.genres.has(g.id)) {
            state.genres.delete(g.id);
            c.classList.remove('active');
          } else {
            state.genres.add(g.id);
            c.classList.add('active');
          }
        });
        row.append(c);
      });

      // Collapse to ~3 rows; reveal the rest with a toggle. Height animates via
      // max-height (set to the measured scrollHeight so wrapping stays correct).
      row.classList.add('genre-collapsible', 'collapsed');
      const more = showMoreToggle();
      const toggle = more.el;
      toggle.classList.add('genre-toggle');
      let expanded = false;
      toggle.addEventListener('click', () => {
        expanded = !expanded;
        if (expanded) {
          row.style.maxHeight = row.scrollHeight + 'px';
          row.classList.remove('collapsed');
        } else {
          row.style.maxHeight = row.scrollHeight + 'px'; // pin current height
          void row.offsetHeight; // reflow so the collapse animates
          row.classList.add('collapsed');
          row.style.maxHeight = '';
        }
        more.setOpen(expanded);
      });
      // After expanding, drop the inline cap so the grid can reflow freely.
      row.addEventListener('transitionend', (e) => {
        if (e.propertyName === 'max-height' && expanded) row.style.maxHeight = 'none';
      });

      const wrap = el('div', {}, [row, toggle]);
      // Only show the toggle when the content actually overflows the collapsed cap.
      requestAnimationFrame(() => {
        const collapsedH = parseFloat(getComputedStyle(row).maxHeight) || 0;
        if (row.scrollHeight <= collapsedH + 1) {
          toggle.style.display = 'none';
          row.classList.remove('collapsed');
        }
      });
      return wrap;
    }

    // --- Mood ---
    function buildMood() {
      const grid = el('div', { class: 'mood-grid' });
      MOODS.forEach(([val, gif, textKey, color, loopMs]) => {
        const btn = el('button', { class: 'mood-btn' + (state.mood === val ? ' active' : '') });
        btn.style.setProperty('--tile', color);
        const emoji = moodEmoji('mood-emoji', gif, loopMs);
        btn.append(emoji, el('span', { class: 'mood-label', text: t(textKey) }));
        btn.addEventListener('click', () => {
          state.mood = state.mood === val ? null : val;
          grid.querySelectorAll('.mood-btn').forEach((b) => b.classList.remove('active'));
          if (state.mood === val) btn.classList.add('active');
        });
        grid.append(btn);
      });
      return grid;
    }

    // --- Duration slider (aligned label / ticks / thumb) ---
    function buildDuration() {
      const N = DURATIONS.length;
      // Everything that moves is moved by transform, on a rail as wide as the bar (a
      // transform's percentage is of the element's own width), so a step never lays out
      // the sheet. The handle sits over the middle of the chosen level's name, and the gold
      // ends just past it. Any length has no limit to mark, so the gold takes the whole bar.
      const value = el('span', { class: 'dur-value' });
      const rail = el('div', { class: 'dur-rail' }, [el('i', { class: 'dur-grip' }), value]);
      const fill = el('div', { class: 'dur-fill' });
      const bar = el(
        'div',
        { class: 'dur-bar', role: 'slider', tabindex: '0', 'aria-label': t('dust.duration'), 'aria-valuemin': '0', 'aria-valuemax': String(N - 1) },
        [fill, rail]
      );
      const levels = DURATIONS.map(([, levelKey], i) => {
        const b = el('button', { class: 'dur-level', type: 'button', text: t(levelKey) });
        b.style.left = `${DURATION_STOPS[i]}%`;
        b.addEventListener('click', () => apply(i));
        return b;
      });
      const wrap = el('div', { class: 'dur-slider' }, [bar, el('div', { class: 'dur-levels' }, levels)]);

      let idx = DURATIONS.findIndex((d) => d[0] === state.duration);
      if (idx < 0) idx = N - 1;

      function apply(i) {
        idx = Math.max(0, Math.min(N - 1, i));
        const pct = DURATION_STOPS[idx];
        fill.style.transform = DURATIONS[idx][0] === null ? 'translateX(0)' : `translateX(calc(${pct - 100}% + 11px))`;
        rail.style.transform = `translateX(${pct}%)`;
        // Beside the fill while there's room, inside it once there isn't.
        rail.classList.toggle('is-inside', idx >= N / 2);
        value.textContent = t(DURATIONS[idx][2]);
        bar.setAttribute('aria-valuenow', String(idx));
        bar.setAttribute('aria-valuetext', value.textContent);
        state.duration = DURATIONS[idx][0];
        levels.forEach((b, k) => b.classList.toggle('on', k === idx));
      }
      apply(idx);

      function idxFromX(clientX) {
        const rect = bar.getBoundingClientRect();
        const at = ((clientX - rect.left) / rect.width) * 100;
        // The nearest stop.
        return DURATION_STOPS.reduce((best, stop, i) => (Math.abs(stop - at) < Math.abs(DURATION_STOPS[best] - at) ? i : best), 0);
      }
      let dragging = false;
      bar.addEventListener('pointerdown', (e) => {
        dragging = true;
        bar.classList.add('dragging');
        apply(idxFromX(e.clientX));
        try {
          bar.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      });
      bar.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const next = idxFromX(e.clientX);
        if (next === idx) return;
        apply(next);
        haptic();
      });
      const end = () => {
        dragging = false;
        bar.classList.remove('dragging');
      };
      bar.addEventListener('pointerup', end);
      bar.addEventListener('pointercancel', end);
      bar.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') apply(idx + 1);
        if (e.key === 'ArrowLeft') apply(idx - 1);
      });
      return wrap;
    }

    // --- Minimum rating (horizontal full-width buttons) ---
    function starMeter(level) {
      const goldWrap = el('div', { class: 'stars5-goldwrap' }, [
        el('div', { class: 'stars5 gold', text: '★★★★★' }),
      ]);
      goldWrap.style.width = (level / 5) * 100 + '%';
      return el('div', { class: 'star-meter' }, [
        el('div', { class: 'stars5 base', text: '★★★★★' }),
        goldWrap,
      ]);
    }
    function buildRating() {
      const row = el('div', { class: 'rating-btns' });
      RATINGS.forEach(([val, textKey, level]) => {
        const btn = el('button', { class: 'rating-btn' + (state.minRating === val ? ' active' : '') });
        btn.append(el('span', { class: 'rating-btn-label', text: t(textKey) }), starMeter(level));
        btn.addEventListener('click', () => {
          state.minRating = val;
          row.querySelectorAll('.rating-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
        });
        row.append(btn);
      });
      return row;
    }

    // --- Era ---
    function buildEra() {
      const grid = el('div', { class: 'era-grid' });
      ERAS.forEach(([val, nameKey, rangeKey, cls]) => {
        const btn = el('button', { class: `era-btn ${cls}` + (state.era === val ? ' active' : '') });
        btn.append(el('span', { class: 'era-name', text: t(nameKey) }), el('span', { class: 'era-range', text: t(rangeKey) }));
        btn.addEventListener('click', () => {
          state.era = state.era === val ? null : val;
          grid.querySelectorAll('.era-btn').forEach((b) => b.classList.remove('active'));
          if (state.era === val) btn.classList.add('active');
        });
        grid.append(btn);
      });
      return grid;
    }

    function renderFilters() {
      typeToggle.style.display = '';
      adjustBtn.style.display = 'none';
      body.className = 'sheet-body';
      body.innerHTML = '';
      body.append(group(t('common.genre'), buildGenres()));
      body.append(group(t('dust.mood'), buildMood()));
      if (state.type === 'movie') body.append(group(t('dust.duration'), buildDuration()));
      body.append(group(t('dust.minRating'), buildRating()));
      body.append(group(t('dust.era'), buildEra()));
      footer.innerHTML = '';
      // Two-button bottom row (Close on the left) — the app's shared modal pattern,
      // matching the result view's action row below.
      footer.append(
        el('div', { class: 'dust-actions' }, [
          el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.close') }),
    ]),
          el('button', { class: 'btn btn-primary', onClick: run }, [
      lucideIcon('search', 'btn-lucide'),
      el('span', { text: t('common.search') }),
    ]),
        ])
      );
    }

    // --- Pick queue -------------------------------------------------------
    // Like Back to the Shelf's prefetch queue: PICK_AHEAD suggestions are kept
    // ready (data fetched, poster + backdrop downloaded AND decoded), so "Suggest
    // another" shows the next one instantly while the queue tops itself back up
    // in the background. A new search (after Adjust filters) starts a fresh
    // queue; `gen` drops any fill still in flight from the old one.
    const PICK_AHEAD = 3;
    const PICK_DECODE_CAP_MS = 1500; // never hold a pick back longer for its art
    let picks = { gen: 0, ready: [], seen: new Set(), topping: null };

    function resetPicks() {
      picks = { gen: picks.gen + 1, ready: [], seen: new Set(), topping: null };
    }

    // Fetch + decode an image so it paints in the frame the pick is shown.
    function decodeImage(url) {
      return imageCache.ready(url);
    }
    function warmPick(r) {
      return Promise.race([
        Promise.all([decodeImage(r.poster_url), decodeImage(r.backdrop_url)]),
        new Promise((resolve) => setTimeout(resolve, PICK_DECODE_CAP_MS)),
      ]);
    }
    function enqueue(list) {
      for (const r of list) picks.ready.push({ r, warm: warmPick(r) });
    }

    // Up to `n` new picks for the current filters. The server skips titles
    // already suggested this session while anything else matches; once every
    // match has been seen it repeats them rather than coming up empty.
    async function fetchPicks(n) {
      const gen = picks.gen;
      const res = await api.discover({
        type: state.type,
        genres: [...state.genres],
        mood: state.mood,
        duration: state.duration,
        minRating: state.minRating,
        era: state.era,
        count: n,
        exclude: [...picks.seen],
      });
      if (gen !== picks.gen) return []; // a new search started meanwhile
      const list = (res && (res.results || (res.result ? [res.result] : []))) || [];
      let fresh = list.filter((r) => !picks.seen.has(r.tmdb_id));
      if (!fresh.length && list.length) {
        picks.seen = new Set(); // every match seen: start the round again
        fresh = list;
      }
      fresh.forEach((r) => picks.seen.add(r.tmdb_id));
      return fresh;
    }

    // Refill to PICK_AHEAD in the background, one fill at a time.
    function topUp() {
      if (picks.topping || picks.ready.length >= PICK_AHEAD) return;
      const p = picks;
      p.topping = fetchPicks(PICK_AHEAD - p.ready.length)
        .then((list) => {
          if (p === picks) enqueue(list);
        })
        .catch(() => {}) // a failed refill just means the next tap fetches
        .finally(() => {
          p.topping = null;
        });
    }

    // The next pick: from the queue (instant), else the fill already in flight,
    // else a direct fetch (the first search, or a drained queue). Throws on a
    // network error; resolves null when nothing matches at all.
    async function nextPick() {
      if (!picks.ready.length && picks.topping) await picks.topping;
      if (!picks.ready.length) enqueue(await fetchPicks(PICK_AHEAD));
      const entry = picks.ready.shift();
      topUp();
      if (!entry) return null;
      await entry.warm;
      return entry.r;
    }

    // --- Run / result ---
    async function run() {
      typeToggle.style.display = 'none';
      adjustBtn.style.display = 'flex';
      body.className = 'sheet-body';
      body.innerHTML = '';
      body.append(spinner());
      footer.innerHTML = '';
      resetPicks();
      let first;
      try {
        first = await nextPick();
      } catch (err) {
        body.innerHTML = '';
        body.append(
          stateBlock({ kind: 'error', tier: 'section', title: t('dust.error') })
        );
        return;
      }
      if (!first) {
        body.innerHTML = '';
        body.append(
          stateBlock({ tier: 'section', title: t('dust.empty') })
        );
        return;
      }
      renderResult(first);
    }

    // --- Result: the pick as a card. The backdrop opens it and the poster
    // overlaps it (the title page's head), then the meta line, the genres in the
    // filter screen's own typefaces, the plot, and the filters that led here.
    // "Suggest another" shuffles the card in place; the sheet header, layout and
    // footer actions never re-render.
    function renderResult(firstResult) {
      body.className = 'sheet-body dust-result-mode';
      body.innerHTML = '';

      let current = firstResult;

      // The viewer's own choices, so the pick explains itself.
      function whyChips() {
        const chips = [];
        const mood = MOODS.find(([v]) => v === state.mood);
        if (mood) {
          chips.push(
            el('span', { class: 'pick-why-chip' }, [
              moodEmoji('pick-why-emoji', mood[1], mood[4]),
              el('span', { text: t(mood[2]) }),
            ])
          );
        }
        const list = genreData ? (state.type === 'movie' ? genreData.movie : genreData.tv) : [];
        for (const g of list) {
          if (state.genres.has(g.id)) chips.push(el('span', { class: 'pick-why-chip', text: g.name }));
        }
        const era = ERAS.find(([v]) => v === state.era);
        if (era) chips.push(el('span', { class: 'pick-why-chip', text: t(era[1]) }));
        const dur = DURATIONS.find(([v]) => v && v === state.duration);
        if (dur) chips.push(el('span', { class: 'pick-why-chip', text: t(dur[1]) }));
        const rating = RATINGS.find(([v]) => v && v === state.minRating);
        if (rating) chips.push(el('span', { class: 'pick-why-chip', text: `★ ${t(rating[1])}` }));
        return chips;
      }

      const heroImg = el('img', { class: 'pick-hero-img', alt: '' });
      const posterHost = el('div', { class: 'pick-poster' });
      const titleEl = el('h3', { class: 'pick-title' });
      const metaEl = el('div', { class: 'pick-meta' });
      const genresEl = el('div', { class: 'pick-genres' });
      const descHost = el('div', { class: 'pick-desc' });
      const why = whyChips();

      const card = el('div', { class: 'pick-card' }, [
        el('div', { class: 'pick-hero' }, [heroImg]),
        el('div', { class: 'pick-head' }, [
          posterHost,
          el('div', { class: 'pick-head-text' }, [
            el('div', { class: 'pick-eyebrow', text: t('dust.fromStore') }),
            titleEl,
            metaEl,
          ]),
        ]),
        genresEl,
        descHost,
      ]);
      body.append(
        card,
        el('div', { class: 'pick-why' }, [
          el('div', { class: 'dust-label', text: t('dust.pickedFrom') }),
          why.length
            ? el('div', { class: 'pick-why-row' }, why)
            : el('div', { class: 'pick-why-none', text: t('dust.noFilters') }),
        ])
      );

      function fill(r) {
        current = r;
        // No backdrop → the card simply starts at the poster.
        card.classList.toggle('no-hero', !r.backdrop_url);
        // The queue already holds the backdrop in memory: take it from there so
        // it paints in the same frame as the rest of the card.
        if (r.backdrop_url) heroImg.src = imageCache.get(r.backdrop_url) || withBase(r.backdrop_url);
        else heroImg.removeAttribute('src');
        posterHost.innerHTML = '';
        mountPoster(posterHost, r.poster_url, r.title, { viaCache: true }); // joins the queue's load
        titleEl.textContent = r.title || t('dust.untitled');
        // Year · type · TMDB score. The 0-10 score wears the TMDB mark so it is
        // never mistaken for the viewer's own 1-5 stars.
        const tmdb = r.rating
          ? el('span', { class: 'pick-tmdb' }, [
              el('img', { src: withBase('/icons/tmdb/tmdb-logo.svg'), alt: 'TMDB' }),
              el('span', { text: r.rating.toLocaleString(locale(), { minimumFractionDigits: 1 }) }),
            ])
          : null;
        const parts = [
          r.year ? el('span', { text: r.year }) : null,
          el('span', { text: t(r.type === 'movie' ? 'media.movie' : 'media.tvSeries') }),
          tmdb,
        ].filter(Boolean);
        metaEl.replaceChildren(
          ...parts.flatMap((n, i) => (i ? [el('span', { class: 'pick-dot', text: '·' }), n] : [n]))
        );
        const names = r.genres || [];
        const ids = r.genre_ids || [];
        genresEl.replaceChildren(
          ...names
            .slice(0, 4)
            .map((name, i) => el('span', { class: `pick-genre ${genreFontClass({ id: ids[i], name })}`, text: name }))
        );
        descHost.replaceChildren(
          ...(r.overview ? collapsibleText(r.overview) : [el('div', { class: 'muted', text: t('dust.noDescription') })])
        );
      }
      fill(firstResult);

      const addBtn = el('button', { class: 'btn btn-primary' }, [
        lucideIcon('plus', 'btn-lucide'),
        el('span', { text: t('dust.addToLibrary') }),
      ]);
      addBtn.addEventListener('click', async () => {
        addBtn.disabled = true;
        setLabel(addBtn, t('dust.adding'));
        try {
          const added = await api.addMedia(current.tmdb_id, current.type, 'plan_to_watch');
          toast(t('dust.added'), 'ok');
          close();
          if (added && added.id) navigate(`/detail/${added.id}`);
        } catch (err) {
          if (err.status === 409 && err.data && err.data.item_id) {
            close();
            navigate(`/detail/${err.data.item_id}`);
            return;
          }
          addBtn.disabled = false;
          setLabel(addBtn, t('dust.addToLibrary'));
          toast(err.message || t('dust.addFailed'), 'bad');
        }
      });

      const againBtn = el('button', { class: 'btn btn-secondary' }, [
        lucideIcon('refresh-cw', 'btn-lucide'),
        el('span', { text: t('dust.suggestAnother') }),
      ]);
      // Shuffle: the card slides out, the next pick (already waiting in the
      // queue, art decoded) slides in: a tape pulled off the shelf, the next
      // slotted in. Reduced motion keeps only the fade.
      async function suggestAnother() {
        if (againBtn.disabled) return;
        againBtn.disabled = true;
        againBtn.classList.add('is-loading');
        let next;
        try {
          [next] = await Promise.all([
            nextPick(),
            new Promise((resolve) => {
              card.classList.add('is-leaving');
              setTimeout(resolve, 180);
            }),
          ]);
        } catch (err) {
          card.classList.remove('is-leaving');
          toast(t('dust.error'), 'bad');
          return;
        } finally {
          againBtn.disabled = false;
          againBtn.classList.remove('is-loading');
        }
        if (!next) {
          card.classList.remove('is-leaving'); // nothing else matched: keep the current pick
          toast(t('dust.empty'), 'bad');
          return;
        }
        fill(next);
        body.scrollTop = 0;
        card.classList.remove('is-leaving');
        card.classList.add('is-entering'); // jump to the right, unanimated…
        void card.offsetWidth;
        card.classList.remove('is-entering'); // …then slide into place
      }
      againBtn.addEventListener('click', suggestAnother);

      footer.innerHTML = '';
      footer.append(el('div', { class: 'dust-actions' }, [againBtn, addBtn]));
    }

    renderFilters();

    // Re-render the filter panel with whatever genre data is now in `genreData`,
    // but only while it's actually on screen (not during a result view).
    function refreshGenresIfShowing() {
      if (adjustBtn.style.display === 'none') renderFilters();
    }

    // Paint instantly from the durable cache when present (no "Loading genres…"),
    // then revalidate against TMDB. The lists change very rarely, so the fresh
    // fetch usually matches and nothing re-renders; when it genuinely differs, the
    // cache and the open panel update in place.
    const cachedGenres = pget(PK.genres);
    if (validGenres(cachedGenres)) {
      genreData = cachedGenres;
      refreshGenresIfShowing();
    }
    api
      .genres()
      .then((g) => {
        if (!validGenres(g)) return; // ignore a malformed response; keep the cache
        pset(PK.genres, g); // persist for next time (no-op when unchanged)
        if (pequal(g, genreData)) return; // already showing exactly this
        genreData = g;
        refreshGenresIfShowing();
      })
      .catch(() => {
        // Refetch failed. Keep any cached genres already shown; only fall back to
        // an empty (no-chips) state when nothing is cached, so the panel never
        // stays stuck on "Loading genres…". The rest of the sheet is unaffected.
        if (!genreData) {
          genreData = { movie: [], tv: [] };
          refreshGenresIfShowing();
        }
      });
  });
}
