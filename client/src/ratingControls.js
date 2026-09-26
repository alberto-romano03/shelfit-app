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
  // re-adding restarts the CSS animation, so changing the rating replays it.
  function setRatingPhrase(r) {
    ratingPhrase.classList.remove('rp-1', 'rp-2', 'rp-3', 'rp-4', 'rp-5');
    if (!r) {
      ratingPhrase.textContent = '';
      return;
    }
    ratingPhrase.textContent = RATING_PHRASES[r] ? t(RATING_PHRASES[r]) : '';
    void ratingPhrase.offsetWidth; // reflow → re-adding the class replays the animation
    ratingPhrase.classList.add(`rp-${r}`);
  }

  function renderStars() {
    starsWrap.innerHTML = '';
    for (let k = 1; k <= 5; k++) {
      const b = el('button', { html: starSvg(k <= (rating || 0)) });
      b.addEventListener('click', async () => {
        hapticStar(k); // Android vibrate; iOS ticks via the attachHaptic overlay
        const newRating = rating === k ? null : k;
        try {
          await onRate(newRating);
          rating = newRating;
          renderStars();
          onChange({ rating, favorite });
        } catch (err) {
          onError((err && err.message) || t('rating.couldNotSave'));
        }
      });
      attachHaptic(b); // iOS: real tap on the hidden switch ticks (click bubbles)
      starsWrap.append(b);
    }
    setRatingPhrase(rating);
  }
  renderStars();

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
    try {
      await onFavorite(next);
      favorite = next;
      renderFav();
      if (next) wobbleFav(); // wobble only when adding to favourites
      onChange({ rating, favorite });
    } catch (err) {
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
