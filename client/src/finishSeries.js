// After a mark finishes a series (the moment the confetti fires), offer to move
// it off "watching" and onto the shelf. Only when the series has actually ENDED
// (TMDB reports no more episodes coming) and it is still flagged watching, so a
// returning series you've merely caught up on is never nudged to "completed".
//
// The server attaches the three things this needs to every "caught_up" response
// (series_ended, item_status, title), so each call site just hands the response
// straight here after confetti.trigger().

import { el, openModal, lucideIcon, toast } from './ui.js';
import { api as defaultApi } from './api.js';
import { t } from './i18n.js';

export function offerShelve(res, { id, api = defaultApi, onShelved } = {}) {
  if (!res || !res.caught_up || !res.series_ended || res.item_status !== 'watching') return;

  openModal((modal, close) => {
    const shelve = el('button', { class: 'btn btn-primary' }, [
      lucideIcon('library-big', 'btn-lucide'),
      el('span', { text: t('finish.shelve') }),
    ]);
    shelve.addEventListener('click', async () => {
      shelve.disabled = true;
      try {
        await api.updateMedia(id, { status: 'completed' });
        close();
        toast(t('finish.shelved'), 'ok');
        if (onShelved) onShelved();
      } catch (err) {
        shelve.disabled = false; // keep the dialog open; the error is surfaced
        toast(err.message || t('search.somethingWrong'), 'bad');
      }
    });

    modal.append(
      el('h3', { text: t('finish.title') }),
      el('div', { class: 'muted', text: t('finish.body', { title: res.title || '' }) }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-secondary', onClick: close }, [
          lucideIcon('eye', 'btn-lucide'),
          el('span', { text: t('finish.keep') }),
        ]),
        shelve,
      ])
    );
  });
}
