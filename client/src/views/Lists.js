// My Lists (/lists): every custom list as a full-width row. Up to three covers
// stacked like cases on a counter (the home card's cascade, larger), the name on
// up to two lines, "Movies · 12 titles" and a chevron. All / Movies / Series
// filter the rows; "New list" opens the creation sheet; Edit puts a red remove
// dot on every row (renaming stays on the list's own page). Reached from the
// "My Lists" link on Home. Creating and removing lists used to live in Settings.

import { createApi, isAbortError } from '../api.js';
import { navigate, onCleanup } from '../router.js';
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

// One list as a row. `onRemove` (edit mode) adds the red remove dot.
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
      onClick: preview || onRemove ? null : () => navigate(`/list/${l.id}`),
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
  if (!onRemove) return { el: row, name };
  // In edit mode the row itself doesn't navigate; the dot sits on its corner.
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
      render();
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
    render();
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
        if (!lists.length) editing = false;
        toast(t('lists.deleted'), 'ok');
        render();
      },
    });
  }

  function newRow() {
    return el(
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
  }

  function render() {
    paintEditButton();
    page.classList.toggle('is-editing', editing);
    const shown = (lists || []).filter((l) => filter === 'all' || l.type === filter);
    const rows = el('div', { class: 'lp-rows' });
    if (!editing) rows.append(newRow());
    for (const l of shown) rows.append(listRow(l, { onRemove: editing ? remove : null }).el);
    const parts = [rows];
    if (!lists.length) {
      parts.push(stateBlock({ icon: 'list-plus', title: t('lists.noneTitle'), detail: t('lists.noneDetail'), tier: 'inline' }));
    } else if (!shown.length) {
      parts.push(el('div', { class: 'muted lp-none', text: t('lists.noneFiltered') }));
    }
    body.replaceChildren(...parts);
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
