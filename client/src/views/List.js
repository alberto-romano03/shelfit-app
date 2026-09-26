// Custom list screen (/list/:id) — a user list's poster grid with rename and
// delete actions in the header. Tapping a poster opens the title's detail when
// it is in the library.

import { createApi, isAbortError } from '../api.js';
import { navigate, openDetail, onCleanup } from '../router.js';
import {
  el,
  icons,
  skelGrid,
  toast,
  openModal,
  crossfadeSwap,
  clear,
  stateBlock,
  lucideIcon,
} from '../ui.js';
import { isServerReachable, markDegraded } from '../network.js';
import { createMosaic } from '../listMosaic.js';
import { t } from '../i18n.js';

export default async function List(container, params) {
  const ac = new AbortController();
  let mosaic = null;
  // One teardown for the view: the fetch and the mosaic's ResizeObserver.
  onCleanup(() => {
    ac.abort();
    if (mosaic) mosaic.destroy();
  });
  const api = createApi(ac.signal);

  const title = el('h2', { class: 'list-title', style: { margin: 0, fontSize: '20px' } }, ['…']);
  const editBtn = el('button', { class: 'icon-btn', html: icons.pencil, 'aria-label': t('lists.rename') });
  const delBtn = el('button', { class: 'icon-btn', html: icons.trash2, 'aria-label': t('lists.delete') });
  const header = el('div', { class: 'list-header' }, [
    el('button', {
      class: 'icon-btn',
      html: icons.back,
      'aria-label': t('common.back'),
      onClick: () => history.back(),
    }),
    title,
    el('div', { class: 'list-header-actions' }, [editBtn, delBtn]),
  ]);
  const gridEl = skelGrid(9);
  container.append(header, gridEl);

  let data;
  try {
    data = await api.listItems(params.id);
  } catch (err) {
    if (isAbortError(err)) return;
    if (!isServerReachable()) {
      // Server unreachable (transport failure OR a 5xx from the reverse proxy
      // while the backend is down) → keep the header + ghost grid; recovery
      // re-fetches. A 4xx keeps the server reachable → real error below.
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

  title.textContent = data.name;

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
  if (!data.items.length) {
    crossfadeSwap(() => {
      gridEl.className = '';
      gridEl.innerHTML = '';
      gridEl.append(
        stateBlock({
          icon: 'library-big',
          title: t('lists.empty'),
          detail: t('lists.emptyDetail'),
        })
      );
    });
    return;
  }

  // Build the asymmetric mosaic (deterministic per list id), then crossfade it
  // in over the skeleton grid. Tapping a card opens the title's detail when it
  // is in the library, matching a poster tap anywhere else.
  mosaic = createMosaic(data.items, params.id, (it) => {
    if (it.item_id) openDetail(`/detail/${it.item_id}`);
    else toast(t('lists.notInLibrary'));
  });
  crossfadeSwap(() => {
    gridEl.className = '';
    gridEl.innerHTML = '';
    gridEl.append(mosaic.el);
  });
}
