// Incoming title suggestions, told as a friend lending you a DVD: when another
// member has suggested a title, a popup asks about it the next time this member
// opens the app, headed by the note they wrote ("I really think you should see
// this"), or "Alberto wants to lend you this DVD" without one. The poster wears
// the owned look (blue edge bars) with the disc sliding out from behind it and a
// sticky note from the friend; title and year below. Borrow it puts the title on
// Plan to Watch; No thanks declines for good; tapping outside only puts it off
// until the next open. Several loans are offered one after another.
//
// Like the Kodi review card, it never stacks on another popup: it waits until
// none is open.

import { api } from './api.js';
import { el, lucideIcon, openModal, poster, setBg, toast } from './ui.js';
import { t } from './i18n.js';

let running = false;
let lastCheck = 0;
const RECHECK_MS = 60 * 1000; // at most once a minute on returning to the app

function isPopupOpen() {
  return !!document.querySelector('.modal-backdrop');
}

function whenNoPopup() {
  return new Promise((resolve) => {
    if (!isPopupOpen()) return resolve();
    const timer = setInterval(() => {
      if (!isPopupOpen()) {
        clearInterval(timer);
        resolve();
      }
    }, 600);
  });
}

// The lent object: the poster in the owned look (blue edge bars, see .lend-case),
// the disc peeking out from behind it, and the friend's sticky note on the corner.
function lentDvd(s) {
  const disc = el('div', { class: 'lend-disc' }, [
    el('div', { class: 'lend-disc-spin' }, [
      el('div', { class: 'detail-disc-hub' }),
      el('div', { class: 'detail-disc-hole' }),
    ]),
  ]);
  setBg(disc.firstChild, s.poster_url); // the disc printed with the poster art
  const sleeve = el('div', { class: 'lend-case' }, [poster(s.poster_url, s.title)]);
  const note = el('div', { class: 'lend-note', text: t('lend.note', { name: s.from_name }) });
  return el('div', { class: 'lend-stage' }, [el('div', { class: 'lend-float' }, [disc, sleeve, note])]);
}

// One loan's popup. Resolves when it closes, however it closed.
function showSuggestion(s) {
  return new Promise((resolve) => {
    openModal(
      (modal, close) => {
        const borrow = el('button', { class: 'btn btn-primary' }, [
          lucideIcon('shelving-unit', 'btn-lucide'),
          el('span', { text: t('lend.accept') }),
        ]);
        const decline = el('button', { class: 'btn btn-secondary' }, [
          lucideIcon('x', 'btn-lucide'),
          el('span', { text: t('lend.decline') }),
        ]);
        borrow.addEventListener('click', async () => {
          borrow.disabled = true;
          decline.disabled = true;
          try {
            await api.acceptSuggestion(s.id);
            toast(t('lend.added', { title: s.title }), 'ok');
            close();
          } catch (err) {
            borrow.disabled = false;
            decline.disabled = false;
            toast(t('suggest.failed'), 'bad'); // the server's reasons are English-only
          }
        });
        decline.addEventListener('click', async () => {
          decline.disabled = true;
          try {
            await api.dismissSuggestion(s.id);
          } catch {
            /* it will simply be offered again next time */
          }
          close();
        });

        const kind = s.type === 'movie' ? t('suggest.movie') : t('suggest.show');
        // The friend's own words are the headline; a loan sent without a note
        // (or from before notes existed) says who is lending it instead.
        const heading = s.message
          ? el('h3', { class: 'lend-heading lend-heading--quote', text: `“${s.message}”` })
          : el('h3', {
              class: 'lend-heading',
              text: t(s.type === 'movie' ? 'lend.headingMovie' : 'lend.headingShow', { name: s.from_name }),
            });
        modal.append(
          heading,
          lentDvd(s),
          el('div', { class: 'ksync-meta' }, [
            el('div', { class: 'ksync-name', text: s.title }),
            el('div', { class: 'ksync-year', text: [s.year, kind].filter(Boolean).join(' · ') }),
          ]),
          el('div', { class: 'lend-quip', text: t('lend.quip') }),
          el('hr', { class: 'status-sep' }),
          el('div', { class: 'modal-actions' }, [decline, borrow])
        );
      },
      { center: true, className: 'lend-modal', onClose: resolve }
    );
  });
}

// Offer every pending loan, one popup at a time. Safe to call often: it runs
// once at a time and re-checks at most once a minute.
export async function checkSuggestions({ force = false } = {}) {
  if (running) return;
  if (!force && Date.now() - lastCheck < RECHECK_MS) return;
  running = true;
  lastCheck = Date.now();
  try {
    let list = [];
    try {
      list = ((await api.suggestions()) || {}).suggestions || [];
    } catch {
      return; // offline or signed out: try again later
    }
    for (const s of list) {
      await whenNoPopup();
      await showSuggestion(s);
    }
  } finally {
    running = false;
  }
}
