// Shared watch-status selector — the pill button that opens a status chooser.
//
// Extracted from the detail view so the Kodi sync review reuses the exact same
// component (same UI, same interactions). The caller supplies onSelect(key),
// which may be synchronous (local state only, as in the review card) or return
// a promise (e.g. a persisting API call in the detail view). If onSelect
// rejects, the chooser stays open and the button keeps its previous value — the
// caller is responsible for showing the error.

import { el, icons, openModal, lucideIcon } from './ui.js';
import { withBase } from './basePath.js';
import { t } from './i18n.js';

// Labels are getters so they resolve in the current language at read time (the
// exported shape — `.label` / `STATUS_LABELS[key]` strings — is unchanged).
export const STATUS_SEGMENTS = [
  { key: 'plan_to_watch', get label() { return t('statusSelect.plan'); } },
  { key: 'watching', get label() { return t('status.watching'); } },
  { key: 'completed', get label() { return t('status.completed'); } },
  { key: 'paused', get label() { return t('status.paused'); } },
  { key: 'dropped', get label() { return t('status.dropped'); } },
];

export const STATUS_LABELS = {
  get plan_to_watch() { return t('status.plan_to_watch'); },
  get watching() { return t('status.watching'); },
  get completed() { return t('status.completed'); }, // data value stays 'completed'; only the label changed
  get paused() { return t('status.paused'); },
  get dropped() { return t('status.dropped'); },
};

// Bento order + Lucide icon per status. First 3 form the top row, last 2 the
// bottom row (marked wide so each spans half the grid).
const STATUS_BENTO = [
  { key: 'plan_to_watch', icon: 'calendar-plus' },
  { key: 'watching', icon: 'eye' },
  { key: 'completed', icon: 'library-big' },
  { key: 'paused', icon: 'pause' },
  { key: 'dropped', icon: 'x' },
];

// Per-status accent colour — the single association shared by the closed trigger
// pill (tints the current status's leading icon) and the open bento chooser (tints
// each cell's icon, and the highlight of the selected cell). Defined once here so
// the two never drift apart. Applied via the scoped `--sc` custom property.
export const STATUS_COLORS = {
  plan_to_watch: '#7db6f0', // blue
  watching: '#7ed99a', // green
  completed: '#6fd4c4', // teal
  paused: '#f0c674', // amber
  dropped: '#e5867f', // red
};
const STATUS_ICON = Object.fromEntries(STATUS_BENTO.map((s) => [s.key, s.icon]));

// Build the shared status bento grid. `onSelect(key, cell)` fires on a cell tap;
// `selected` (optional) marks one cell active. Reused by the detail status
// chooser and the search/explore add dialog so they share one visual language.
export function buildStatusBento({ selected = null, onSelect } = {}) {
  const grid = el('div', { class: 'status-bento' });
  STATUS_BENTO.forEach((s, i) => {
    const cell = el(
      'button',
      {
        class:
          'status-cell' +
          (i >= 3 ? ' wide' : '') + // bottom row spans half each
          (selected === s.key ? ' selected' : ''),
      },
      [lucideIcon(s.icon, 'status-ico'), el('span', { class: 'status-cell-label', text: STATUS_LABELS[s.key] })]
    );
    cell.style.setProperty('--sc', STATUS_COLORS[s.key]); // per-status colour cue
    cell.addEventListener('click', () => onSelect && onSelect(s.key, cell));
    grid.append(cell);
  });
  return grid;
}

export function createStatusSelect({ status, onSelect, title } = {}) {
  let current = status;
  const btn = el('button', { class: 'status-select' });

  function render() {
    btn.innerHTML = '';
    // Leading glyph = the current status's icon, tinted in that status's colour
    // (via --sc). Unset → no icon, neutral pill.
    const iconName = STATUS_ICON[current];
    if (iconName) {
      btn.style.setProperty('--sc', STATUS_COLORS[current] || '');
      btn.append(lucideIcon(iconName, 'status-sel-ico'));
    } else {
      btn.style.removeProperty('--sc');
    }
    btn.append(
      el('span', { class: 'status-cur', text: STATUS_LABELS[current] || t('statusSelect.setStatus') }),
      el('span', { class: 'status-caret', html: icons.chevron })
    );
  }
  render();

  btn.addEventListener('click', () => {
    openModal((modal, close) => {
      const grid = buildStatusBento({
        selected: current,
        onSelect: async (key) => {
          try {
            const r = onSelect ? onSelect(key, current) : undefined;
            if (r && typeof r.then === 'function') await r;
          } catch {
            return; // keep the chooser open; caller surfaced the error
          }
          current = key;
          render();
          close();
        },
      });
      modal.append(
        el('h3', { text: title || t('statusSelect.title') }),
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
  });

  return {
    element: btn,
    getStatus: () => current,
    setStatus: (s) => {
      current = s;
      render();
    },
  };
}
