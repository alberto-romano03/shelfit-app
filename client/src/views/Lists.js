// My Lists (/lists): every custom list as a full-width row. Up to three covers
// stacked like cases on a counter (the home card's cascade, larger), the name on
// up to two lines, "Movies · 12 titles" and a chevron. All / Movies / Series
// filter the rows; "New list" opens the creation sheet; Edit puts a red remove
// dot on every row (renaming stays on the list's own page). Reached from the
// "My Lists" link on Home. Creating and removing lists used to live in Settings.

import { createApi, isAbortError } from '../api.js';
import { onCleanup } from '../router.js';
import {
  el,
  icons,
  cachedImg,
  skelLine,
  toast,
  openModal,
  confirmModal,
  segmentedControl,
  stateBlock,
  lucideIcon,
  typewriterPlaceholder,
  clear,
} from '../ui.js';
import { imageCache } from '../imageCache.js';
import { wireListCard } from './List.js';
import { t } from '../i18n.js';

// Same cap as the server (routes/lists.js).
export const LIST_NAME_MAX = 40;
const NAME_IDEAS = ['lists.idea1', 'lists.idea2', 'lists.idea3'];

// The filter picked on this page, kept for the session.
let filter = 'all';

function typeIcon(type) {
  return type === 'movie' ? icons.navMovies : icons.navSeries;
}

function metaText(l) {
  return `${t(l.type === 'movie' ? 'media.movies' : 'media.series')} · ${t('lists.titles', { n: l.count })}`;
}

// One list as a row. `onRemove` adds a red remove dot on its corner, shown only
// while the page is in edit mode (.is-editing), when the row stops opening.
export function listRow(l, { onRemove, preview = false } = {}) {
  const covers = (l.preview || []).filter((it) => it.poster_url).slice(0, 3);
  const art = covers.length
    ? el('div', { class: 'lw-art' }, covers.map((it, i) => cachedImg(it.poster_url, { class: `lw-case c${i}`, alt: '' })))
    : el('div', { class: 'lw-art is-empty' }, [el('span', { class: 'lw-empty', html: typeIcon(l.type) })]);
  const name = el('div', { class: 'lw-name', text: l.name });
  const row = el(
    preview ? 'div' : 'button',
    {
      class: 'lw-card',
      ...(preview ? { 'aria-hidden': 'true' } : { type: 'button', title: l.name }),
    },
    [
      art,
      el('div', { class: 'lw-text' }, [
        name,
        el('div', { class: 'lw-meta' }, [
          el('span', { class: 'lw-type', html: typeIcon(l.type) }),
          el('span', { text: metaText(l) }),
        ]),
      ]),
      preview ? null : el('span', { class: 'lw-chev', html: icons.forward }),
    ]
  );
  if (!preview) wireListCard(row, l); // opens the list, loading it from the press
  if (!onRemove) return { el: row, name };
  const wrap = el('div', { class: 'lw-wrap' }, [
    row,
    el('button', {
      class: 'lw-remove',
      type: 'button',
      'aria-label': t('lists.remove', { name: l.name }),
      html: icons.close,
      onClick: () => onRemove(l),
    }),
  ]);
  return { el: wrap, name };
}

// The creation sheet: type first, a live preview of the row, the name with a
// counter and a self-typing placeholder, then Cancel / Create.
export function openNewListSheet({ type = 'movie', onCreated } = {}) {
  let stopTypewriter = () => {};
  openModal(
    (modal, close) => {
      let current = type === 'show' ? 'show' : 'movie';
      const input = el('input', {
        class: 'text-field',
        type: 'text',
        maxlength: String(LIST_NAME_MAX),
        autocomplete: 'off',
        'aria-label': t('lists.nameLabel'),
      });
      const counter = el('div', { class: 'nl-count', 'aria-live': 'polite' });
      const previewSlot = el('div', { class: 'nl-preview' });
      const createBtn = el('button', { class: 'btn btn-primary', type: 'button' }, [
        lucideIcon('plus', 'btn-lucide'),
        el('span', { text: t('lists.create') }),
      ]);

      function paint() {
        const value = input.value.trim();
        const { el: rowEl, name } = listRow(
          { name: value || t('lists.previewName'), type: current, count: 0, preview: [] },
          { preview: true }
        );
        if (!value) name.classList.add('is-placeholder');
        previewSlot.replaceChildren(rowEl);
        const n = [...input.value].length;
        counter.textContent = `${n}/${LIST_NAME_MAX}`;
        counter.classList.toggle('full', n >= LIST_NAME_MAX);
        createBtn.disabled = !value;
      }

      const typeSeg = segmentedControl({
        options: [
          ['movie', t('media.movies'), 'clapperboard'],
          ['show', t('media.series'), 'tv'],
        ],
        value: current,
        ariaLabel: t('lists.typeAria'),
        center: true,
        onChange: (v) => {
          current = v;
          paint();
        },
      });

      async function submit() {
        const value = input.value.trim();
        if (!value || createBtn.disabled) return;
        createBtn.disabled = true;
        try {
          const res = await createApi().createList(value, current);
          close();
          toast(t('lists.created'), 'ok');
          if (onCreated) onCreated({ id: res.id, name: value, type: current });
        } catch (err) {
          createBtn.disabled = false;
          toast(err.message || t('lists.failed'), 'bad');
        }
      }
      createBtn.addEventListener('click', submit);
      input.addEventListener('input', paint);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
      paint();
      stopTypewriter = typewriterPlaceholder(input, t(NAME_IDEAS[Math.floor(Math.random() * NAME_IDEAS.length)]));

      modal.append(
        el('h3', { text: t('lists.new') }),
        el('div', { class: 'nl-type' }, [typeSeg.el]),
        previewSlot,
        el('div', { class: 'field-label', text: t('lists.nameLabel') }),
        input,
        counter,
        el('hr', { class: 'status-sep' }),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-secondary', type: 'button', onClick: close }, [
            lucideIcon('x', 'btn-lucide'),
            el('span', { text: t('common.cancel') }),
          ]),
          createBtn,
        ])
      );
    },
    { className: 'nl-modal', onClose: () => stopTypewriter() }
  );
}

function skeletonRows() {
  return el(
    'div',
    { class: 'lp-rows' },
    Array.from({ length: 3 }, () =>
      el('div', { class: 'lw-card lw-skel' }, [
        el('div', { class: 'lw-art' }, [el('div', { class: 'lw-case c0 skeleton' })]),
        el('div', { class: 'lw-text' }, [skelLine({ width: '70%', height: '16px' }), skelLine({ cls: 'sm', width: '45%' })]),
      ])
    )
  );
}

export default async function Lists(container) {
  const ac = new AbortController();
  const api = createApi(ac.signal);
  onCleanup(() => ac.abort());

  let lists = null;
  let editing = false;

  const editBtn = el('button', { class: 'icon-btn', type: 'button' });
  const head = el('div', { class: 'lp-head' }, [
    el('button', { class: 'icon-btn', html: icons.back, 'aria-label': t('common.back'), onClick: () => history.back() }),
    el('h2', { class: 'lp-title', text: t('home.myLists') }),
    editBtn,
  ]);
  const seg = segmentedControl({
    options: [
      ['all', t('common.all')],
      ['movie', t('media.movies')],
      ['show', t('media.series')],
    ],
    value: filter,
    ariaLabel: t('lists.filterAria'),
    center: true,
    onChange: (v) => {
      filter = v;
      applyFilter();
    },
  });
  const body = el('div', { class: 'lp-body' }, [skeletonRows()]);
  const page = el('div', { class: 'lists-page' }, [head, seg.el, body]);
  container.append(page);

  function paintEditButton() {
    clear(editBtn);
    editBtn.className = editing ? 'lp-done' : 'icon-btn';
    if (editing) editBtn.textContent = t('common.done');
    else editBtn.innerHTML = icons.pencil;
    editBtn.setAttribute('aria-label', editing ? t('common.done') : t('common.edit'));
    editBtn.style.display = lists && lists.length ? '' : 'none';
  }
  editBtn.addEventListener('click', () => {
    editing = !editing;
    applyEditing();
  });

  function remove(l) {
    confirmModal({
      title: t('lists.deleteTitle', { name: l.name }),
      body: t('lists.deleteBody'),
      confirmLabel: t('lists.deleteConfirm'),
      onConfirm: async () => {
        try {
          await api.deleteList(l.id);
        } catch (err) {
          toast(err.message || t('lists.failed'), 'bad');
          throw err;
        }
        lists = lists.filter((x) => x.id !== l.id);
        const row = rowEls.get(l.id);
        rowEls.delete(l.id);
        if (row) collapse(row).then(() => row.remove());
        if (!lists.length) editing = false;
        toast(t('lists.deleted'), 'ok');
        applyFilter();
        applyEditing();
      },
    });
  }

  // One "New list" row for the page. Edit mode only disables it, so the rows
  // below don't jump up when editing starts and back down when it ends, and it
  // fades rather than vanishing.
  const newRow = el(
    'button',
    {
      class: 'lw-card lw-new',
      type: 'button',
      onClick: () =>
        openNewListSheet({
          type: filter === 'show' ? 'show' : 'movie',
          onCreated: () => load(),
        }),
    },
    [el('span', { class: 'lw-new-plus', html: icons.plus }), el('span', { text: t('lists.new') })]
  );

  // The rows are built once per load and then left alone: edit mode and the
  // filter only switch classes and visibility, so the covers never reload or
  // fade in again, the remove dots and chevrons ease in and out (styles.css),
  // and the "New list" row only fades to disabled.
  const listHost = el('div', { class: 'lp-list-host' });
  const rows = el('div', { class: 'lp-rows' }, [newRow, listHost]);
  const note = el('div');
  let rowEls = new Map(); // list id -> its row

  function render() {
    rowEls = new Map(lists.map((l) => [l.id, listRow(l, { onRemove: remove }).el]));
    listHost.replaceChildren(...rowEls.values());
    applyFilter();
    applyEditing();
    if (rows.parentNode !== body) body.replaceChildren(rows, note);
  }

  function applyFilter() {
    let shown = 0;
    for (const l of lists) {
      const on = filter === 'all' || l.type === filter;
      const row = rowEls.get(l.id);
      if (row) row.hidden = !on;
      if (on) shown++;
    }
    if (!lists.length) {
      note.replaceChildren(
        stateBlock({ icon: 'list-plus', title: t('lists.noneTitle'), detail: t('lists.noneDetail'), tier: 'inline' })
      );
    } else if (!shown) {
      note.replaceChildren(el('div', { class: 'muted lp-none', text: t('lists.noneFiltered') }));
    } else {
      note.replaceChildren();
    }
  }

  function applyEditing() {
    paintEditButton();
    page.classList.toggle('is-editing', editing);
    newRow.disabled = editing;
    // The dots are always there; out of edit mode they're invisible, so keep
    // them out of the tab order and away from screen readers.
    for (const row of rowEls.values()) {
      const dot = row.querySelector('.lw-remove');
      dot.tabIndex = editing ? 0 : -1;
      dot.setAttribute('aria-hidden', String(!editing));
    }
  }

  // A deleted list fades out, then its place closes up (the grid gap with it).
  function collapse(node) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
    const h = node.offsetHeight;
    return node
      .animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.96)' }], {
        duration: 160,
        easing: 'ease-out',
        fill: 'forwards',
      })
      .finished.then(
        () =>
          node.animate(
            [
              { height: `${h}px`, marginBottom: '0px' },
              { height: '0px', marginBottom: '-10px' }, // -10px: .lp-rows gap
            ],
            { duration: 220, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }
          ).finished
      )
      .catch(() => {});
  }

  async function load() {
    try {
      const data = await api.lists();
      lists = data.lists || [];
      imageCache.preload(lists.flatMap((l) => (l.preview || []).slice(0, 3).map((it) => it.poster_url)).filter(Boolean));
      render();
    } catch (err) {
      if (isAbortError(err)) return;
      body.replaceChildren(
        stateBlock({
          kind: 'error',
          title: t('lists.pageLoadError'),
          error: err.message,
          action: { onClick: () => load() },
        })
      );
    }
  }
  paintEditButton();
  await load();
}
