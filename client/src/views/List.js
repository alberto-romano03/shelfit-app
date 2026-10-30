// Custom list screen (/list/:id): built like a Collection page. A hero with the
// newest title's backdrop and the list's name, a one-line summary (titles, owned
// on disc, seen in cinema), then the standard 3-column poster grid with the
// library grid's rating badge and small status glyphs. Rename and delete sit on
// the hero as overlay buttons. Tapping a poster opens the title's detail when it
// is in the library.
//
// Opening a list from a card is quick: the card hands over what it already
// shows (name, type, count) so the header paints at once, and the list starts
// loading the moment the card is pressed (prefetchList), with its hero
// backdrop warmed as soon as the list arrives. Each list opened is kept for the
// session: coming back to it (from a title, or Back) paints it at once, where
// it was left. A library change marks it stale; it still paints, then refreshes
// in place once the page has faded in.

import { api as sharedApi, createApi, isAbortError } from '../api.js';
import { navigate, openDetail, onCleanup, cameBack, afterTransition } from '../router.js';
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
// It fades in once loaded (.is-in); one already in memory (coming back to the
// list) goes up at once, with no fade.
function paintHero(img, items) {
  const sources = [...items.map((it) => it.backdrop_url), ...items.map((it) => it.poster_url)].filter(Boolean);
  let i = 0;
  const attempt = () => {
    if (i >= sources.length) {
      img.removeAttribute('src');
      return;
    }
    const url = sources[i++];
    const hit = imageCache.get(url);
    if (hit) {
      img.classList.add('instant', 'is-in');
      img.src = hit;
      return;
    }
    imageCache
      .load(url)
      .then((src) => {
        img.src = src || url;
      })
      .catch(attempt);
  };
  img.onerror = attempt; // one handler, whichever paint set it
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

// --- Session copies, card hints and prefetch ---------------------------------
const pageCache = new Map(); // id -> { data, stale, scrollY }
const PAGE_CACHE_MAX = 12;
const hints = new Map(); // id -> { name, type, count } from the card that opened it
const pending = new Map(); // id -> Promise of the list (started on the card's press)
window.addEventListener('shelfit:library-changed', () => {
  for (const e of pageCache.values()) e.stale = true;
  pending.clear();
});

function remember(id, data) {
  const prev = pageCache.get(id);
  pageCache.delete(id);
  pageCache.set(id, { data, stale: false, scrollY: prev ? prev.scrollY : 0 });
  while (pageCache.size > PAGE_CACHE_MAX) pageCache.delete(pageCache.keys().next().value);
}

// Start loading a list (once), and warm its hero backdrop as soon as it lands.
export function prefetchList(id) {
  id = String(id);
  if (pending.has(id)) return pending.get(id);
  const saved = pageCache.get(id);
  if (saved && !saved.stale) return Promise.resolve(saved.data);
  const p = sharedApi.listItems(id).then((data) => {
    const first = (data.items || []).find((it) => it.backdrop_url || it.poster_url);
    if (first) imageCache.preload([first.backdrop_url || first.poster_url]);
    return data;
  });
  p.catch(() => pending.delete(id)); // a failed prefetch must not stick
  pending.set(id, p);
  return p;
}

// Open a list from a card that shows it: pass what the card knows so the
// header paints before the list arrives.
export function openList(l) {
  const id = String(l.id);
  hints.set(id, { name: l.name, type: l.type, count: l.count });
  prefetchList(id);
  navigate(`/list/${id}`);
}

// A card that opens a list: loading starts when it is pressed, not released.
// Not while My Lists is in edit mode, where tapping a row does nothing.
export function wireListCard(card, l) {
  const editing = () => !!card.closest('.is-editing');
  card.addEventListener('pointerdown', () => editing() || prefetchList(l.id), { passive: true });
  card.addEventListener('click', () => editing() || openList(l));
}

export default async function List(container, params) {
  const id = String(params.id);
  const ac = new AbortController();
  const api = createApi(ac.signal);
  onCleanup(() => {
    ac.abort();
    const e = pageCache.get(id);
    if (e) e.scrollY = window.scrollY; // where to return to
  });

  const saved = pageCache.get(id);
  const hint = hints.get(id);
  hints.delete(id);
  let data = saved ? saved.data : null;
  let shownHero = null; // the hero artwork on screen

  // Hero chrome is live from the first frame (back works while loading); the
  // artwork, eyebrow and name fill in from the list, or at once from a saved
  // copy or the card's hint.
  const heroImg = el('img', { class: 'list-hero-img', alt: '' });
  heroImg.addEventListener('load', () => heroImg.classList.add('is-in'));
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
  // The shimmer holds as many posters as the list has (up to three rows), so
  // nothing jumps when they arrive.
  const skeletonCount = hint ? Math.min(Math.max(hint.count || 0, 1), 9) : 9;
  const body = el('div', {}, [skelGrid(skeletonCount)]);
  container.append(hero, summary, body);

  function paintEyebrow(type) {
    const isMovie = type === 'movie';
    eyebrow.replaceChildren(
      el('span', { class: 'list-eyebrow-ico', html: isMovie ? icons.navMovies : icons.navSeries }),
      el('span', { text: isMovie ? t('lists.eyebrowMovies') : t('lists.eyebrowShows') })
    );
  }
  const stat = (icon, text) =>
    el('span', { class: 'list-stat' }, [icon ? lucideIcon(icon, 'list-stat-ico') : null, el('span', { text })]);

  // Everything that comes from the list itself. `fade`: crossfade the grid in
  // (first load); a saved copy or an in-place refresh swaps it directly.
  function paint(d, { fade = false } = {}) {
    data = d;
    const items = d.items || [];
    const isMovie = d.type === 'movie';
    // The hero only changes when its artwork does (a refresh keeps it still).
    const heroKey = items.map((it) => it.backdrop_url || it.poster_url).find(Boolean) || '';
    if (heroKey !== shownHero) {
      shownHero = heroKey;
      heroImg.classList.remove('is-in', 'instant');
      heroImg.removeAttribute('src');
      paintHero(heroImg, items);
    }
    paintEyebrow(d.type);
    title.textContent = d.name;
    // Titles, then disc / cinema tallies only when there are any.
    const owned = items.filter((it) => it.owned).length;
    const cinema = items.filter((it) => it.watched_in_cinema).length;
    const stats = [stat(null, t('lists.titles', { n: items.length }))];
    if (owned) stats.push(stat('disc', t('lists.onDisc', { n: owned })));
    if (cinema) stats.push(stat('ticket', t('lists.inCinema', { n: cinema })));
    summary.replaceChildren(...stats);
    const content = items.length
      ? [
          el('div', { class: 'section-title', text: isMovie ? t('nav.movies') : t('nav.series') }),
          el('div', { class: 'grid' }, items.map(buildCell)),
        ]
      : [stateBlock({ icon: 'library-big', title: t('lists.empty'), detail: t('lists.emptyDetail') })];
    if (fade) crossfadeSwap(() => body.replaceChildren(...content));
    else body.replaceChildren(...content);
  }

  editBtn.addEventListener('click', () => {
    if (!data) return;
    openModal((modal, close) => {
      const input = el('input', { class: 'text-field', type: 'text', value: data.name, maxlength: '40' });
      const save = el('button', { class: 'btn btn-primary' }, [
        lucideIcon('check', 'btn-lucide'),
        el('span', { text: t('common.save') }),
      ]);
      save.addEventListener('click', async () => {
        const name = input.value.trim();
        if (!name) return;
        save.disabled = true;
        try {
          await api.renameList(id, name);
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
    if (!data) return;
    if (!confirm(t('lists.confirmDelete', { name: data.name }))) return;
    try {
      await api.deleteList(id);
      pageCache.delete(id);
      toast(t('lists.deleted'), 'ok');
      navigate('/');
    } catch (err) {
      toast(err.message || t('lists.failed'), 'bad');
    }
  });

  // A saved copy: paint it now, where it was left when coming back, and check
  // a stale one once the page has faded in.
  if (saved) {
    paint(saved.data);
    if (cameBack()) {
      const y = saved.scrollY || 0;
      window.scrollTo(0, y);
      requestAnimationFrame(() => window.scrollTo(0, y));
    }
    if (saved.stale) {
      await afterTransition();
      if (ac.signal.aborted) return;
      let fresh;
      try {
        fresh = await api.listItems(id);
      } catch {
        return; // the saved copy stays on screen
      }
      remember(id, fresh);
      if (JSON.stringify(fresh) === JSON.stringify(saved.data)) return;
      const y = window.scrollY;
      paint(fresh);
      window.scrollTo(0, y);
    }
    return;
  }

  // First visit: what the card showed paints the header straight away.
  if (hint) {
    paintEyebrow(hint.type);
    title.textContent = hint.name;
    summary.replaceChildren(stat(null, t('lists.titles', { n: hint.count || 0 })));
  }

  let fresh;
  try {
    fresh = await (pending.get(id) || api.listItems(id));
  } catch (err) {
    pending.delete(id);
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
  pending.delete(id);
  if (ac.signal.aborted) return; // left while it loaded
  remember(id, fresh);
  paint(fresh, { fade: true });
}
