// Rate-O-Matic — a swipeable rater for watched-but-unrated titles. Presented in
// the same bottom-sheet modal as "Back to the Shelf" (openModal). Two poster
// cards are shown at once — the foreground (interactive) and one background card
// tossed at a different casual angle. Swiping the front card away commits its
// rating (if any) and the background card animates forward into its place while
// a fresh card drops in behind.
//
// All swipe physics are native pointer events + CSS transforms — no libraries.

import { api } from './api.js';
import { el, poster, starSvg, toast, openModal, spinner, lucideIcon } from './ui.js';
import { createRatingControls } from './ratingControls.js';
import { attachSwipe } from './swipe.js';
import { haptic } from './haptic.js';
import { t } from './i18n.js';

// Fisher–Yates shuffle (used when restarting with skipped titles; the initial
// queue is already randomised by the server).
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const rand = (min, max) => Math.random() * (max - min) + min;

// A small upright-ish angle for the front card and a distinctly bigger angle
// (random sign) for the background card — "dropped on a table", never symmetric.
function makeAngles() {
  const dir = Math.random() < 0.5 ? -1 : 1;
  return { front: rand(-3, 3), back: dir * rand(8, 15) };
}

export function openRateOMatic() {
  openModal((modal, close) => {
    modal.classList.add('rom-modal');
    // No top-right cross — closing lives in the footer, matching the other
    // sheet-style modals (receipt, episode note, status selector).
    // Plain left-aligned title — the same <h3> every other popup uses. The star
    // that used to sit beside it is the rating control's glyph; on the header it
    // read as a second brand mark.
    const head = el('div', { class: 'rom-head' }, [
      el('h3', { class: 'rom-brand', text: 'Rate-O-Matic' }),
    ]);
    const stage = el('div', { class: 'rom-stage' });
    const footer = el('div', { class: 'rom-footer' }, [
      el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.cancel') }),
    ]),
    ]);
    modal.append(head, stage, footer);
    runSession(stage, close, footer);
  }, { handle: true });
}

function runSession(stage, close, footer) {
  let queue = [];
  let index = 0; // queue position of the current front card
  let ratedCount = 0;
  const skipped = [];
  let stack = null;
  let frontCard = null;
  let backCard = null;
  let animating = false;

  showLoading();
  api
    .unrated()
    .then((data) => {
      queue = data.titles || [];
      index = 0;
      if (!queue.length) return showComplete();
      mount();
    })
    .catch(() => showError());

  function showLoading() {
    // Shared app loader: the rotating disc + a random loading phrase.
    stage.replaceChildren(spinner({ compact: true }));
  }
  function showError() {
    if (footer) footer.style.display = 'none'; // its own Close button below
    stage.replaceChildren(
      el('div', { class: 'rom-note' }, [
        el('div', { class: 'rom-done-title', text: t('rom.errorTitle') }),
        el('div', { class: 'rom-done-sub', text: t('rom.errorSub') }),
        el('button', { class: 'btn btn-primary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.close') }),
    ]),
      ])
    );
  }

  // Build a card: poster + title/year + the shared rating controls (which update
  // and animate locally; the actual save happens on swipe). A veil dims it while
  // it sits in the background. Each card carries its own front/back rest angles.
  function buildCard(title) {
    const posterEl = poster(title.poster_url, title.title);
    posterEl.classList.add('rom-poster');
    const meta = el('div', { class: 'rom-meta' }, [
      el('div', { class: 'rom-title', text: title.title }),
      el('div', { class: 'rom-year', text: title.year ? String(title.year) : '' }),
    ]);
    const ctrl = createRatingControls({
      rating: null,
      favorite: title.favorite,
      onRate: async () => {}, // no-op → UI + phrase animation; saved on swipe
      onFavorite: async () => {}, // no-op → UI + heart wobble; saved on swipe
    });
    const veil = el('div', { class: 'rom-veil' });
    const card = el('div', { class: 'rom-card' }, [posterEl, meta, ctrl.element, veil]);
    const a = makeAngles();
    card._title = title;
    card._ctrl = ctrl;
    card._rotFront = a.front;
    card._rotBack = a.back;
    return card;
  }

  function positionCard(card, isFront) {
    card.classList.toggle('rom-front', isFront);
    card.classList.toggle('rom-back', !isFront);
    card.style.opacity = '';
    card.style.zIndex = isFront ? '2' : '1';
    card.style.transform = isFront
      ? `rotate(${card._rotFront}deg)`
      : `translateY(-10px) scale(0.93) rotate(${card._rotBack}deg)`;
  }

  function mount() {
    if (footer) footer.style.display = ''; // restored if returning from complete
    stack = el('div', { class: 'rom-stack' });
    stage.replaceChildren(stack);
    frontCard = buildCard(queue[index]);
    backCard = queue[index + 1] ? buildCard(queue[index + 1]) : null;
    if (backCard) {
      stack.append(backCard);
      positionCard(backCard, false);
    }
    stack.append(frontCard);
    positionCard(frontCard, true);
    activateFront(frontCard);
  }

  // Save whatever rating / favourite the user set on this card. Returns true if a
  // star rating was assigned (→ rated, not skipped).
  function commitCard(card) {
    const rating = card._ctrl.getRating();
    const favorite = card._ctrl.getFavorite();
    const patch = {};
    if (rating != null) patch.rating = rating;
    if (favorite !== card._title.favorite) patch.favorite = favorite;
    if (Object.keys(patch).length) {
      api.updateMedia(card._title.id, patch).catch(() => toast(t('rom.saveError'), 'bad'));
    }
    return rating != null;
  }

  // ---- Swipe physics (shared gesture helper) ----
  function activateFront(card) {
    if (card._active) return;
    card._active = true;
    // The card follows the finger; a real drag can end over a star/heart, so the
    // shared helper swallows that click and never rates by accident.
    attachSwipe(card, {
      threshold: Math.min(140, window.innerWidth * 0.28),
      isBlocked: () => animating,
      onStart: () => {
        card.style.transition = 'none';
      },
      onMove: (dx, dy) => {
        const rot = card._rotFront + Math.max(-18, Math.min(18, dx * 0.06));
        card.style.transform = `translate(${dx}px, ${dy * 0.25}px) rotate(${rot}deg)`;
        card.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / window.innerWidth));
      },
      onRest: () => {
        card.style.transition = '';
        card.style.transform = `rotate(${card._rotFront}deg)`; // snap back to rest angle
        card.style.opacity = '';
      },
      onSwipe: (dir) => {
        haptic(); // a tick as the poster leaves the deck (Android; iOS has no swipe haptic)
        card.style.transition = '';
        flyOut(card, dir);
      },
    });
  }

  // Fly the front card off, commit it, and (in parallel) bring the background
  // card forward while a fresh card drops in behind it.
  function flyOut(card, dir) {
    if (animating) return;
    animating = true;

    const wasRated = commitCard(card);
    if (wasRated) ratedCount++;
    else skipped.push(card._title);

    card.style.zIndex = '3';
    const offX = dir >= 0 ? window.innerWidth + 140 : -(window.innerWidth + 140);
    card.style.transition = 'transform 0.4s ease-in, opacity 0.4s ease-in';
    card.style.transform = `translate(${offX}px, 30px) rotate(${dir * 24}deg)`;
    card.style.opacity = '0';

    index++;
    const promoted = backCard;
    if (promoted) {
      promoted.style.transition = ''; // use the card's default transition
      positionCard(promoted, true); // rotation smooths to front, veil fades away
    }
    // Drop a fresh background card behind, already at its own random angle.
    const nextTitle = queue[index + 1];
    backCard = nextTitle ? buildCard(nextTitle) : null;
    if (backCard) {
      if (promoted) stack.insertBefore(backCard, promoted);
      else stack.append(backCard);
      positionCard(backCard, false);
      backCard.style.opacity = '0';
      const enter = backCard;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          enter.style.opacity = '';
        })
      );
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      card.removeEventListener('transitionend', finish);
      card.remove();
      frontCard = promoted;
      animating = false;
      if (!frontCard) return showComplete();
      activateFront(frontCard);
    };
    card.addEventListener('transitionend', finish);
    setTimeout(finish, 540); // safety net if transitionend is missed
  }

  // ---- Completion ----
  function restart() {
    queue = shuffle(skipped.slice());
    skipped.length = 0;
    index = 0;
    mount();
  }

  function showComplete() {
    if (footer) footer.style.display = 'none'; // Done/skipped actions replace it
    const count = t('rom.ratedTonight', { n: ratedCount });
    // Design-system modal button row. Two buttons stack (the "Rate N skipped
    // titles" secondary is too long to sit beside Done in a side-by-side row);
    // the common single "Done" case is a normal full-width primary.
    const actions = el('div', {
      class: 'modal-actions' + (skipped.length ? ' modal-actions--stack' : ''),
    });
    if (skipped.length) {
      actions.append(
        el('button', { class: 'btn btn-secondary', onClick: restart }, [
          lucideIcon('star', 'btn-lucide'),
          el('span', {
            text: t('rom.rateSkipped', { n: skipped.length }),
          }),
        ])
      );
    }
    actions.append(el('button', { class: 'btn btn-primary', onClick: close }, [
      lucideIcon('check', 'btn-lucide'),
      el('span', { text: t('common.done') }),
    ]));

    stage.replaceChildren(
      el('div', { class: 'rom-done' }, [
        el('div', { class: 'rom-done-badge', html: starSvg(true) }),
        el('div', { class: 'rom-done-title', text: t('rom.doneTitle') }),
        el('div', {
          class: 'rom-done-sub',
          text: t('rom.doneSub'),
        }),
        el('div', { class: 'rom-done-count', text: count }),
        actions,
      ])
    );
  }
}
