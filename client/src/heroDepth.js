// Backdrop depth for browsers that can't run it from CSS.
//
// A page's backdrop (.detail-hero: title, preview, collection, list and person
// pages; Home's profile cover) moves at half the page's speed and fades as you
// scroll. styles.css drives that with a scroll-driven animation (hero-depth);
// browsers without `animation-timeline` (iOS Safari before 26) leave the
// backdrop still. Here the
// same motion is painted from the scroll position instead: over the first 480px
// the backdrop slides down 240px and fades to 35%, as the keyframes do.
// Nothing runs where CSS already does it, and nothing moves with reduced motion.

const RANGE = 480; // px of scroll the motion spans (animation-range: 0 480px)
const SHIFT = 240; // px the backdrop travels down at the end of it
const FADE_TO = 0.35; // its opacity at the end

export function initHeroDepth() {
  const css = typeof CSS !== 'undefined' && CSS.supports;
  if (css && CSS.supports('animation-timeline: scroll()')) return;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  // Lets the page slide over the backdrop (see .hero-depth-js in styles.css).
  document.documentElement.classList.add('hero-depth-js');

  let queued = false;
  function paint() {
    queued = false;
    const p = still.matches ? 0 : Math.min(1, Math.max(0, window.scrollY / RANGE));
    // Only the shown page's backdrops; a skeleton's ghost hero stays put.
    for (const hero of document.querySelectorAll('.detail-hero:not(.skeleton), .profile-cover')) {
      hero.style.translate = p ? `0 ${(p * SHIFT).toFixed(1)}px` : '';
      hero.style.opacity = p ? (1 - p * (1 - FADE_TO)).toFixed(3) : '';
    }
  }
  function queue() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(paint);
  }
  window.addEventListener('scroll', queue, { passive: true });
  still.addEventListener('change', queue);
}
