// Person page (/person/:id) — the favourite person, opened from The Wall. Built
// like the title detail page: a hero (their portrait, blurred into an ambient
// wash) with back / options overlay buttons, the portrait overlapping it beside
// the name. Then "you and them" (Home's stats box: titles in your library, seen,
// your average rating, career years), the biography, their best-known roles as
// backdrop cards with the character played, and the whole career as a
// year-marked timeline filterable to your library.
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
  poster,
  cachedImg,
  segmentedControl,
} from '../ui.js';
import { withBase } from '../basePath.js';
import { collapsibleText } from '../collapsibleText.js';
import { openPersonPicker } from '../pickers.js';
import { t, locale, fmtNumber } from '../i18n.js';

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

// One credit -> the card shape the page renders. `library` maps 'movie:123' to
// the viewer's own row (id, status, rating, favourite) so in-library credits
// deep-link to the real detail page and carry their badge.
function creditCard(c, library) {
  const type = c.media_type === 'tv' ? 'show' : 'movie';
  const key = `${type}:${c.id}`;
  const folder = type === 'movie' ? 'movies' : 'shows';
  return {
    key,
    type,
    tmdb_id: c.id,
    title: c.title || c.name || '',
    year: (c.release_date || c.first_air_date || '').slice(0, 4),
    date: c.release_date || c.first_air_date || '',
    // TMDB notes like "(voice)" or "(motion capture)" add noise to a one-liner.
    character: String(c.character || '').replace(/\s*\(.*?\)\s*/g, ' ').trim(),
    votes: c.vote_count || 0,
    vote: c.vote_average || 0,
    hasBackdrop: !!c.backdrop_path,
    inLib: library[key] || null,
    // Always a cache URL: /assets lazily fetches + stores any tmdb id, so credits
    // outside the library get their art cached too.
    poster_url: `/assets/${folder}/${c.id}/poster.webp`,
    backdrop_url: `/assets/${folder}/${c.id}/backdrop.webp`,
  };
}

// In the library -> the real detail page; otherwise the preview page, where it
// can be added.
function openCredit(c) {
  if (c.inLib) openDetail(`/detail/${c.inLib.id}`);
  else openDetail(`/preview/${c.type}/${c.tmdb_id}`);
}

// The viewer's status on any card: their rating, or "to watch".
function statusBadge(c) {
  if (!c.inLib) return null;
  if (c.inLib.rating) return el('div', { class: 'rating-badge person-badge', html: `★ ${c.inLib.rating}` });
  if (c.inLib.status === 'plan_to_watch') {
    return el('div', { class: 'person-badge person-badge--plan' }, [lucideIcon('calendar-plus', 'person-glyph')]);
  }
  return null;
}

// A plain poster rail (the "As director" row).
function posterRow(title, cards) {
  if (!cards.length) return null;
  const rail = el('div', { class: 'hscroll' });
  for (const c of cards) {
    const art = poster(c.poster_url, c.title);
    const badge = statusBadge(c);
    if (badge) art.append(badge);
    const card = el('button', { class: 'person-credit', type: 'button' }, [
      art,
      el('div', { class: 'person-credit-title', text: c.title }),
    ]);
    card.addEventListener('click', () => openCredit(c));
    rail.append(card);
  }
  return el('div', { class: 'person-section' }, [el('h3', { class: 'section-title', text: title }), rail]);
}

// Whole years since an ISO birthday, or null.
function ageFrom(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const now = new Date();
  const month = now.getMonth() + 1;
  let age = now.getFullYear() - Number(m[1]);
  if (month < Number(m[2]) || (month === Number(m[2]) && now.getDate() < Number(m[3]))) age -= 1;
  return age;
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

    // ?v busts the cache so a freshly uploaded photo shows immediately.
    const photoUrl = withBase(`/api/persons/${tmdbId}/photo?v=${Date.now()}`);

    // --- Hero: their own portrait, blown up, blurred and dimmed into an ambient
    // wash (always about them, whatever their roles look like), fading into the
    // page like the title hero. Back and options float on it.
    const heroImg = el('img', { class: 'person-hero-img', src: photoUrl, alt: '' });
    heroImg.addEventListener('error', () => heroImg.remove());
    const menuBtn = el('button', {
      class: 'icon-btn icon-btn--overlay',
      html: icons.more,
      'aria-label': t('common.more'),
    });
    menuBtn.addEventListener('click', openOptions);
    const hero = el('div', { class: 'detail-hero person-hero' }, [
      heroImg,
      el('div', { class: 'person-hero-btn person-hero-btn--left' }, [
        el('button', {
          class: 'icon-btn icon-btn--overlay',
          html: icons.back,
          'aria-label': t('common.back'),
          onClick: () => history.back(),
        }),
      ]),
      el('div', { class: 'person-hero-btn person-hero-btn--right' }, [menuBtn]),
    ]);

    // --- Head: the portrait overlapping the hero (Detail's poster head), the
    // name growing upward beside it.
    const photo = el('img', { src: photoUrl, alt: person.name || '' });
    photo.addEventListener('error', () => photo.replaceWith(el('div', { class: 'person-photo-empty' })));
    const metaRow = (icon, text) =>
      text
        ? el('div', { class: 'person-meta-row' }, [lucideIcon(icon, 'person-glyph person-meta-ico'), el('span', { text })])
        : null;
    const age = ageFrom(person.birthday);
    const born = [fmtDate(person.birthday), age != null ? t('person.age', { n: age }) : ''].filter(Boolean).join(' · ');
    const head = el('div', { class: 'detail-head person-head' }, [
      el('div', { class: 'person-photo' }, [photo]),
      el('div', { class: 'person-head-text' }, [
        el('div', { class: 'person-eyebrow' }, [
          el('span', { class: 'person-eyebrow-ico', html: icons.heart }),
          el('span', { text: t('person.favorite') }),
        ]),
        el('h2', { class: 'person-name', text: person.name || t('person.unknown') }),
        metaRow('cake', born),
        metaRow('earth', person.place_of_birth || ''),
      ]),
    ]);

    container.append(hero, head);

    // --- Credits: one entry per title (TMDB lists a title once per role).
    const library = person.library || {};
    const cast = (person.credits && person.credits.cast) || [];
    const crew = (person.credits && person.credits.crew) || [];
    const uniq = (list) => {
      const seen = new Set();
      return list
        .map((c) => creditCard(c, library))
        .filter((c) => c.title && !seen.has(c.key) && seen.add(c.key));
    };
    const acting = uniq(cast);
    const dated = acting.filter((c) => c.year);
    const inLib = dated.filter((c) => c.inLib);

    // --- You and them: Home's stats box, about this person. Career years count
    // from their first credit after birth (archive footage can predate it).
    if (acting.length) {
      const watched = inLib.filter((c) => c.inLib.status !== 'plan_to_watch');
      const rated = inLib.filter((c) => c.inLib.rating);
      const avg = rated.length ? rated.reduce((n, c) => n + c.inLib.rating, 0) / rated.length : null;
      const birthYear = Number(String(person.birthday || '').slice(0, 4)) || 0;
      const years = dated.map((c) => Number(c.year)).filter((y) => y >= birthYear);
      const since = years.length ? Math.min(...years) : null;
      const statCard = (icon, value, label) =>
        el('div', { class: 'stat-card' }, [
          lucideIcon(icon, 'stat-ico'),
          el('div', { class: 'stat-txt' }, [
            el('div', { class: 'value', text: value }),
            el('div', { class: 'label', text: label }),
          ]),
        ]);
      const firstName = (person.name || '').split(' ')[0];
      container.append(
        el('div', { class: 'section-title', text: t('person.youAnd', { name: firstName }) }),
        el('div', { class: 'stats-grid person-stats' }, [
          statCard('library-big', fmtNumber(inLib.length), t('person.statLibrary', { total: fmtNumber(acting.length) })),
          statCard('eye', fmtNumber(watched.length), t('person.statSeen')),
          statCard(
            'star',
            avg ? avg.toLocaleString(locale(), { maximumFractionDigits: 1 }) : '–',
            t('person.statRating')
          ),
          statCard(
            'clapperboard',
            since ? fmtNumber(new Date().getFullYear() - since) : '–',
            since ? t('person.statCareer', { year: since }) : t('person.statCareerShort')
          ),
        ])
      );
    }

    // --- Biography (shared collapsible with the title detail page) ---
    if (person.biography) {
      container.append(
        el('div', { class: 'section-title', text: t('person.biography') }),
        ...collapsibleText(person.biography)
      );
    }

    // --- Best-known roles: wide backdrop cards with the character played.
    const known = acting
      .filter((c) => c.hasBackdrop)
      .sort((a, b) => b.votes - a.votes)
      .slice(0, 10);
    if (known.length) {
      const rail = el('div', { class: 'hscroll person-known' });
      for (const c of known) {
        const art = el('div', { class: 'person-role-art' }, [cachedImg(c.backdrop_url, { alt: '' }), statusBadge(c)]);
        const card = el('button', { class: 'person-role', type: 'button' }, [
          art,
          el('div', { class: 'person-role-title', text: c.title }),
          el('div', {
            class: 'person-role-sub',
            text: [c.character ? t('person.asCharacter', { name: c.character }) : '', c.year].filter(Boolean).join(' · '),
          }),
        ]);
        card.addEventListener('click', () => openCredit(c));
        rail.append(card);
      }
      container.append(el('div', { class: 'section-title', text: t('person.knownFor') }), rail);
    }

    // --- Career: a horizontal timeline, newest first, a year marker over each
    // year's titles on one continuous line; filter All / In your library.
    if (dated.length) {
      const timeline = el('div', { class: 'hscroll person-timeline' });
      const paintTimeline = (onlyLib) => {
        const list = (onlyLib ? inLib : dated).slice().sort((a, b) => b.date.localeCompare(a.date));
        const groups = new Map();
        for (const c of list) {
          if (!groups.has(c.year)) groups.set(c.year, []);
          groups.get(c.year).push(c);
        }
        timeline.replaceChildren(
          ...[...groups].map(([year, cards]) =>
            el('div', { class: 'person-year' }, [
              el('div', { class: 'person-year-mark' }, [el('span', { class: 'person-year-label', text: year })]),
              el(
                'div',
                { class: 'person-year-items' },
                cards.map((c) => {
                  const art = poster(c.poster_url, c.title);
                  const badge = statusBadge(c);
                  if (badge) art.append(badge);
                  const card = el('button', { class: 'person-credit', type: 'button' }, [
                    art,
                    el('div', { class: 'person-credit-title', text: c.title }),
                    el('div', { class: 'person-credit-sub', text: c.character }),
                  ]);
                  card.addEventListener('click', () => openCredit(c));
                  return card;
                })
              ),
            ])
          )
        );
        timeline.scrollLeft = 0;
      };
      const filter = segmentedControl({
        options: [
          ['all', t('person.filterAll'), 'layers'],
          ['lib', t('person.filterLibrary'), 'library-big'],
        ],
        value: 'all',
        ariaLabel: t('person.career'),
        onChange: (v) => paintTimeline(v === 'lib'),
      });
      paintTimeline(false);
      container.append(
        el('div', { class: 'person-career-head' }, [
          el('div', { class: 'section-title', text: t('person.career') }),
          filter.el,
        ]),
        timeline
      );
    }

    // Directing credits keep their own rail, in-library first.
    const directed = uniq(crew.filter((c) => c.job === 'Director'));
    if (directed.length) {
      const dIn = directed.filter((c) => c.inLib);
      const dOut = directed
        .filter((c) => !c.inLib)
        .sort((a, b) => b.vote - a.vote)
        .slice(0, 20);
      container.append(posterRow(t('person.asDirector'), [...dIn, ...dOut]));
    }

    if (!acting.length && !directed.length) {
      container.append(
        stateBlock({
          icon: 'clapperboard',
          title: t('person.emptyTitle'),
          detail: t('person.emptyDetail'),
        })
      );
    }

    // TMDB link — same button as the title detail page.
    const tmdbBtn = el('button', {
      class: 'toggle-wide tmdb-toggle active person-tmdb',
      type: 'button',
      'aria-label': t('person.tmdbAria'),
    });
    tmdbBtn.innerHTML =
      `<img class="tmdb-logo-img" src="${withBase('/icons/tmdb/tmdb-logo.svg')}" alt="" aria-hidden="true"><span>${t('person.tmdbButton')}</span>`;
    tmdbBtn.addEventListener('click', () => openExternal(`${TMDB_PERSON}${tmdbId}`));
    container.append(tmdbBtn);
  }

  // Skeleton → content (and every later repaint, e.g. after a photo change)
  // dissolves instead of hard-cutting, matching every other view in the app.
  function render() {
    crossfadeSwap(paint);
  }

  render();
}

export default Person;
