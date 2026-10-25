// Rate-O-Matic — a swipeable rater for watched-but-unrated titles. Presented in
// the same bottom-sheet modal as "Back to the Shelf" (openModal). Two cards are
// shown at once: the front one (interactive) and the next one peeking out behind
// at a casual angle. Each card IS its poster (full bleed, title on a bottom
// scrim). One rating row sits fixed under the deck and always rates the front
// card; dragging stamps the card with what letting go will do (save the rating,
// or skip). Swiping the front card away commits it and the card behind comes
// forward while a fresh one drops in behind.
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

// The front card nearly upright, the one behind just askew (random sign), so the
// deck reads as posters on a table without ever looking chaotic.
function makeAngles() {
  const dir = Math.random() < 0.5 ? -1 : 1;
  return { front: rand(-1.5, 1.5), back: dir * rand(4, 7) };
}

export function openRateOMatic() {
  openModal((modal, close) => {
    modal.classList.add('rom-modal');
    // The plain <h3> every popup uses, with the session's "n / N" on the right.
    const counter = el('span', { class: 'rom-count' });
    const head = el('div', { class: 'rom-head' }, [
      el('h3', { class: 'rom-brand', text: 'Rate-O-Matic' }),
      counter,
    ]);
    const stage = el('div', { class: 'rom-stage' });
    // The one rating row, under the deck (filled per front card by the session).
    const rateHost = el('div', { class: 'rom-rate' });
    const footer = el('div', { class: 'rom-footer' }, [
      el('button', { class: 'btn btn-secondary', onClick: close }, [
        lucideIcon('x', 'btn-lucide'),
        el('span', { text: t('common.cancel') }),
      ]),
    ]);
    modal.append(head, stage, rateHost, footer);
    runSession({ stage, close, footer, counter, rateHost });
  }, { handle: true });
}

function runSession({ stage, close, footer, counter, rateHost }) {
  let queue = [];
  let index = 0; // queue position of the current front card
  let ratedCount = 0;
  const skipped = [];
  let stack = null;
  let frontCard = null;
  let backCard = null;
  let animating = false;
  let ctrl = null; // the rating row, rebuilt for each front card

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

  // The deck's own chrome (rating row, counter, Cancel) shows only while there
  // are cards to rate.
  function setDeckChrome(on) {
    footer.style.display = on ? '' : 'none';
    rateHost.style.display = on ? '' : 'none';
    if (!on) counter.textContent = '';
  }

  function showLoading() {
    // Shared app loader: the rotating disc + a random loading phrase.
    stage.replaceChildren(spinner({ compact: true }));
  }
  function showError() {
    setDeckChrome(false); // its own Close button below
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

  // A card is the poster itself, full bleed, with the type, title and year on a
  // bottom scrim, the drag stamp, and a veil that dims it while it waits behind.
  function buildCard(title) {
    const posterEl = poster(title.poster_url, title.title);
    posterEl.classList.add('rom-poster');
    const stamp = el('div', { class: 'rom-stamp' });
    const card = el('div', { class: 'rom-card' }, [
      posterEl,
      el('div', { class: 'rom-scrim' }),
      el('div', { class: 'rom-info' }, [
        el('div', { class: 'rom-type', text: t(title.type === 'movie' ? 'media.movie' : 'media.tvSeries') }),
        el('div', { class: 'rom-title', text: title.title }),
        title.year ? el('div', { class: 'rom-year', text: String(title.year) }) : null,
      ]),
      stamp,
      el('div', { class: 'rom-veil' }),
    ]);
    const a = makeAngles();
    card._title = title;
    card._stamp = stamp;
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
      : `translateY(-14px) scale(0.92) rotate(${card._rotBack}deg)`;
  }

  // The rating row belongs to the front card: rebuilt, fresh, each time a new
  // card comes forward. The shared controls only animate locally here (stars,
  // phrase, heart wobble); the save happens on swipe.
  function bindControls(card) {
    ctrl = createRatingControls({
      rating: null,
      favorite: card._title.favorite,
      onRate: async () => {},
      onFavorite: async () => {},
    });
    rateHost.replaceChildren(ctrl.element);
    counter.textContent = `${index + 1} / ${queue.length}`;
  }

  // What letting go will do, stamped across the card as it is dragged: save the
  // rating it carries, or skip. It fades in with the drag distance.
  function paintStamp(card, dx) {
    const r = ctrl.getRating();
    const stamp = card._stamp;
    stamp.className = 'rom-stamp ' + (r ? 'is-save' : 'is-skip');
    stamp.replaceChildren(
      ...(r
        ? [el('span', { class: 'rom-stamp-star', html: starSvg(true) }), el('span', { text: `${r} · ${t('rom.save')}` })]
        : [el('span', { text: t('rom.skip') })])
    );
    stamp.style.opacity = String(Math.min(1, Math.abs(dx) / 90));
    stamp.style.transform = `translate(-50%, -50%) rotate(${dx > 0 ? -8 : 8}deg)`;
  }

  function mount() {
    setDeckChrome(true); // restored if returning from the completion screen
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
    bindControls(frontCard);
    activateFront(frontCard);
  }

  // Save whatever rating / favourite the row holds for this card. Returns true
  // if a star rating was assigned (→ rated, not skipped).
  function commitCard(card) {
    const rating = ctrl.getRating();
    const favorite = ctrl.getFavorite();
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
    attachSwipe(card, {
      threshold: Math.min(140, window.innerWidth * 0.28),
      isBlocked: () => animating,
      onStart: () => {
        card.style.transition = 'none';
      },
      onMove: (dx, dy) => {
        const rot = card._rotFront + Math.max(-14, Math.min(14, dx * 0.05));
        card.style.transform = `translate(${dx}px, ${dy * 0.2}px) rotate(${rot}deg)`;
        paintStamp(card, dx);
      },
      onRest: () => {
        card.style.transition = '';
        card.style.transform = `rotate(${card._rotFront}deg)`; // snap back to rest angle
        card._stamp.style.opacity = '0';
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
    card.style.transform = `translate(${offX}px, 30px) rotate(${dir * 20}deg)`;
    card.style.opacity = '0';

    index++;
    const promoted = backCard;
    if (promoted) {
      promoted.style.transition = ''; // use the card's default transition
      positionCard(promoted, true); // rotation smooths to front, veil fades away
      bindControls(promoted); // a fresh rating row for the card now in front
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
    setDeckChrome(false); // Done/skipped actions replace it
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
