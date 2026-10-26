// Kodi sync review card — a bottom-sheet popup (same style as Rate-O-Matic /
// Dust It Off) for reviewing titles discovered in the Kodi library before they
// are added to shelfIt. One title at a time: poster, title/year, and the shared
// watch-status selector pre-filled with the sync's proposal. Arrows and swipe
// (shared gesture) navigate; a fixed confirm button commits every reviewed
// status at once. Closing without confirming discards the discoveries.

import { api } from './api.js';
import { navigate } from './router.js';
import { el, icons, poster, toast, lockScroll, unlockScroll, setLabel, lucideIcon } from './ui.js';
import { attachSwipe } from './swipe.js';
import { createStatusSelect } from './statusSelect.js';
import { t } from './i18n.js';

const NEXT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';

let reviewOpen = false;
let waiting = false;

function isPopupOpen() {
  return !!document.querySelector('.modal-backdrop');
}

// Defer an action until every open popup has closed (checked periodically).
function waitForPopupClose(cb) {
  if (waiting) return;
  waiting = true;
  const timer = setInterval(() => {
    if (!isPopupOpen()) {
      clearInterval(timer);
      waiting = false;
      cb();
    }
  }, 600);
}

// Claim discoveries stashed by the scheduled sync and raise the review card.
// If another popup is open, wait until it closes first (never stack on top).
export async function openKodiReviewFromPending() {
  if (reviewOpen || waiting) return;
  if (isPopupOpen()) {
    waitForPopupClose(openKodiReviewFromPending);
    return;
  }
  let data;
  try {
    data = await api.kodiSyncClaim();
  } catch {
    return;
  }
  const discoveries = (data && data.discoveries) || [];
  if (!discoveries.length) return;
  // Another popup (a loan from a member) may have opened while the claim was in
  // flight: the claimed titles then wait for it to close.
  if (isPopupOpen()) waitForPopupClose(() => openKodiReview(discoveries));
  else openKodiReview(discoveries);
}

function summaryText(nMovies, nShows) {
  const parts = [];
  if (nMovies) parts.push(t('kodiSync.movies', { n: nMovies }));
  if (nShows) parts.push(t('kodiSync.series', { n: nShows }));
  const list = parts.join(t('kodiSync.and'));
  return t('kodiSync.summary', { list });
}

export function openKodiReview(discoveries) {
  if (reviewOpen || !discoveries || !discoveries.length) return;
  reviewOpen = true;

  const items = discoveries.map((d) => ({
    ...d,
    status: d.proposed_status || 'plan_to_watch',
  }));
  let index = 0;
  // Confirm is gated on having navigated at least once — unless there's only one
  // title, where navigation is impossible and gating would trap the user.
  let hasNavigated = items.length <= 1;
  const animating = false;

  // --- Modal shell (own close so we can reset state + play an exit anim) ---
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal ksync-modal' });
  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  let closing = false;
  function close() {
    if (closing) return;
    closing = true;
    backdrop.classList.add('ksync-closing');
    setTimeout(() => {
      backdrop.remove();
      unlockScroll();
      reviewOpen = false;
    }, 320); // > --dur-medium so the exit finishes before the node goes
  }

  const nMovies = items.filter((i) => i.type === 'movie').length;
  const nShows = items.length - nMovies;

  const head = el('div', { class: 'ksync-head' }, [
    el('div', { class: 'ksync-heading', text: t('kodiSync.heading') }),
    el('button', {
      class: 'icon-btn ksync-close',
      html: icons.close,
      'aria-label': t('common.close'),
      onClick: close,
    }),
  ]);
  const summary = el('div', { class: 'ksync-summary', text: summaryText(nMovies, nShows) });

  const cardHost = el('div', { class: 'ksync-cardhost' });
  const prevBtn = el('button', {
    class: 'ksync-arrow ksync-prev',
    html: icons.back,
    'aria-label': t('kodiSync.previous'),
    onClick: () => go(-1),
  });
  const nextBtn = el('button', {
    class: 'ksync-arrow ksync-next',
    html: NEXT_ICON,
    'aria-label': t('kodiSync.next'),
    onClick: () => go(1),
  });
  const stage = el('div', { class: 'ksync-stage' }, [prevBtn, cardHost, nextBtn]);
  const progress = el('div', { class: 'ksync-progress' });

  const confirmLabel = el('span');
  const confirmBtn = el('button', { class: 'btn btn-primary ksync-confirm' }, [
    lucideIcon('plus', 'btn-lucide'),
    confirmLabel,
  ]);
  const footer = el('div', { class: 'ksync-footer' }, [confirmBtn]);

  modal.append(head, summary, stage, progress, footer);

  function renderControls() {
    progress.textContent = `${index + 1} / ${items.length}`;
    prevBtn.disabled = index === 0;
    nextBtn.disabled = index === items.length - 1;
    confirmLabel.textContent = t('kodiSync.addTitles', { n: items.length });
    confirmBtn.disabled = !hasNavigated;
  }

  function buildCard() {
    const it = items[index];
    const posterEl = poster(it.poster_url, it.title);
    posterEl.classList.add('ksync-poster');
    const meta = el('div', { class: 'ksync-meta' }, [
      el('div', { class: 'ksync-name', text: it.title }),
      el('div', { class: 'ksync-year', text: it.year ? String(it.year) : '' }),
    ]);
    // Same watch-status component as the detail page; local-only here (committed
    // on confirm), pre-filled with the sync's proposal.
    const statusSel = createStatusSelect({
      status: it.status,
      onSelect: (key) => {
        it.status = key;
      },
    });
    const card = el('div', { class: 'ksync-card' }, [posterEl, meta, statusSel.element]);
    attachSwipe(card, {
      isBlocked: () => animating,
      onStart: () => {
        card.style.transition = 'none';
      },
      onMove: (dx) => {
        const rot = Math.max(-8, Math.min(8, dx * 0.03));
        card.style.transform = `translateX(${dx}px) rotate(${rot}deg)`;
        card.style.opacity = String(Math.max(0.5, 1 - Math.abs(dx) / window.innerWidth));
      },
      onRest: () => {
        card.style.transition = '';
        card.style.transform = '';
        card.style.opacity = '';
      },
      onSwipe: (dir) => {
        // Swipe right → previous, swipe left → next.
        card.style.transition = '';
        go(dir === 1 ? -1 : 1);
      },
    });
    return card;
  }

  function mount() {
    cardHost.replaceChildren(buildCard());
    renderControls();
  }

  function go(delta) {
    const target = index + delta;
    if (target < 0 || target >= items.length) {
      // Swiped past an edge — snap the current card back to centre.
      const cur = cardHost.firstElementChild;
      if (cur) {
        cur.style.transition = '';
        cur.style.transform = '';
        cur.style.opacity = '';
      }
      return;
    }
    index = target;
    hasNavigated = true;
    mount();
  }

  async function commit() {
    confirmBtn.disabled = true;
    setLabel(confirmBtn, t('kodiSync.adding'));
    try {
      await api.kodiSyncCommit(
        items.map((i) => ({ tmdb_id: i.tmdb_id, type: i.type, status: i.status }))
      );
    } catch (err) {
      confirmBtn.disabled = false;
      renderControls();
      toast(err.message || t('kodiSync.addFailed'), 'bad');
      return;
    }
    close();
    toast(t('kodiSync.added'), 'ok');
    navigate(location.pathname, { replace: true }); // refresh whatever is visible
  }
  confirmBtn.addEventListener('click', commit);

  lockScroll();
  document.body.append(backdrop);
  mount();
}
