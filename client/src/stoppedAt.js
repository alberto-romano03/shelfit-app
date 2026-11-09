// "Stopped at": the minute a movie or an episode was left at, to pick it up there.
// One sheet sets it for both: the episode's also holds the episode's note, the
// movie's is the field alone. The field is a player's front-panel display you type
// the minute into, with a clear key beside it.

import { el, lucideIcon, openSheet, toast, typewriterPlaceholder } from './ui.js';
import { t } from './i18n.js';

// "37 / 100 min", or "37 min" when TMDB has no runtime for it.
export function stopLabel(min, total) {
  return total ? t('stop.ofTotal', { n: min, total }) : t('stop.min', { n: min });
}

// openStopSheet({ title, total, value, note, onSave })
//   total  the runtime in minutes, 0 when unknown (the field then has no total)
//   value  the current minute, 0 for none
//   note   episodes only: { value, placeholder } puts the note under the field
//   onSave async (minute, noteText) => {}; a throw keeps the sheet open
export function openStopSheet({ title, total = 0, value = 0, note = null, onSave }) {
  openSheet(
    (sheet, close) => {
      const input = el('input', {
        class: 'stop-input',
        type: 'text',
        inputmode: 'numeric',
        pattern: '[0-9]*',
        maxlength: '3',
        autocomplete: 'off',
        placeholder: '0',
        'aria-label': t('stop.field'),
      });
      input.value = value ? String(value) : '';
      // Past the runtime the number turns red, and settles on the runtime once you
      // leave the field (or save).
      const typed = () => parseInt(input.value, 10) || 0;
      const minute = () => (total ? Math.min(typed(), total) : typed());
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(0, 3);
        input.classList.toggle('is-over', !!total && typed() > total);
      });
      input.addEventListener('blur', () => {
        if (input.value) input.value = String(minute());
        input.classList.remove('is-over');
      });

      const display = el('label', { class: 'stop-display' }, [
        el('span', { class: 'stop-display-lbl', text: t('stop.display'), 'aria-hidden': 'true' }),
        input,
        el('span', { class: 'stop-display-of', text: total ? t('stop.displayOf', { total }) : t('stop.displayMin') }),
      ]);
      const clear = el('button', { class: 'rewatch-step-btn stop-clear', type: 'button', 'aria-label': t('stop.clear') }, [
        lucideIcon('circle-x', 'btn-lucide'),
      ]);
      clear.addEventListener('click', () => {
        input.value = '';
        input.classList.remove('is-over');
        input.focus();
      });

      const body = el('div', { class: 'sheet-body' }, [
        el('div', { class: 'field-label', text: t('stop.title') }),
        el('div', { class: 'stop-field' }, [display, clear]),
      ]);

      let textarea = null;
      let stopTypewriter = () => {};
      if (note) {
        textarea = el('textarea', { class: 'text-field note-sheet-input', rows: '4' });
        textarea.value = note.value || '';
        stopTypewriter = typewriterPlaceholder(textarea, note.placeholder || '');
        body.append(el('hr', { class: 'status-sep stop-sep' }), el('div', { class: 'field-label', text: t('stop.note') }), textarea);
      }

      let saving = false;
      async function save(noteText) {
        if (saving) return;
        saving = true;
        stopTypewriter();
        try {
          await onSave(minute(), noteText);
          close();
        } catch (err) {
          saving = false;
          if (err && err.message) toast(err.message, 'bad');
        }
      }

      const footer = el('div', { class: 'sheet-footer note-sheet-footer' }, [
        el('div', { class: 'note-sheet-actions' }, [
          el('button', { class: 'btn btn-secondary', onClick: () => { stopTypewriter(); close(); } }, [
            lucideIcon('x', 'btn-lucide'),
            el('span', { text: t('common.cancel') }),
          ]),
          el('button', { class: 'btn btn-primary', onClick: () => save(textarea ? textarea.value.trim() : undefined) }, [
            lucideIcon('check', 'btn-lucide'),
            el('span', { text: t('season.confirm') }),
          ]),
        ]),
      ]);
      // An episode that already has a note keeps its Delete note link.
      if (note && note.value) {
        footer.append(el('button', { class: 'link-btn link-danger note-delete', text: t('season.deleteNote'), onClick: () => save('') }));
      }

      sheet.append(el('div', { class: 'sheet-header' }, [el('h3', { text: title })]), body, footer);
      // With no note to write, the field is ready to type into straight away.
      if (!note) {
        setTimeout(() => {
          input.focus();
          input.select();
        }, 60);
      }
    },
    { compact: true }
  );
}
