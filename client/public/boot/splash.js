// The splash's exit (index.html, end of <body>): a file of its own so the
// Content-Security-Policy needs no inline script.
// Dismiss the splash when the suck animation ends (with a safety fallback).
// Runs independently of the app bundle so it never blocks or waits on it:
// image preloading runs in the background and does NOT hold the splash.
(function () {
  // Resume: the splash is already hidden via CSS, nothing to animate or
  // dismiss, so skip straight past it (the app paints directly behind).
  if (document.documentElement.classList.contains('app-resume')) return;
  var s = document.getElementById('splash');
  // No splash element to wait on (it was already torn down): release the
  // app immediately rather than leaving it gated forever.
  if (!s) {
    document.documentElement.classList.add('app-revealed');
    return;
  }
  var done = false;
  // Fade + remove the anti-flash overlay only after the splash has fully
  // left, so the transition goes splash → solid colour → ready app with no
  // navbar flash in between. The app bundle has already mounted behind it.
  function clearFlash() {
    var f = document.getElementById('app-flash');
    if (!f) return;
    f.classList.add('flash-hide');
    setTimeout(function () {
      if (f.parentNode) f.parentNode.removeChild(f);
    }, 260);
  }
  function hide() {
    if (done) return;
    done = true;
    // Reveal the app UNDER the still-opaque anti-flash overlay, so it is
    // painted and settled by the time that overlay fades.
    document.documentElement.classList.add('app-revealed');
    s.classList.add('splash-hide');
    setTimeout(function () {
      if (s.parentNode) s.parentNode.removeChild(s);
      clearFlash();
    }, 280);
  }
  var reduce =
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var logo = s.querySelector('.splash-logo');
  if (!reduce && logo) {
    logo.addEventListener('animationend', hide);
  }
  setTimeout(hide, reduce ? 500 : 1500);
})();

