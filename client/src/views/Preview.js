// Preview screen (/preview/:type/:id) — a read-only detail view for a title not
// yet in the library. Shows the same hero, poster, and overview as the real
// detail; the only action is an explicit "Add to library" (nothing is added by
// opening it). Redirects to the real detail when the title is already present.

import { createApi, isAbortError } from '../api.js';
import { navigate, onCleanup } from '../router.js';
import { isServerReachable, markDegraded } from '../network.js';
import { openAddModal } from './Search.js';
import { renderCollectionSection } from './Detail.js';
import {
  el,
  icons,
  mountPoster,
  setBg,
  skelLine,
  toast,
  crossfadeSwap,
  clear,
  stateBlock,
} from '../ui.js';
import { t } from '../i18n.js';

// Ghost frame identical in shape to the real detail so the crossfade holds.
// Mirrors the library detail skeleton: the poster is wrapped so it bottom-anchors
// (sticking UP into the hero) instead of overflowing DOWN into the description,
// and the description block is pushed clear of the head.
function previewSkeleton() {
  const frag = document.createDocumentFragment();
  frag.append(
    el('div', { class: 'detail-hero skeleton' }),
    el('div', { class: 'detail-head' }, [
      el('div', { class: 'detail-poster-wrap' }, [el('div', { class: 'detail-poster skeleton' })]),
      el('div', { class: 'detail-titles' }, [
        skelLine({ width: '75%', height: '22px', margin: '0 0 8px' }),
        skelLine({ width: '50%', height: '14px' }),
        skelLine({ width: '40%', height: '13px', margin: '12px 0 0' }),
      ]),
    ]),
    el('div', { style: { marginTop: '20px' } }, [
      skelLine({ margin: '0 0 8px' }),
      skelLine({ width: '92%', margin: '8px 0' }),
      skelLine({ width: '96%', margin: '8px 0' }),
    ])
  );
  return frag;
}

// A no-add detail view for a title that isn't in the library. Shows the same
// hero + poster + details as the library detail; the only action is an explicit
// "Add to library" button (nothing is added just by opening this view).
export default async function Preview(container, params) {
  const ac = new AbortController();
  onCleanup(() => ac.abort());
  const api = createApi(ac.signal);

  container.append(previewSkeleton());
  const { type, id: tmdbId } = params;

  let d;
  try {
    d = await api.preview(type, tmdbId);
  } catch (err) {
    if (isAbortError(err)) return; // navigated away
    if (!isServerReachable()) {
      markDegraded(); // server unreachable (transport failure or backend 5xx); a 4xx shows an error
      return;
    }
    clear(container);
    container.append(
      stateBlock({
        kind: 'error',
        title: t('preview.loadError'),
        error: err.message,
        action: { onClick: () => navigate(location.pathname + location.search, { replace: true }) },
      })
    );
    return;
  }

  // Already in the library → send the user to the real, fully-interactive detail.
  if (d.in_library && d.item_id) {
    navigate(`/detail/${d.item_id}`, { replace: true });
    return;
  }

  const meta = d.meta || {};

  // --- Hero + back (no "···" menu — there's nothing to manage yet) ---
  const hero = el('div', { class: 'detail-hero' });
  setBg(hero, d.backdrop_url);
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

  // --- Poster + titles ---
  // Wrap the poster like the real library detail so it bottom-anchors within the
  // head (sticking up into the hero) instead of overflowing down into the body.
  const posterBox = mountPoster(el('div', { class: 'detail-poster' }), d.poster_url, d.title_it);
  const posterWrap = el('div', { class: 'detail-poster-wrap' }, [posterBox]);

  const metaBits = [];
  if (meta.year) metaBits.push(meta.year);
  if (type === 'movie' && meta.runtime) metaBits.push(t('preview.runtime', { min: meta.runtime }));
  if (type === 'show' && meta.number_of_seasons)
    metaBits.push(t('preview.seasons', { n: Number(meta.number_of_seasons) }));
  if (meta.genres && meta.genres.length) metaBits.push(meta.genres.join(', '));

  const titles = el('div', { class: 'detail-titles' }, [
    el('h2', { text: d.title_it }),
    d.title_orig && d.title_orig !== d.title_it
      ? el('div', { class: 'orig', text: d.title_orig })
      : null,
    el('div', { class: 'detail-meta', text: metaBits.join(' · ') }),
    el('div', { class: 'preview-note', text: t('preview.notInLibrary') }),
  ]);

  const head = el('div', { class: 'detail-head' }, [posterWrap, titles]);

  // --- Body: overview + add CTA --- (margin clears it from the head above) ---
  const body = el('div', { style: { marginTop: '20px' } });
  if (meta.overview) {
    const ov = el('div', { class: 'overview clamp', text: meta.overview });
    const toggle = el('div', { class: 'overview-toggle', text: t('common.showMore') });
    let expanded = false;
    toggle.addEventListener('click', () => {
      expanded = !expanded;
      ov.classList.toggle('clamp', !expanded);
      toggle.textContent = expanded ? t('preview.showLess') : t('common.showMore');
    });
    body.append(ov, toggle);
  }

  // Explicit add — nothing happens until the user chooses to. Reuses the shared
  // add dialog; on success it jumps to the new title's real detail.
  const addBtn = el('button', {
    class: 'btn btn-primary preview-add',
    html: `${icons.plus}<span style="margin-left:8px">${t('preview.addToLibrary')}</span>`,
    onClick: () =>
      openAddModal(
        {
          tmdb_id: d.tmdb_id,
          type: d.type,
          title: d.title_it,
          year: meta.year,
          overview: meta.overview,
        },
        {
          onAdded: (newId) => {
            if (newId) navigate(`/detail/${newId}`, { replace: true });
            else toast(t('preview.addedToLibrary'), 'ok');
          },
        }
      ),
  });
  body.append(el('div', { class: 'preview-actions' }, [addBtn]));

  // A trailing sentinel so the collection section renders at the end of body.
  const anchor = el('div', { class: 'preview-anchor' });
  body.append(anchor);

  crossfadeSwap(() => {
    container.innerHTML = '';
    container.append(hero, head, body);
  });

  // --- "More from this Collection" (reuses the Detail renderer) ---
  const btc = type === 'movie' ? meta.belongs_to_collection : null;
  if (btc && btc.id) {
    renderCollectionSection(api, body, anchor, btc, d);
  }
}
