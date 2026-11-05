// Shared star + heart rating controls — the exact widget from the detail popup,
// including the per-level phrase entrance animations (.rp-1 … .rp-5) and the
// heart "giggle" wobble + burst ring. Persistence is delegated to the caller via
// onRate / onFavorite, so the same component (and the same animations) drives
// both the detail page and Rate-O-Matic without any change to its behaviour.
//
// opts:
//   rating      initial star rating (1..5 or null)
//   favorite    initial favourite state (bool)
//   label       optional field label above the row (omit → no label)
//   onRate      async (newRating) => persist; throw to reject (UI won't change)
//   onFavorite  async (next)      => persist; throw to reject
//   onError     (message) => void  (e.g. a toast; default no-op)
//   onChange    ({rating, favorite}) => void  (after a successful change)
//
// Returns { element, getRating, getFavorite }.

import { el, icons, starSvg } from './ui.js';
import { hapticStar, hapticFavorite, attachHaptic } from './haptic.js';
import { t } from './i18n.js';

// Keys, resolved with t() at render time.
const RATING_PHRASES = {
  1: 'rating.phrase1',
  2: 'rating.phrase2',
  3: 'rating.phrase3',
  4: 'rating.phrase4',
  5: 'rating.phrase5',
};

export function createRatingControls(opts = {}) {
  let rating = opts.rating || null;
  let favorite = !!opts.favorite;
  const onRate = opts.onRate || (async () => {});
  const onFavorite = opts.onFavorite || (async () => {});
  const onError = opts.onError || (() => {});
  const onChange = opts.onChange || (() => {});

  const starsWrap = el('div', { class: 'stars' });
  const ratingPhrase = el('div', { class: 'rating-phrase' });

  // Per-level phrase entrance: removing the level class + forcing a reflow before
  // re-adding restarts the CSS animation, so changing the rating replays it. With
  // `still` (the page just opened) it lands straight on its resting look.
  function setRatingPhrase(r, still) {
    ratingPhrase.classList.remove('rp-1', 'rp-2', 'rp-3', 'rp-4', 'rp-5');
    ratingPhrase.classList.toggle('rp-still', !!still);
    if (!r) {
      ratingPhrase.textContent = '';
      return;
    }
    ratingPhrase.textContent = RATING_PHRASES[r] ? t(RATING_PHRASES[r]) : '';
    void ratingPhrase.offsetWidth; // reflow → re-adding the class replays the animation
    ratingPhrase.classList.add(`rp-${r}`);
  }

  // `from`: the rating before this tap. The stars it adds fill left to right, ending
  // under the finger.
  function renderStars(still, from = 0) {
    starsWrap.innerHTML = '';
    for (let k = 1; k <= 5; k++) {
      const b = el('button', { html: starSvg(k <= (rating || 0)) });
      if (!still && k <= (rating || 0) && k > from) {
        b.firstElementChild.classList.add('star-sweep');
        b.firstElementChild.style.setProperty('--i', String(k - from - 1));
      }
      b.addEventListener('click', async () => {
        hapticStar(k); // Android vibrate; iOS ticks via the attachHaptic overlay
        // Paint first: the stars answer on the next frame, not after the server's
        // reply, and go back if the save fails.
        const previous = rating;
        rating = rating === k ? null : k;
        renderStars(false, previous || 0);
        try {
          await onRate(rating);
          onChange({ rating, favorite });
        } catch (err) {
          rating = previous;
          renderStars(true);
          onError((err && err.message) || t('rating.couldNotSave'));
        }
      });
      attachHaptic(b); // iOS: real tap on the hidden switch ticks (click bubbles)
      starsWrap.append(b);
    }
    setRatingPhrase(rating, still);
  }
  renderStars(true);

  const favBtn = el('button', {
    class: 'fav-btn',
    'aria-label': t('rating.favourite'),
    html: icons.heart,
  });
  function renderFav() {
    favBtn.classList.toggle('active', favorite);
    favBtn.setAttribute('aria-pressed', favorite ? 'true' : 'false');
  }
  renderFav();
  attachHaptic(favBtn); // iOS haptic on tap (bubbles to the click handler below)
  // Replay the wobble from scratch each time; the class clears itself on
  // animationend (only after the heart's own animation, not the burst ring's).
  favBtn.addEventListener('animationend', (e) => {
    if (e.animationName === 'fav-wobble') favBtn.classList.remove('fav-wobble');
  });
  function wobbleFav() {
    favBtn.classList.remove('fav-wobble');
    void favBtn.offsetWidth;
    favBtn.classList.add('fav-wobble');
  }
  favBtn.addEventListener('click', async () => {
    const next = !favorite;
    hapticFavorite(next); // medium pulse when adding, lighter when removing
    // Same as the stars: answer now, undo if the save fails.
    favorite = next;
    renderFav();
    if (next) wobbleFav(); // wobble only when adding to favourites
    try {
      await onFavorite(next);
      onChange({ rating, favorite });
    } catch (err) {
      favorite = !next;
      renderFav();
      onError((err && err.message) || t('rating.couldNotSave'));
    }
  });

  const children = [];
  if (opts.label) children.push(el('div', { class: 'field-label', text: opts.label }));
  children.push(el('div', { class: 'rating-row' }, [starsWrap, favBtn]));
  children.push(ratingPhrase);
  const element = el('div', { class: 'rating-wrap' }, children);

  return {
    element,
    getRating: () => rating,
    getFavorite: () => favorite,
  };
}
