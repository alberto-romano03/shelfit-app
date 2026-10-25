// Custom list screen (/list/:id): built like a Collection page. A hero with the
// newest title's backdrop and the list's name, a one-line summary (titles, owned
// on disc, seen in cinema), then the standard 3-column poster grid with the
// library grid's rating badge and small status glyphs. Rename and delete sit on
// the hero as overlay buttons. Tapping a poster opens the title's detail when it
// is in the library.

import { createApi, isAbortError } from '../api.js';
import { navigate, openDetail, onCleanup } from '../router.js';
import {
  el,
  icons,
  poster,
  skelGrid,
  skelLine,
  toast,
  openModal,
  crossfadeSwap,
  clear,
  stateBlock,
  lucideIcon,
} from '../ui.js';
import { imageCache } from '../imageCache.js';
import { isServerReachable, markDegraded } from '../network.js';
import { t } from '../i18n.js';

// Round overlay button for the hero (white glyph on a dark scrim in both themes).
function overlayBtn(html, label, onClick) {
  return el('button', { class: 'icon-btn icon-btn--overlay', html, 'aria-label': label, onClick });
}

// Paint the hero from the first artwork that loads: each title's backdrop
// (newest first), then their posters. A backdrop can be missing from the cache;
// imageCache.load resolves to the URL even on a 404, so the <img> error event
// steps to the next source. With nothing left the hero keeps its plain fill.
function paintHero(img, items) {
  const sources = [...items.map((it) => it.backdrop_url), ...items.map((it) => it.poster_url)].filter(Boolean);
  let i = 0;
  const attempt = () => {
    if (i >= sources.length) {
      img.remove();
      return;
    }
    const url = sources[i++];
    imageCache
      .load(url)
      .then((src) => {
        img.src = src || url;
      })
      .catch(attempt);
  };
  img.addEventListener('error', attempt);
  attempt();
}

// One status glyph on a poster: owned on disc, or seen in cinema (accent).
function statusFlag(icon, label, mod = '') {
  return el('span', { class: `list-flag ${mod}`, title: label, 'aria-label': label }, [
    lucideIcon(icon, 'list-flag-ico'),
  ]);
}

function buildCell(it) {
  const card = poster(it.poster_url, it.title);
  if (it.rating) card.append(el('div', { class: 'rating-badge', html: `★ ${it.rating}` }));
  const flags = [];
  if (it.owned) flags.push(statusFlag('disc', t('lists.ownedOnDisc')));
  if (it.watched_in_cinema) flags.push(statusFlag('ticket', t('lists.watchedInCinema'), 'list-flag--cine'));
  if (flags.length) card.append(el('div', { class: 'list-flags' }, flags));
  const genre = Array.isArray(it.genres) ? it.genres[0] : null;
  const cell = el('div', { class: 'list-cell' }, [
    card,
    el('div', { class: 'list-cell-title', text: it.title || `#${it.tmdb_id}` }),
    el('div', { class: 'list-cell-sub', text: [it.year, genre].filter(Boolean).join(' · ') }),
  ]);
  cell.addEventListener('click', () => {
    if (it.item_id) openDetail(`/detail/${it.item_id}`);
    else toast(t('lists.notInLibrary'));
  });
  return cell;
}

export default async function List(container, params) {
  const ac = new AbortController();
  onCleanup(() => ac.abort());
  const api = createApi(ac.signal);

  // Hero chrome is live from the first frame (back works while loading); the
  // artwork, eyebrow and name fill in once the list arrives.
  const heroImg = el('img', { class: 'list-hero-img', alt: '' });
  const eyebrow = el('div', { class: 'list-eyebrow' }, [skelLine({ width: '90px', height: '11px', margin: '0' })]);
  const title = el('h2', { class: 'list-hero-name' }, [skelLine({ width: '180px', height: '24px', margin: '0' })]);
  const editBtn = overlayBtn(icons.pencil, t('lists.rename'));
  const delBtn = overlayBtn(icons.trash2, t('lists.delete'));
  const hero = el('div', { class: 'detail-hero list-hero' }, [
    heroImg,
    el('div', { class: 'list-hero-back' }, [overlayBtn(icons.back, t('common.back'), () => history.back())]),
    el('div', { class: 'list-hero-actions' }, [editBtn, delBtn]),
    el('div', { class: 'list-hero-title' }, [eyebrow, title]),
  ]);
  const summary = el('div', { class: 'list-summary' }, [skelLine({ width: '160px', margin: '0' })]);
  const body = el('div', {}, [skelGrid(9)]);
  container.append(hero, summary, body);

  let data;
  try {
    data = await api.listItems(params.id);
  } catch (err) {
    if (isAbortError(err)) return;
    if (!isServerReachable()) {
      // Server unreachable (transport failure OR a 5xx from the reverse proxy
      // while the backend is down) → keep the ghost frame; recovery re-fetches.
      // A 4xx keeps the server reachable → real error below.
      markDegraded();
      return;
    }
    clear(container);
    container.append(
      stateBlock({
        kind: 'error',
        title: t('lists.loadError'),
        error: err.message,
        action: { onClick: () => navigate(location.pathname + location.search, { replace: true }) },
      })
    );
    return;
  }

  const items = data.items || [];
  const isMovie = data.type === 'movie';
  paintHero(heroImg, items);
  eyebrow.replaceChildren(
    el('span', { class: 'list-eyebrow-ico', html: isMovie ? icons.navMovies : icons.navSeries }),
    el('span', { text: isMovie ? t('lists.eyebrowMovies') : t('lists.eyebrowShows') })
  );
  title.textContent = data.name;

  // Titles, then disc / cinema tallies only when there are any.
  const owned = items.filter((it) => it.owned).length;
  const cinema = items.filter((it) => it.watched_in_cinema).length;
  const stat = (icon, text) =>
    el('span', { class: 'list-stat' }, [icon ? lucideIcon(icon, 'list-stat-ico') : null, el('span', { text })]);
  const stats = [stat(null, t('lists.titles', { n: items.length }))];
  if (owned) stats.push(stat('disc', t('lists.onDisc', { n: owned })));
  if (cinema) stats.push(stat('ticket', t('lists.inCinema', { n: cinema })));
  summary.replaceChildren(...stats);

  editBtn.addEventListener('click', () => {
    openModal((modal, close) => {
      const input = el('input', { class: 'text-field', type: 'text', value: data.name });
      const save = el('button', { class: 'btn btn-primary' }, [
        lucideIcon('check', 'btn-lucide'),
        el('span', { text: t('common.save') }),
      ]);
      save.addEventListener('click', async () => {
        const name = input.value.trim();
        if (!name) return;
        save.disabled = true;
        try {
          await api.renameList(params.id, name);
          data.name = name;
          title.textContent = name;
          close();
          toast(t('lists.renamed'), 'ok');
        } catch (err) {
          save.disabled = false;
          toast(err.message || t('lists.failed'), 'bad');
        }
      });
      modal.append(
        el('h3', { text: t('lists.rename') }),
        input,
        el('hr', { class: 'status-sep' }),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-secondary', onClick: close }, [
            lucideIcon('x', 'btn-lucide'),
            el('span', { text: t('common.cancel') }),
          ]),
          save,
        ])
      );
    });
  });
  delBtn.addEventListener('click', async () => {
    if (!confirm(t('lists.confirmDelete', { name: data.name }))) return;
    try {
      await api.deleteList(params.id);
      toast(t('lists.deleted'), 'ok');
      navigate('/');
    } catch (err) {
      toast(err.message || t('lists.failed'), 'bad');
    }
  });

  const content = items.length
    ? [
        el('div', { class: 'section-title', text: isMovie ? t('nav.movies') : t('nav.series') }),
        el('div', { class: 'grid' }, items.map(buildCell)),
      ]
    : [stateBlock({ icon: 'library-big', title: t('lists.empty'), detail: t('lists.emptyDetail') })];
  crossfadeSwap(() => body.replaceChildren(...content));
}
