// After a mark finishes a series (the moment the confetti fires), offer to move
// it off "watching" and onto the shelf. Only when the series has actually ENDED
// (TMDB reports no more episodes coming) and it is still flagged watching, so a
// returning series you've merely caught up on is never nudged to "completed".
//
// The server attaches the three things this needs to every "caught_up" response
// (series_ended, item_status, title), so each call site just hands the response
// straight here after confetti.trigger().

import { confirmModal, toast } from './ui.js';
import { api as defaultApi } from './api.js';
import { t } from './i18n.js';

export function offerShelve(res, { id, api = defaultApi, onShelved } = {}) {
  if (!res || !res.caught_up || !res.series_ended || res.item_status !== 'watching') return;

  confirmModal({
    title: t('finish.title'),
    body: t('finish.body', { title: res.title || '' }),
    confirmLabel: t('finish.shelve'),
    confirmIcon: 'library-big',
    danger: false,
    cancelLabel: t('finish.keep'),
    cancelIcon: 'eye',
    onConfirm: async () => {
      try {
        await api.updateMedia(id, { status: 'completed' });
        toast(t('finish.shelved'), 'ok');
        if (onShelved) onShelved();
      } catch (err) {
        toast(err.message || t('search.somethingWrong'), 'bad');
        throw err; // keep the dialog open; the error is surfaced
      }
    },
  });
}
