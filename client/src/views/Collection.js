// Collection detail screen (/collection/:id): a TMDB movie collection laid out
// like a title's detail page. A backdrop hero with the collection poster over its
// edge, the name, the years it spans, how much of it is in the library (a pip per
// film), the overview, then every film in release order on the 3-column grid:
// owned ones carry their watch status, missing ones are faded with a plus, and
// unreleased ones say when they're coming. Tapping a film opens its detail (in
// the library) or the add-to-library popup; adding one reloads the view.

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
  lucideIcon,
} from '../ui.js';
import { collapsibleText } from '../collapsibleText.js';
import { isServerReachable, markDegraded } from '../network.js';
import { openAddModal } from './Search.js';
import { collectionName } from './grid.js';
import { STATUS_LABELS } from '../statusSelect.js';
import { t } from '../i18n.js';

// The status picker's icon for each watch status (statusSelect.js).
const STATUS_ICON = {
  plan_to_watch: 'calendar-plus',
  watching: 'eye',
  completed: 'library-big',
  paused: 'pause',
  dropped: 'x',
};
// Past this many films the pips would be slivers: one plain bar instead.
const PIPS_MAX = 14;

// "2009 – 2031 · 5 films" (just the count when no film has a year yet).
function yearsLine(parts) {
  const ys = parts.map((p) => Number(p.year)).filter(Boolean);
  const count = t('collection.filmCount', { n: parts.length });
  if (!ys.length) return count;
  const a = Math.min(...ys);
  const b = Math.max(...ys);
  return `${a === b ? a : `${a} – ${b}`} · ${count}`;
}

function progress(parts) {
  if (parts.length > PIPS_MAX) {
    const owned = parts.filter((p) => p.in_library).length;
    return el('div', { class: 'cp-bar' }, [el('i', { style: { width: `${(owned / parts.length) * 100}%` } })]);
  }
  return el(
    'div',
    { class: 'cp-pips' },
    parts.map((p) => el('i', { class: p.in_library ? 'on' : '' }))
  );
}

// No release year yet, or one still ahead: not out, so there is nothing to add
// beyond a plan.
function unreleased(p) {
  return !p.year || Number(p.year) > new Date().getFullYear();
}

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
  const name = collectionName(d.name);
  const complete = d.total > 0 && d.owned >= d.total;

  // --- Hero + head ---
  const hero = el('div', { class: 'detail-hero cp-hero' });
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
    })
  );
  const art = poster(d.poster_url, name);
  art.classList.add('cp-poster');
  const head = el('div', { class: 'cp-head' }, [
    art,
    el('div', { class: 'cp-head-text' }, [
      el('h2', { class: 'cp-name', text: name }),
      el('div', { class: 'cp-years', text: yearsLine(d.parts) }),
      el('div', {
        class: `cp-owned${complete ? ' is-done' : ''}`,
        text: complete ? t('collection.complete') : t('collection.inLibrary', { owned: d.owned, total: d.total }),
      }),
      d.parts.length ? progress(d.parts) : null,
    ]),
  ]);

  const body = el('div', { class: 'cp-body' });
  // Uses the shared collapsible (same as Detail/Person): the old local version
  // toggled a line-clamp class, which cannot transition — the text snapped open
  // and shut. This animates the height and crossfades the label like everywhere
  // else, and drops the duplicated toggle logic.
  if (d.overview) body.append(...collapsibleText(d.overview));

  // --- Films (release order) ---
  body.append(el('div', { class: 'section-title', text: t('collection.films') }));
  const grid = el('div', { class: 'grid cp-grid' });
  for (const p of d.parts) {
    const card = poster(p.poster_url, p.title);
    if (p.in_library) {
      if (STATUS_ICON[p.status]) {
        card.append(
          el('span', { class: 'cp-status', title: STATUS_LABELS[p.status], 'aria-label': STATUS_LABELS[p.status] }, [
            lucideIcon(STATUS_ICON[p.status], 'btn-lucide'),
          ])
        );
      }
    } else {
      card.classList.add('cp-missing');
      card.append(
        unreleased(p)
          ? el('span', {
              class: 'cp-soon',
              text: p.year ? t('collection.coming', { year: p.year }) : t('collection.announced'),
            })
          : el('span', { class: 'cp-add', 'aria-hidden': 'true', html: icons.plus })
      );
    }
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
    grid.append(
      el('div', { class: `cp-cell${p.in_library ? '' : ' is-missing'}` }, [
        card,
        el('div', { class: 'cp-title', text: p.title }),
        el('div', { class: 'cp-year', text: p.year || t('collection.noYear') }),
      ])
    );
  }
  if (!d.parts.length) {
    grid.append(
      stateBlock({ icon: 'clapperboard', title: t('collection.empty') })
    );
  }
  body.append(grid);

  crossfadeSwap(() => {
    container.innerHTML = '';
    container.append(hero, head, body);
  });
}
