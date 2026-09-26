// Person page (/person/:id) — a full-page view for one person, opened from The
// Wall. Mirrors the title detail page's structure: hero photo + name, an options
// menu in the top-right, a collapsible biography, and horizontally scrolling
// poster rows for the filmography.
//
// Everything renders from OUR cache: person data comes from /api/persons/:id
// (which fetches from TMDB server-side and stores it), and the photo from
// /api/persons/:id/photo. The client never talks to TMDB or its CDN.

import { api, createApi, isAbortError } from '../api.js';
import { navigate, openDetail, onCleanup } from '../router.js';
import {
  el,
  spinner,
  toast,
  openModal,
  icons,
  crossfadeSwap,
  lucideIcon,
  stateBlock,
} from '../ui.js';
import { withBase } from '../basePath.js';
import { collapsibleText } from '../collapsibleText.js';
import { openPersonPicker } from '../pickers.js';
import { t, locale } from '../i18n.js';

const TMDB_PERSON = 'https://www.themoviedb.org/person/';

// Open an external URL in a new tab. An installed PWA (navigator.standalone)
// can swallow window.open, so route through a temporary anchor there — same
// behaviour as the title detail page's TMDB button.
function openExternal(url) {
  if (typeof navigator !== 'undefined' && navigator.standalone === true) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}


// '1963-12-18' -> '18 December 1963'; '' when absent/unparsable.
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' });
}

// One credit -> the card shape the rows render. `library` maps 'movie:123' to the
// local item so in-library credits deep-link to the real detail page.
function creditCard(c, library) {
  const type = c.media_type === 'tv' ? 'show' : 'movie';
  const key = `${type}:${c.id}`;
  const inLib = library[key] || null;
  const folder = type === 'movie' ? 'movies' : 'shows';
  return {
    key,
    type,
    tmdb_id: c.id,
    title: c.title || c.name || '',
    vote: c.vote_average || 0,
    inLib,
    // Always a cache URL: /assets lazily fetches + stores any tmdb id, so "Also
    // known for" posters get cached too, not just library titles.
    poster_url: `/assets/${folder}/${c.id}/poster.webp`,
  };
}

function posterRow(title, cards) {
  if (!cards.length) return null;
  const rail = el('div', { class: 'hscroll' });
  for (const c of cards) {
    const art = c.poster_url
      ? el('img', { class: 'person-credit-img', src: withBase(c.poster_url), alt: c.title, loading: 'lazy' })
      : el('div', { class: 'person-credit-fallback', text: c.title });
    const card = el('button', { class: 'person-credit', type: 'button' }, [
      el('div', { class: 'poster-card person-credit-art' }, [art]),
      el('div', { class: 'person-credit-title', text: c.title }),
    ]);
    card.addEventListener('click', () => {
      // In the library -> the real detail page; otherwise the preview page, where
      // it can be added.
      if (c.inLib) openDetail(`/detail/${c.inLib.id}`);
      else openDetail(`/preview/${c.type}/${c.tmdb_id}`);
    });
    rail.append(card);
  }
  return el('div', { class: 'person-section' }, [
    el('h3', { class: 'section-title', text: title }),
    rail,
  ]);
}

export async function Person(container, params) {
  const ac = new AbortController();
  const loadApi = createApi(ac.signal);
  onCleanup(() => ac.abort());

  const tmdbId = params.id;
  container.append(spinner());

  let person;
  try {
    person = await loadApi.person(tmdbId);
  } catch (err) {
    if (isAbortError(err)) return;
    container.innerHTML = '';
    container.append(
      stateBlock({
        kind: 'error',
        icon: 'user-round',
        title: t('person.loadError'),
        error: err.message,
        action: { onClick: () => navigate(location.pathname + location.search, { replace: true }) },
      })
    );
    return;
  }

  // Hidden input drives the "Change photo" flow (same approach as the profile
  // photo picker on Home).
  const fileInput = el('input', { type: 'file', accept: 'image/*' });
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast(t('person.imageTooLarge'), 'bad');
      return;
    }
    try {
      await api.uploadPersonPhoto(tmdbId, file);
      toast(t('person.photoUpdated'), 'ok');
      render();
    } catch (err) {
      toast(err.message || t('person.uploadFailed'), 'bad');
    }
  });

  function openOptions() {
    openModal((modal, close) => {
      const actions = [
        {
          icon: 'image',
          label: t('person.changePhoto'),
          onClick: (_c, cl) => {
            cl();
            fileInput.click();
          },
        },
        {
          icon: 'users',
          label: t('person.changePerson'),
          onClick: (_c, cl) => {
            cl();
            openPersonPicker({
              onPick: async (p) => {
                try {
                  await api.setFavoritePerson(p.tmdb_id);
                  navigate(`/person/${p.tmdb_id}`);
                } catch (err) {
                  toast(err.message || t('person.changeFailed'), 'bad');
                }
              },
            });
          },
        },
        {
          icon: 'trash-2',
          label: t('person.removePerson'),
          danger: true,
          onClick: async (_c, cl) => {
            try {
              await api.setFavoritePerson(null);
              cl();
              toast(t('person.removed'), 'ok');
              navigate('/');
            } catch (err) {
              toast(err.message || t('person.removeFailed'), 'bad');
            }
          },
        },
      ];
      const grid = el('div', { class: 'status-bento menu-bento' });
      actions.forEach((a) => {
        const cell = el('button', { class: 'status-cell' + (a.danger ? ' danger' : '') }, [
          lucideIcon(a.icon, 'status-ico'),
          el('span', { class: 'status-cell-label', text: a.label }),
        ]);
        cell.addEventListener('click', () => a.onClick(cell, close));
        grid.append(cell);
      });
      // Odd count -> the last cell spans the full width (same rule as Detail).
      if (actions.length % 2 === 1) grid.lastChild.classList.add('full');
      modal.append(
        el('h3', { text: person.name || t('person.fallbackName') }),
        grid,
        el('hr', { class: 'status-sep' }),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.cancel') }),
    ]),
        ])
      );
    });
  }

  function paint() {
    container.innerHTML = '';
    container.append(fileInput);

    // --- Header: photo, name, birth info, options button ---
    const photo = el('img', {
      class: 'person-photo',
      // ?v busts the cache so a freshly uploaded photo shows immediately
      src: withBase(`/api/persons/${tmdbId}/photo?v=${Date.now()}`),
      alt: person.name || '',
    });
    photo.addEventListener('error', () =>
      photo.replaceWith(el('div', { class: 'person-photo person-photo--empty' }))
    );

    // Birth date / place as icon+label rows (same language as the title page's
    // metadata rows).
    const infoRow = (icon, text) =>
      text
        ? el('div', { class: 'person-meta-row' }, [
            lucideIcon(icon, 'person-meta-ico'),
            el('span', { text }),
          ])
        : null;
    const born = fmtDate(person.birthday);
    const menuBtn = el('button', {
      class: 'icon-btn person-menu-btn icon-btn--overlay',
      html: icons.more,
      'aria-label': t('common.more'),
    });
    menuBtn.addEventListener('click', openOptions);

    // Back to wherever we came from (Home / The Wall) — same chrome as the other
    // full-page views (Season, Settings, …).
    container.append(
      el('div', { class: 'person-back-row' }, [
        el('button', {
          class: 'icon-btn',
          html: icons.back,
          'aria-label': t('common.back'),
          onClick: () => history.back(),
        }),
      ])
    );

    container.append(
      el('div', { class: 'person-head' }, [
        photo,
        // Bottom-anchored: the name grows UPWARD from the photo's bottom edge,
        // exactly like the title detail head.
        el('div', { class: 'person-head-text' }, [
          el('h2', { class: 'person-name', text: person.name || t('person.unknown') }),
          infoRow('cake', born),
          infoRow('earth', person.place_of_birth || ''),
        ]),
        menuBtn,
      ])
    );

    // --- Biography (shared collapsible with the title detail page) ---
    if (person.biography) container.append(...collapsibleText(person.biography));

    // TMDB link — same button as the title detail page (a real button in the
    // page, not an options-menu row).
    const tmdbBtn = el('button', {
      class: 'toggle-wide tmdb-toggle active',
      type: 'button',
      'aria-label': t('person.tmdbAria'),
    });
    tmdbBtn.innerHTML =
      `<img class="tmdb-logo-img" src="${withBase('/icons/tmdb/tmdb-logo.svg')}" alt="" aria-hidden="true"><span>${t('person.tmdbButton')}</span>`;
    tmdbBtn.addEventListener('click', () => openExternal(`${TMDB_PERSON}${tmdbId}`));
    container.append(tmdbBtn);

    // --- Filmography ---
    const library = person.library || {};
    const cast = (person.credits && person.credits.cast) || [];
    const crew = (person.credits && person.credits.crew) || [];

    // De-dupe: a title can appear several times across cast/crew.
    const seen = new Set();
    const uniq = (list) =>
      list
        .map((c) => creditCard(c, library))
        .filter((c) => c.title && !seen.has(c.key) && seen.add(c.key));

    const acting = uniq(cast);
    const inLibrary = acting.filter((c) => c.inLib);
    const notInLibrary = acting
      .filter((c) => !c.inLib)
      .sort((a, b) => b.vote - a.vote)
      .slice(0, 20);

    const rows = [
      posterRow(t('person.inLibrary'), inLibrary),
      posterRow(t('person.alsoKnownFor'), notInLibrary),
    ];

    // Directing credits get their own row, same in/out-of-library split.
    const directed = uniq(crew.filter((c) => c.job === 'Director'));
    if (directed.length) {
      const dIn = directed.filter((c) => c.inLib);
      const dOut = directed
        .filter((c) => !c.inLib)
        .sort((a, b) => b.vote - a.vote)
        .slice(0, 20);
      rows.push(posterRow(t('person.asDirector'),[...dIn, ...dOut]));
    }

    const built = rows.filter(Boolean);
    built.forEach((r) => container.append(r));
    if (!built.length) {
      container.append(
        stateBlock({
          icon: 'clapperboard',
          title: t('person.emptyTitle'),
          detail: t('person.emptyDetail'),
        })
      );
    }
  }

  // Skeleton → content (and every later repaint, e.g. after a photo change)
  // dissolves instead of hard-cutting, matching every other view in the app.
  function render() {
    crossfadeSwap(paint);
  }

  render();
}

export default Person;
