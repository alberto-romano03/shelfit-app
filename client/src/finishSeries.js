// What a mark means for the series' status. Every mark hands its response here.
//   • A series still on the list was moved to Watching by the server with its
//     first episode (status_changed): say so.
//   • A shelved, paused or dropped series got a new episode watched
//     (offer_watching): ask whether to move it back to Watching. Asked once per
//     series per visit, so declining is not repeated on every tick.
//   • After a mark finishes a series (the moment the confetti fires), offer to
//     move it off "watching" and onto the shelf. Only when the series has
//     actually ENDED (TMDB reports no more episodes coming) and it is still
//     flagged watching, so a returning series you've merely caught up on is
//     never nudged to "completed".
//
// The server attaches what this needs (series_ended, item_status, title,
// status_changed, offer_watching) to every mark response. Returns the dialog it
// opened, if any, so an Undo can close it.

import { confirmModal, toast } from './ui.js';
import { api as defaultApi } from './api.js';
import { t } from './i18n.js';

const declined = new Set();

export function offerShelve(res, { id, api = defaultApi, onShelved, onStatus } = {}) {
  if (!res) return;
  if (res.status_changed === 'watching') {
    if (onStatus) onStatus('watching');
    if (!(res.caught_up && res.series_ended)) toast(t('finish.started'), 'ok');
  }
  if (res.offer_watching && !declined.has(String(id))) return offerWatching(res, { id, api, onStatus });
  if (!res.caught_up || !res.series_ended || (res.status_changed || res.item_status) !== 'watching') return;

  return confirmModal({
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

function offerWatching(res, { id, api, onStatus }) {
  declined.add(String(id)); // asked once per visit, whatever the answer
  const status = t(`status.${res.item_status}`).toLowerCase(); // "is shelved", "in pausa"
  return confirmModal({
    title: t('finish.resumeTitle'),
    body: t('finish.resumeBody', { title: res.title || '', status }),
    confirmLabel: t('finish.resume'),
    confirmIcon: 'eye',
    danger: false,
    cancelLabel: t('finish.resumeKeep', { status }),
    onConfirm: async () => {
      try {
        await api.updateMedia(id, { status: 'watching' });
        toast(t('finish.resumed'), 'ok');
        if (onStatus) onStatus('watching');
      } catch (err) {
        toast(err.message || t('search.somethingWrong'), 'bad');
        throw err;
      }
    },
  });
}
