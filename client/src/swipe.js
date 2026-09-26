// Shared horizontal-swipe gesture — native pointer events, no libraries.
//
// Extracted from Rate-O-Matic so every swipeable card UI (the rater and the
// Kodi sync review) shares one implementation. The helper only DETECTS the
// gesture (drag past a slop, follow the finger, threshold → commit, else snap
// back) and calls back; the caller decides how the element is transformed, so
// each surface keeps its own look while the physics stay identical.
//
//   onStart()          fired on pointerdown once a press begins (e.g. disable
//                      the CSS transition so the drag tracks 1:1)
//   onMove(dx, dy)     fired while dragging — apply transform/opacity here
//   onRest()           released without crossing the threshold — snap back
//   onSwipe(dir)       released past the threshold — dir: 1 = right, -1 = left
//   isBlocked()        return true to ignore new presses (e.g. mid-animation)
//
// A real drag also suppresses the next click on the element, so a swipe that
// ends over a button/star never triggers it by accident.
export function attachSwipe(el, opts = {}) {
  const {
    threshold = Math.min(140, window.innerWidth * 0.28),
    slop = 8,
    isBlocked = () => false,
    onStart,
    onMove,
    onRest,
    onSwipe,
  } = opts;

  let startX = 0;
  let startY = 0;
  let dragging = false;
  let pid = null;
  let suppressClick = false;

  el.addEventListener(
    'click',
    (e) => {
      if (suppressClick) {
        e.stopPropagation();
        e.preventDefault();
        suppressClick = false;
      }
    },
    true
  );

  function move(e) {
    if (e.pointerId !== pid) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging) {
      if (Math.abs(dx) < slop && Math.abs(dy) < slop) return;
      dragging = true;
    }
    e.preventDefault();
    if (onMove) onMove(dx, dy);
  }

  function up(e) {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    const dx = e.clientX - startX;
    if (dragging) suppressClick = true;
    if (dragging && Math.abs(dx) > threshold) {
      if (onSwipe) onSwipe(dx >= 0 ? 1 : -1);
    } else if (onRest) {
      onRest();
    }
    dragging = false;
    pid = null;
  }

  el.addEventListener('pointerdown', (e) => {
    if (isBlocked()) return;
    pid = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dragging = false;
    suppressClick = false;
    if (onStart) onStart();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}
