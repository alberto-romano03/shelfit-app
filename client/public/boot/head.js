// Runs in <head>, before the first paint (index.html). A file of its own, not
// inline, so the Content-Security-Policy can allow only scripts from the app's
// own origin (script-src 'self').

// Console silenced unless ?debug=1 or localStorage shelfit:debug=1.
(function () {
  try {
    var dbg = false;
    try { dbg = localStorage.getItem('shelfit:debug') === '1'; } catch (e) {}
    try { if (/[?&]debug=1(?:&|$)/.test(location.search)) dbg = true; } catch (e) {}
    if (dbg || typeof console === 'undefined' || !console) return;
    var noop = function () {};
    var methods = [
      'log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml',
      'table', 'group', 'groupCollapsed', 'groupEnd', 'count', 'countReset',
      'time', 'timeEnd', 'timeLog', 'assert', 'profile', 'profileEnd', 'clear',
    ];
    for (var i = 0; i < methods.length; i++) {
      try { console[methods[i]] = noop; } catch (e) {}
    }
  } catch (e) {}
})();


// Language, stamped before first paint. A first-paint hint only: i18n.js
// checks it against the languages it has.
try {
  var lang = localStorage.getItem('shelfit:lang');
  if (!/^[a-z]{2}$/.test(lang || '')) lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  document.documentElement.setAttribute('lang', lang);
} catch (e) {}


// Resume detection, before the splash paints: a session that already showed
// the splash is a resume (iOS reloads a standalone PWA on return), so the CSS
// hides the splash on the very first frame.
try {
  if (sessionStorage.getItem('shelfit:seen-splash')) {
    document.documentElement.classList.add('app-resume', 'app-revealed');
  }
} catch (e) {}

