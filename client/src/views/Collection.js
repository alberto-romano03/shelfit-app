// Collection detail screen (/collection/:id) — a TMDB movie collection shown as
// a hero, an owned/total progress summary, and its films in release order.
// Tapping a film opens its detail (when in the library) or the add-to-library
// popup; adding one reloads the view to refresh the progress.

import { createApi, isAbortError } from '../api.js';
import { navigate, openDetail, onCleanup } from '../router.js';
import {
  el,
  poster,
  setBg,
  icons,
  skelGrid,
  crossfadeSwap,
  clear,
  stateBlock,
} from '../ui.js';
import { collapsibleText } from '../collapsibleText.js';
import { isServerReachable, markDegraded } from '../network.js';
import { openAddModal } from './Search.js';
import { t } from '../i18n.js';

export default async function Collection(container, params) {
  const ac = new AbortController();
  onCleanup(() => ac.abort());
  const api = createApi(ac.signal);

  const id = params.id;

  // Ghost frame while loading.
  container.append(
    el('div', { class: 'detail-hero skeleton' }),
    skelGrid(6)
  );

  let d;
  try {
    d = await api.collectionDetail(id);
  } catch (err) {
    if (isAbortError(err)) return; // navigated away — ignore silently
    if (!isServerReachable()) {
      // Server unreachable (transport failure OR a 5xx from the reverse proxy
      // while the backend is down) → keep the ghost hero + grid; recovery
      // re-fetches. A 4xx keeps the server reachable → real error below.
      markDegraded();
      return;
    }
    clear(container);
    container.append(
      stateBlock({
        kind: 'error',
        title: t('collection.loadError'),
        error: err.message,
        action: { onClick: () => navigate(location.pathname + location.search, { replace: true }) },
      })
    );
    return;
  }

  const reload = () => navigate(location.pathname, { replace: true });

  // --- Hero ---
  const hero = el('div', { class: 'detail-hero coll-hero' });
  setBg(hero, d.backdrop_url || d.poster_url);
  hero.append(
    el('button', {
      class: 'icon-btn icon-btn--overlay',
      html: icons.back,
      'aria-label': t('common.back'),
      style: {
        position: 'absolute',
        top: 'calc(8px + env(safe-area-inset-top))',
        left: '8px',
        zIndex: 3,
      },
      onClick: () => history.back(),
    }),
    el('div', { class: 'coll-hero-title' }, [el('h2', { text: d.name })])
  );

  // --- Summary + progress ---
  const pct = d.total ? Math.round((d.owned / d.total) * 100) : 0;
  const head = el('div', { class: 'coll-detail-head' }, [
    el('div', { class: 'muted', text: t('collection.inLibrary', { owned: d.owned, total: d.total }) }),
    el('div', { class: 'progress-bar' }, [el('div', { style: { width: `${pct}%` } })]),
  ]);

  const body = el('div', {});
  body.append(head);

  // Uses the shared collapsible (same as Detail/Person): the old local version
  // toggled a line-clamp class, which cannot transition — the text snapped open
  // and shut. This animates the height and crossfades the label like everywhere
  // else, and drops the duplicated toggle logic.
  if (d.overview) body.append(...collapsibleText(d.overview));

  // --- Films (release order) ---
  body.append(el('div', { class: 'section-title', text: t('collection.films') }));
  const grid = el('div', { class: 'grid' });
  for (const p of d.parts) {
    const cell = el('div', { class: 'coll-cell' });
    // Clean tap target — no inline badges or overlays. Tapping opens the detail
    // popup (in-library) or the add-to-library popup, exactly like the main grid.
    const card = poster(p.poster_url, p.title);
    card.addEventListener('click', () =>
      p.in_library
        ? openDetail(`/detail/${p.item_id}`)
        : openAddModal(
            {
              tmdb_id: p.tmdb_id,
              type: 'movie',
              title: p.title,
              year: p.year,
              overview: p.overview,
            },
            { onAdded: reload }
          )
    );
    cell.append(
      card,
      el('div', { class: 'coll-film-title', text: `${p.title}${p.year ? ` (${p.year})` : ''}` })
    );
    grid.append(cell);
  }
  if (!d.parts.length) {
    grid.append(
      stateBlock({ icon: 'clapperboard', title: t('collection.empty') })
    );
  }
  body.append(grid);

  crossfadeSwap(() => {
    container.innerHTML = '';
    container.append(hero, body);
  });
}
