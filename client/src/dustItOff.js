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
  segmentedControl,
  stateBlock,
  lucideIcon,
} from './ui.js';
import { withBase } from './basePath.js';
import { pget, pset, pequal, PK } from './persist.js';
import { t } from './i18n.js';

// A cached genre payload is usable only when it carries both lists as arrays.
function validGenres(g) {
  return !!g && Array.isArray(g.movie) && Array.isArray(g.tv);
}

// [value, label key] — resolved with t() at render time.
const TYPES = [
  ['movie', 'media.movies'],
  ['show', 'media.tvShows'],
];
// The animated mood emojis (JoyPixels Animations) are sourced from:
// https://emojipedia.org/joypixels-animations
// [value, animated gif file (icons/animated-genre/), label key, soft accent color]
const MOODS = [
  ['light', 'light-fun.gif', 'dust.mood.light', '#f2c94c'],
  ['emotional', 'emotional.gif', 'dust.mood.emotional', '#5b8def'],
  ['tense', 'tense.gif', 'dust.mood.tense', '#eb5757'],
  ['mindbending', 'mind-bending.gif', 'dust.mood.mindbending', '#9b6dff'],
  ['epic', 'epic.gif', 'dust.mood.epic', '#f2994a'],
  ['easy', 'easy-watch.gif', 'dust.mood.easy', '#3bb58f'],
];
// Duration snap points (movies only). null = "Any" (no filter).
// [value, tick label key, floating-label key showing the actual runtime range]
const DURATIONS = [
  ['short', 'dust.duration.short', 'dust.duration.shortRange'],
  ['standard', 'dust.duration.standard', 'dust.duration.standardRange'],
  ['long', 'dust.duration.long', 'dust.duration.longRange'],
  [null, 'dust.duration.any', 'dust.duration.any'],
];
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
      const toggle = el('div', { class: 'overview-toggle genre-toggle', text: t('common.showMore') });
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
        setLabel(toggle, expanded ? t('dust.showLess') : t('common.showMore'));
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
      MOODS.forEach(([val, gif, textKey, color]) => {
        const btn = el('button', { class: 'mood-btn' + (state.mood === val ? ' active' : '') });
        btn.style.setProperty('--mood', color);
        const emoji = el('img', {
          class: 'mood-emoji',
          src: withBase(`/icons/animated-genre/${gif}`),
          alt: '',
          'aria-hidden': 'true',
        });
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
      const labelEl = el('div', { class: 'dur-label' });
      const fill = el('div', { class: 'dur-fill' });
      const thumb = el('div', { class: 'dur-thumb' });
      const track = el('div', { class: 'dur-track' }, [fill, thumb]);
      const ticks = el('div', { class: 'dur-ticks' });
      DURATIONS.forEach(([, tickKey], i) => {
        const s = el('span', { text: t(tickKey) });
        s.style.left = (i / (N - 1)) * 100 + '%';
        ticks.append(s);
      });
      const wrap = el('div', { class: 'dur-slider' }, [
        el('div', { class: 'dur-label-track' }, [labelEl]),
        track,
        ticks,
      ]);

      let idx = DURATIONS.findIndex((d) => d[0] === state.duration);
      if (idx < 0) idx = N - 1;

      function apply(i) {
        idx = Math.max(0, Math.min(N - 1, i));
        const pct = (idx / (N - 1)) * 100;
        thumb.style.left = pct + '%';
        fill.style.width = pct + '%';
        labelEl.style.left = pct + '%';
        // Anchor the label to the edge at the extremes so it never overflows the
        // sheet: left-aligned at the first stop, right-aligned at the last,
        // centred over the thumb everywhere in between.
        labelEl.style.transform =
          idx === 0 ? 'translateX(0)' : idx === N - 1 ? 'translateX(-100%)' : 'translateX(-50%)';
        // NOT setLabel: this readout tracks a live drag, so a fade per step
        // would flicker. It moves with the thumb, which already reads as change.
        labelEl.textContent = t(DURATIONS[idx][2]);
        state.duration = DURATIONS[idx][0];
        ticks.querySelectorAll('span').forEach((s, k) => s.classList.toggle('on', k === idx));
      }
      apply(idx);

      function idxFromX(clientX) {
        const rect = track.getBoundingClientRect();
        let r = (clientX - rect.left) / rect.width;
        r = Math.max(0, Math.min(1, r));
        return Math.round(r * (N - 1));
      }
      let dragging = false;
      track.addEventListener('pointerdown', (e) => {
        dragging = true;
        thumb.classList.add('dragging');
        apply(idxFromX(e.clientX));
        try {
          track.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      });
      track.addEventListener('pointermove', (e) => dragging && apply(idxFromX(e.clientX)));
      const end = () => {
        dragging = false;
        thumb.classList.remove('dragging');
      };
      track.addEventListener('pointerup', end);
      track.addEventListener('pointercancel', end);
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
      lucideIcon('book-search', 'btn-lucide'),
      el('span', { text: t('common.search') }),
    ]),
        ])
      );
    }

    // --- Run / result ---
    async function run() {
      typeToggle.style.display = 'none';
      adjustBtn.style.display = 'flex';
      body.className = 'sheet-body';
      body.innerHTML = '';
      body.append(spinner());
      footer.innerHTML = '';
      let res;
      try {
        res = await api.discover({
          type: state.type,
          genres: [...state.genres],
          mood: state.mood,
          duration: state.duration,
          minRating: state.minRating,
          era: state.era,
        });
      } catch (err) {
        body.innerHTML = '';
        body.append(
          stateBlock({ kind: 'error', tier: 'section', title: t('dust.error') })
        );
        return;
      }
      if (!res || !res.result) {
        body.innerHTML = '';
        body.append(
          el('div', { class: 'dust-empty' }, [
            el('div', { class: 'dust-empty-emoji', text: '🗄️' }),
            el('div', { text: t('dust.empty') }),
          ])
        );
        return;
      }
      renderResult(res.result);
    }

    function renderResult(firstResult) {
      body.className = 'sheet-body dust-result-mode';
      body.innerHTML = '';

      let current = firstResult;

      // Stable result scaffold. "Suggest another" swaps ONLY the metadata inside
      // these hosts — the sheet header, layout and footer actions never re-render.
      const posterHost = el('div', { class: 'dust-poster' });
      const titleEl = el('h3');
      const metaEl = el('div', { class: 'muted' });
      const top = el('div', { class: 'dust-result-top' }, [
        posterHost,
        el('div', { class: 'dust-info' }, [titleEl, metaEl]),
      ]);
      const descHost = el('div', { class: 'dust-result-desc' });
      body.append(top, descHost);

      function fill(r) {
        current = r;
        posterHost.innerHTML = '';
        mountPoster(posterHost, r.poster_url, r.title);
        titleEl.textContent = r.title || t('dust.untitled');
        const bits = [];
        if (r.year) bits.push(r.year);
        if (r.rating) bits.push(`★ ${r.rating}`);
        if (r.genres && r.genres.length) bits.push(r.genres.slice(0, 3).join(', '));
        metaEl.textContent = bits.join('  ·  ');
        descHost.innerHTML = '';
        descHost.append(
          r.overview
            ? el('div', { class: 'overview', text: r.overview })
            : el('div', { class: 'muted', text: t('dust.noDescription') })
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
      // Fetch a fresh pick and swap it in place — the spinning refresh glyph is the
      // only chrome that changes while it loads.
      async function suggestAnother() {
        if (againBtn.disabled) return;
        againBtn.disabled = true;
        againBtn.classList.add('is-loading');
        let res;
        try {
          res = await api.discover({
            type: state.type,
            genres: [...state.genres],
            mood: state.mood,
            duration: state.duration,
            minRating: state.minRating,
            era: state.era,
          });
        } catch (err) {
          toast(t('dust.error'), 'bad');
          return;
        } finally {
          againBtn.disabled = false;
          againBtn.classList.remove('is-loading');
        }
        if (!res || !res.result) {
          toast(t('dust.empty'), 'bad'); // nothing else matched — keep the current pick
          return;
        }
        fill(res.result);
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
