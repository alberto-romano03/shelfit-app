// Backdrop depth for browsers that can't run it from CSS.
//
// A page's backdrop (.detail-hero: title, preview, collection, list and person
// pages; Home's profile cover) moves at half the page's speed and fades as you
// scroll. styles.css drives that with a scroll-driven animation (hero-depth),
// which the browser keeps in step with the scroll itself. Browsers without
// `animation-timeline` (iOS Safari before 26) leave the backdrop still, and
// there the motion can't be painted from script: iOS hands the page its scroll
// position a frame or more late, so a backdrop moved from here trails the page
// and shakes. Only the fade is painted (over the first 480px, down to 35%, as
// the keyframes do): a fade a frame late can't be seen. The backdrop scrolls
// with the page. Nothing runs where CSS already does it, and nothing changes
// with reduced motion.

const RANGE = 480; // px of scroll the fade spans (animation-range: 0 480px)
const FADE_TO = 0.35; // the backdrop's opacity at the end of it

export function initHeroDepth() {
  const css = typeof CSS !== 'undefined' && CSS.supports;
  if (css && CSS.supports('animation-timeline: scroll()')) return;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  document.documentElement.classList.add('hero-depth-js');

  let queued = false;
  function paint() {
    queued = false;
    const p = still.matches ? 0 : Math.min(1, Math.max(0, window.scrollY / RANGE));
    // Only the shown page's backdrops; a skeleton's ghost hero stays put.
    for (const hero of document.querySelectorAll('.detail-hero:not(.skeleton), .profile-cover')) {
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
