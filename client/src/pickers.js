// Small "choose a thing" modals shared by The Wall and the Person page.
//
// The title picker searches the LIBRARY, not TMDB: a Wall pick is stored as an
// items(id) reference, so only titles you already own can be chosen (the server
// 404s otherwise). The list is fetched once and filtered in memory — instant,
// and it keeps working offline.
//
// The person picker does hit TMDB (through our own /api/persons/search), since
// people aren't in the library at all.

import { api } from './api.js';
import { el, openModal, spinner, stateBlock, poster, lucideIcon } from './ui.js';
import { withBase } from './basePath.js';
import { t } from './i18n.js';

// Debounce that also cancels on close.
function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

// --- Title picker (library only) -------------------------------------------
// type: 'movie' | 'show'. onPick receives the chosen item row.
export function openTitlePicker({ type, title, onPick }) {
  openModal((modal, close) => {
    const input = el('input', {
      class: 'search-input',
      type: 'search',
      placeholder: type === 'movie' ? t('pickers.searchFilms') : t('pickers.searchSeries'),
    });
    const list = el('div', { class: 'picker-list' });
    modal.append(
      el('h3', { text: title || (type === 'movie' ? t('pickers.chooseFilm') : t('pickers.chooseSeries')) }),
      input,
      list,
      el('hr', { class: 'status-sep' }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.cancel') }),
    ]),
      ])
    );
    list.append(spinner());

    let all = [];
    const render = (q) => {
      const needle = q.trim().toLowerCase();
      const rows = (needle ? all.filter((r) => (r.title || '').toLowerCase().includes(needle)) : all).slice(0, 60);
      list.innerHTML = '';
      if (!rows.length) {
        list.append(
          stateBlock({
            tier: 'section',
            icon: 'shelving-unit',
            title: needle
              ? t('pickers.noMatch')
              : t('pickers.libraryEmpty'),
          })
        );
        return;
      }
      for (const r of rows) {
        const row = el('button', { class: 'picker-row', type: 'button' }, [
          el('img', { class: 'picker-thumb', src: withBase(r.poster_url), alt: '', loading: 'lazy' }),
          el('span', { class: 'picker-name' }, [
            el('span', { class: 'picker-title', text: r.title }),
            r.year ? el('span', { class: 'picker-year', text: String(r.year) }) : null,
          ]),
        ]);
        row.addEventListener('click', () => {
          close();
          onPick(r);
        });
        list.append(row);
      }
    };

    // One paginated sweep of the library for this type (pageSize is generous so
    // it's a single request for any realistic library).
    api
      .mediaPage(type, { status: 'all', page: 1, pageSize: 500 })
      .then((res) => {
        const folder = type === 'movie' ? 'movies' : 'shows';
        all = (res.items || []).map((it) => ({
          id: it.id,
          tmdb_id: it.tmdb_id,
          title: it.title_it || it.title || '',
          year: it.year || null,
          poster_url: it.poster_url || `/assets/${folder}/${it.tmdb_id}/poster.webp`,
        }));
        render(input.value);
      })
      .catch(() => {
        list.innerHTML = '';
        list.append(
          stateBlock({
            kind: 'error',
            tier: 'section',
            title: t('pickers.loadError'),
          })
        );
      });

    const onType = debounce(() => render(input.value), 120);
    input.addEventListener('input', onType);
    setTimeout(() => input.focus(), 50);
  });
}

// --- Person picker (TMDB search via our own endpoint) ----------------------
export function openPersonPicker({ onPick }) {
  openModal((modal, close) => {
    const input = el('input', {
      class: 'search-input',
      type: 'search',
      placeholder: t('pickers.searchPeople'),
    });
    const list = el('div', { class: 'picker-list' });
    modal.append(
      el('h3', { text: t('pickers.choosePerson') }),
      input,
      list,
      el('hr', { class: 'status-sep' }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.cancel') }),
    ]),
      ])
    );
    list.append(
      stateBlock({ tier: 'section', icon: 'user-round', title: t('pickers.typeName') })
    );

    let seq = 0;
    const run = async (q) => {
      const mine = ++seq;
      if (!q.trim()) {
        list.innerHTML = '';
        list.append(
          stateBlock({
            tier: 'section',
            icon: 'user-round',
            title: t('pickers.typeName'),
          })
        );
        return;
      }
      list.innerHTML = '';
      list.append(spinner());
      try {
        const res = await api.get(`/api/persons/search?q=${encodeURIComponent(q.trim())}`);
        if (mine !== seq) return; // a newer keystroke won
        list.innerHTML = '';
        const rows = res.results || [];
        if (!rows.length) {
          list.append(
            stateBlock({ tier: 'section', icon: 'user-round', title: t('pickers.noOne') })
          );
          return;
        }
        for (const p of rows) {
          const row = el('button', { class: 'picker-row', type: 'button' }, [
            el('span', { class: 'picker-thumb picker-thumb--person' }),
            el('span', { class: 'picker-name' }, [
              el('span', { class: 'picker-title', text: p.name }),
              p.known_for ? el('span', { class: 'picker-year', text: p.known_for }) : null,
            ]),
          ]);
          row.addEventListener('click', () => {
            close();
            onPick(p);
          });
          list.append(row);
        }
      } catch {
        if (mine !== seq) return;
        list.innerHTML = '';
        list.append(
          stateBlock({
            kind: 'error',
            tier: 'section',
            title: t('search.searchError'),
          })
        );
      }
    };
    const onType = debounce(() => run(input.value), 400);
    input.addEventListener('input', onType);
    setTimeout(() => input.focus(), 50);
  });
}
