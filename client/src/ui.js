// Shared UI helpers: DOM builder, icons, formatting, modal, toast.

import { imageCache } from './imageCache.js';
import { withBase } from './basePath.js';
import { t } from './i18n.js';

// --- DOM builder ----------------------------------------------------------
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(node.style, v);
    } else {
      node.setAttribute(k, v);
    }
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// --- Icons ------------------------------------------------------------------
// The app has TWO icon mechanisms, and which one to use is a rule, not taste:
//
//   • MASKED FILES (default) — client/public/icons/lucide/*.svg applied as a CSS
//     mask by lucideIcon() below. Single-colour only (the mask throws away the
//     file's own paint), trivially tinted with background-color, kept out of the
//     JS bundle, and served cache-first by the service worker, so they are
//     offline-safe once the shell is installed. Nearly everything wants this.
//
//   • INLINE SVG (this object) — for the two cases a file cannot cover:
//       1. icons that must paint before ANY fetch can resolve. In practice that
//          is the network toast, which by definition appears when requests are
//          failing (see GLOBE_OFF_SVG / EJECT_SVG in network.js);
//       2. multi-colour artwork, which a mask would flatten — the TMDB logo goes
//          further still and ships as a plain <img>.
//
// Adding an icon: reach for a file first. Only inline it if one of those two
// applies, and say which in a comment.
export const icons = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/></svg>',
  tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M7 7l5-4 5 4"/></svg>',
  movie: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20M7 4l2 5M13 4l2 5"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/></svg>',
  // Lucide "circle-question-mark" — the header showcase re-open button. Inline
  // (not a masked file) like the other cover buttons so it paints white on the
  // dark cover scrim in BOTH themes, exactly as edit/theme do.
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="10"/></svg>',
  // --- Bottom-nav (Lucide) icons ---
  navUpcoming: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.127 21H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v5.125"/><path d="M14.62 17.8A2.25 2.25 0 1118 14.836a2.25 2.25 0 113.38 2.966l-2.626 2.856a.998.998 0 01-1.507 0z"/><path d="M16 2v3"/><path d="M3 9h18"/><path d="M8 2v3"/></svg>',
  // The shelf FRAME is one path with five subpaths, not five separate <path>
  // elements. Separate elements are rasterised and composited one after another,
  // and where two anti-aliased strokes meet, their partial coverage does not add
  // back up to a solid pixel — on a dark bar that shows as a thin dark hairline
  // across every junction, which made the glyph look assembled from tiles on iOS.
  // Subpaths of a single path are unioned before rasterising, so the frame comes
  // out as one continuous shape with no internal seams. The two boxes stay as
  // their own paths: navAnim.js drives them via :nth-child(1) and (2).
  navHome: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12V9a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3"/><path d="M16 20v-3a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v3"/><path d="M4 2v20M20 22V2M4 4h16M4 12h16M4 20h16"/></svg>',
  navSeries: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2-5 5-5-5"/><rect width="20" height="15" x="2" y="7" rx="2"/></svg>',
  // The moving clapper top (angled bar + its two diagonal stripes) is grouped so
  // the nav animation can rotate it as one unit around the left hinge; the box
  // stays static. See the nav-clap-strike keyframes in styles.css.
  navMovies: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><g class="nav-clap-top"><path d="m12.296 3.464 3.02 3.956"/><path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z"/><path d="m6.18 5.276 3.1 3.899"/></g><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>',
  trash2: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  userRoundPen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 21a8 8 0 0 1 10.821-7.487"/><path d="M21.378 16.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/><circle cx="10" cy="8" r="5"/></svg>',
  badgeX: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><line x1="15" x2="9" y1="9" y2="15"/><line x1="9" x2="15" y1="9" y2="15"/></svg>',
  imageUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21"/><path d="m14 19.5 3-3 3 3"/><path d="M17 22v-5.5"/><circle cx="9" cy="9" r="2"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  forward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  // The poster-grid half of the search results view switch (`list` is the other).
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/></svg>',
  sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.9L18 9.7l-4.2 1.8L12 16l-1.8-4.5L6 9.7l4.2-1.8z"/><path d="M18 15l.9 2.3L21 18l-2.1.7L18 21l-.9-2.3L15 18l2.1-.7z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 16H8"/><path d="M14 8H8"/><path d="M16 12H8"/><path d="M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z"/></svg>',
  // Same inline style as the icons above (24 viewBox, stroke 2, round caps).
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M6 6v14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6"/><path d="M10 11v6M14 11v6"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>',
};

// A Lucide icon as a masked span, tinted by CSS `background-color` (the mask
// discards the file's own paint, so the colour comes from the class you pass).
// `withBase` is applied here so the asset resolves under the app's sub-path.
//
// This is the ONE way to build a masked icon — it replaced seven copies of the
// same four lines scattered across Detail, Person, Season, Settings/Kodi,
// statusSelect, cinemaTicket and receipt.
export function lucideIcon(name, className = '') {
  const span = el('span', { class: className });
  const url = `url("${withBase(`/icons/lucide/${name}.svg`)}")`;
  span.style.webkitMaskImage = url;
  span.style.maskImage = url;
  return span;
}

// Type an input/textarea's placeholder out one character at a time, as if someone
// were writing it — a tiny, dependency-free typewriter. It sets the full text at
// once (no animation) when the field already has a value or the viewer prefers
// reduced motion. Otherwise typing starts when the field scrolls into view (so the
// effect is actually seen, not wasted below the fold) and stops the instant the
// user types. Returns a cleanup that halts it — register it with onCleanup.
export function typewriterPlaceholder(el, text, { speed = 55, startDelay = 320 } = {}) {
  const full = text || '';
  const reduce =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!el || reduce || !full || (el.value && el.value.length)) {
    if (el) el.placeholder = full;
    return () => {};
  }
  let timer = null;
  let io = null;
  let i = 0;
  let stopped = false;
  function halt() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (io) {
      io.disconnect();
      io = null;
    }
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    halt();
    el.removeEventListener('input', stop);
    el.placeholder = full; // settle on the complete text
  }
  function step() {
    if (stopped) return;
    i += 1;
    el.placeholder = full.slice(0, i);
    if (i >= full.length) {
      timer = null; // done — leave the full text in place
      return;
    }
    // A touch of natural rhythm: linger after a full stop, ease over spaces.
    const prev = full[i - 1];
    const delay = /[.,…!?]/.test(prev) ? 300 : prev === ' ' ? 110 : speed + Math.random() * 45;
    timer = setTimeout(step, delay);
  }
  function begin() {
    if (stopped || timer) return;
    timer = setTimeout(step, startDelay);
  }
  el.placeholder = ''; // hide the static placeholder until typing begins
  el.addEventListener('input', stop);
  if (typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          io = null;
          begin();
        }
      },
      { threshold: 0.35 }
    );
    io.observe(el);
  } else {
    begin();
  }
  return stop;
}

// --- Settings row -----------------------------------------------------------
// One shape for every line in Settings, and what sits on the right end says
// what the row does:
//
//   control: 'switch'   a boolean set right here
//   control: 'chevron'  opens or expands something
//   (omitted)           a verb — the ROW is the button, and it reports in the
//                       same trailing slot via row.busy() / row.report()
//
// This is what removed nineteen full-width button slabs from Settings. A plain
// .btn now appears only as the primary action of a flow.
//
//   settingsRow({ icon: 'moon', label: 'Dark mode', control: 'switch',
//                 checked: true, onChange: (on) => ... })
//   settingsRow({ icon: 'send', label: 'Send a test', onClick: async () => ... })
//
// `danger` gives the row the single destructive treatment used app-wide; put
// such a row last in its group, after settingsRule().
export function settingsRow(opts = {}) {
  const isSwitch = opts.control === 'switch';
  const tag = isSwitch ? 'div' : 'button';
  const node = el(tag, {
    class: 'srow' + (opts.danger ? ' srow--danger' : ''),
    type: isSwitch ? null : 'button',
  });

  node.append(lucideIcon(opts.icon || 'circle-check', 'srow-ico'));

  const main = el('div', { class: 'srow-main' }, [
    el('div', { class: 'srow-label', text: opts.label || '' }),
  ]);
  const sub = opts.sub ? el('div', { class: 'srow-sub', text: opts.sub }) : null;
  if (sub) main.append(sub);
  node.append(main);

  const end = el('div', { class: 'srow-end' });
  let input = null;
  if (isSwitch) {
    input = el('input', { type: 'checkbox' });
    input.checked = !!opts.checked;
    input.addEventListener('change', () => {
      if (opts.onChange) opts.onChange(input.checked);
    });
    end.append(el('label', { class: 'switch' }, [input, el('span', { class: 'slider' })]));
  } else if (opts.control === 'chevron') {
    end.append(lucideIcon('chevron-right', 'srow-chev'));
  } else if (opts.end) {
    // Escape hatch for list rows that carry their own actions (rename/delete,
    // revoke). Anything else belongs in one of the three cases above.
    for (const n of Array.isArray(opts.end) ? opts.end : [opts.end]) end.append(n);
  } else if (opts.value) {
    end.textContent = opts.value;
  }
  node.append(end);

  // A verb row reports where it lives: spinner while working, then a short
  // result that clears itself. No separate results block, no toast needed.
  let clearTimer = null;
  function report(text, holdMs = 2600) {
    clearTimeout(clearTimer);
    clear(end);
    end.textContent = text || '';
    if (text) clearTimer = setTimeout(() => (end.textContent = ''), holdMs);
  }
  function busy(on) {
    clearTimeout(clearTimer);
    clear(end);
    if (on) end.append(lucideIcon('refresh-cw', 'srow-spin'));
    node.disabled = !!on && tag === 'button';
  }

  if (!isSwitch && opts.onClick) {
    node.addEventListener('click', async () => {
      if (node.disabled) return;
      const r = opts.onClick({ busy, report, row: node });
      if (r && typeof r.then === 'function') {
        busy(true);
        try {
          await r;
        } finally {
          busy(false);
        }
      }
    });
  }

  return {
    el: node,
    busy,
    report,
    get checked() {
      return input ? input.checked : false;
    },
    setChecked(v) {
      if (input) input.checked = !!v;
    },
    setSub(text) {
      if (sub) sub.textContent = text;
    },
    setValue(text) {
      report(text, 0);
    },
    setOpen(open) {
      node.classList.toggle('is-open', !!open);
    },
    setDisabled(v) {
      // A switch row is a <div>, where `disabled` means nothing: dim the row and
      // disable the checkbox instead. A verb row is a real <button>.
      node.classList.toggle('is-disabled', !!v);
      if (input) input.disabled = !!v;
      else node.disabled = !!v;
    },
  };
}

// A settings group's header: the same 11px uppercase label as before, led by a
// masked glyph.
export function settingsHeader(icon, title) {
  return el('h3', {}, [lucideIcon(icon, 'settings-ico'), el('span', { text: title })]);
}

// Hairline before a group's destructive row.
export function settingsRule() {
  return el('div', { class: 'settings-rule' });
}

// The round icon action that ends a list row (revoke, delete). 36px, so it is a
// real tap target — the 13px text links it replaces were about 26px tall.
export function iconAction({ icon, label, danger = false, onClick } = {}) {
  const btn = el('button', {
    class: 'icon-act' + (danger ? ' icon-act--danger' : ''),
    type: 'button',
    'aria-label': label || '',
    title: label || null,
  }, [lucideIcon(icon, 'icon-act-ico')]);
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

// A confirm dialog in the app's own language. Replaces the native confirm()
// calls that were left in Settings and the Kodi panel — an OS dialog in the OS
// font, which is exactly what the grid filters stopped using.
export function confirmModal({ title, body, confirmLabel = t('common.delete'), onConfirm } = {}) {
  openModal((modal, close) => {
    const go = el('button', { class: 'btn btn-danger' }, [
      lucideIcon('trash-2', 'btn-lucide'),
      el('span', { text: confirmLabel }),
    ]);
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const r = onConfirm ? onConfirm() : undefined;
        if (r && typeof r.then === 'function') await r;
        close();
      } catch {
        go.disabled = false; // the caller surfaced the error; keep the dialog open
      }
    });
    modal.append(
      el('h3', { text: title || t('ui.confirm.title') }),
      body ? el('div', { class: 'muted', text: body }) : null,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.cancel') }),
    ]),
        go,
      ])
    );
  });
}

// --- Select pill ------------------------------------------------------------
// A themed trigger around a REAL <select>: the visible pill is ours, the list
// that opens is the operating system's. Tapping anywhere on the pill opens the
// native picker, so keyboard, type-ahead and screen-reader behaviour come for
// free and nothing new has to be built to scroll a long list.
//
//   const genre = selectPill({
//     label: 'Genre',
//     options: [{ value: '', text: 'All genres', short: 'All' }],
//     placeholder: 'All',
//     clearable: true,
//     onChange: (v) => { ... },
//   });
//
// `short` lets the pill show a tighter label than the option it stands for
// ("Recent" for "Recently Added") — possible only because the visible text is
// ours rather than the select's. Same overlay technique as .cine-field in
// cinemaTicket.js, which has shipped since the cinema tickets feature.
export function selectPill({
  label = '',
  options = [],
  value = '',
  placeholder = '',
  clearable = false,
  onChange,
  className = '',
} = {}) {
  const select = el('select', { class: 'selpill-select', 'aria-label': label });
  const key = el('span', { class: 'selpill-key', text: label });
  const val = el('span', { class: 'selpill-val' });
  const caret = el('span', { class: 'selpill-caret', html: icons.chevron });
  const clearBtn = el('button', {
    class: 'selpill-clear',
    type: 'button',
    'aria-label': t('ui.selectPill.clear', { label: label.toLowerCase() || t('ui.selectPill.selection') }),
    html: icons.close,
  });
  // A <label> wrapper means a tap anywhere — including on our own text, which
  // is pointer-events:none — reaches the select underneath.
  const wrap = el('label', { class: `selpill ${className}`.trim() }, [select, key, val, clearBtn, caret]);

  let shorts = {};

  function render() {
    const v = select.value;
    const picked = select.options[select.selectedIndex];
    const text = (v && (shorts[v] || (picked && picked.textContent))) || placeholder;
    val.textContent = text;
    // The accent means "this is narrowing the grid", so it belongs only to a
    // control that HAS an off state. Sort always holds a value; it would wear
    // the accent permanently otherwise.
    wrap.classList.toggle('is-set', !!v && clearable);
    clearBtn.style.display = v && clearable ? '' : 'none';
  }

  function fillOptions(list) {
    clear(select);
    shorts = {};
    for (const o of list || []) {
      select.append(el('option', { value: o.value, text: o.text }));
      if (o.short) shorts[o.value] = o.short;
    }
  }

  fillOptions(options);
  select.value = value;
  render();

  select.addEventListener('change', () => {
    render();
    if (onChange) onChange(select.value);
  });
  clearBtn.addEventListener('click', (e) => {
    // The wrapper is a <label>; without this the click would re-open the list.
    e.preventDefault();
    e.stopPropagation();
    if (!select.value) return;
    select.value = '';
    render();
    if (onChange) onChange('');
  });

  return {
    el: wrap,
    select,
    get value() {
      return select.value;
    },
    set(v) {
      select.value = v == null ? '' : v;
      render();
    },
    setOptions(list) {
      const keep = select.value;
      fillOptions(list);
      select.value = keep;
      render();
    },
  };
}

export function starSvg(filled) {
  return `<svg viewBox="0 0 24 24" class="${filled ? 'star-on' : 'star-off'}" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.8 5.9 20.4l1.5-6.8L2.2 9l6.9-.7z"/></svg>`;
}

// --- Lazy loading -----------------------------------------------------------
// Each <img> loads independently. A warm in-memory cache hit is set instantly
// (object URL, zero network); on a miss we hand the URL straight to the browser
// with native lazy + async decoding. That way every image streams in on its own
// and replaces its own skeleton the moment it decodes — nothing is batched
// behind a blob round-trip that would hold images back and pop them in all at
// once.
// Cached images are blob: URLs owned by imageCache. One can be revoked while its
// <img> sits in a page kept for later (the cache evicted it to stay in budget),
// and a browser that dropped a detached page's decoded pixels (iOS does) then
// fails to reload it on return: the image vanished and its shimmer stayed. Fall
// back once to the file's own URL instead. Returns true when it retried.
function retryWithoutBlob(img, url) {
  if (!url || img.dataset.blobRetry || !String(img.src).startsWith('blob:')) return false;
  img.dataset.blobRetry = '1';
  img.src = withBase(url);
  return true;
}

export function lazyLoad(img, url) {
  if (!url) return;
  url = withBase(url); // server emits root-absolute paths; serve under /base
  const cached = imageCache.get(url);
  if (cached) {
    img.addEventListener('error', () => retryWithoutBlob(img, url));
    img.src = cached;
    return;
  }
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = url;
}

// Fade an <img> in the moment it decodes, so it crossfades over whatever sits
// behind it (a skeleton shimmer or the surface colour) instead of hard-cutting.
// Robust to cache hits: if the image is already complete we reveal immediately,
// so a synchronously-set src never stays stuck invisible.
export function fadeInOnLoad(img) {
  img.classList.add('img-fade');
  const show = () => {
    if (img.naturalWidth > 0) img.classList.add('in');
  };
  img.addEventListener('load', show);
  if (img.complete && img.naturalWidth > 0) show();
}

// A cache-backed, lazily-loaded <img>. Props pass through to `el` (class, alt,
// style, onError, …). Crossfades in on decode.
export function cachedImg(url, props = {}) {
  const img = el('img', props);
  fadeInOnLoad(img);
  if (url) lazyLoad(img, url);
  return img;
}

// An <img> whose source is loaded through the in-memory image cache as a blob
// (object URL), exactly like setBg — the reliable path that renders even when
// the bytes come from a service-worker offline fallback. Use for the small,
// always-visible profile images (avatar/badge) so they survive a server outage.
export function cachedBlobImg(url, props = {}) {
  const img = el('img', props);
  fadeInOnLoad(img);
  if (url) {
    img.addEventListener('error', () => retryWithoutBlob(img, url));
    imageCache
      .load(url)
      .then((resolved) => {
        img.src = resolved || url;
      })
      .catch(() => {
        img.src = url;
      });
  }
  return img;
}

// --- Shared image mounting with a persistent shimmer fallback -------------
// The single place every poster/hero image goes through. The container shows
// the shimmer skeleton by default and keeps it until an image *successfully*
// decodes. On error (offline / 404 / not-yet-cached) or when there's no URL,
// the shimmer stays permanently — never a broken-image icon, empty box, or
// collapsed card (the container's own aspect-ratio holds its height).
export function mountPoster(container, url, alt, opts = {}) {
  container.classList.add('skeleton');
  if (!url) return container; // no source → stay a shimmer

  // Fast path: the poster is already in the in-memory cache. Its bytes are in RAM,
  // so show it with NO fade and drop the shimmer the instant it paints. This
  // removes the synchronized 340ms fade-in that made already-cached posters "pop
  // in together" a beat after a page/chip opened — the shimmer simply shows
  // through the (transparent) not-yet-painted img until it decodes, then it's shown.
  const hit = imageCache.get(url);
  if (hit) {
    const img = el('img', { alt: alt || '' }); // no .img-fade → opacity 1, no transition
    const show = () => container.classList.remove('skeleton');
    img.addEventListener('load', show);
    img.addEventListener('error', () => {
      if (retryWithoutBlob(img, url)) return; // a revoked cache copy: try the file
      container.classList.add('skeleton');
      if (img.parentNode) img.remove(); // keep the shimmer, never a broken icon
    });
    img.src = hit;
    container.append(img);
    // Nudge an immediate decode for single-image mounts. Callers that render MANY
    // posters at once (the grid) pass autoDecode:false and drive decoding in
    // bounded batches instead, so a big library never floods the decode pipeline
    // with hundreds of concurrent decode() calls (which stalled the visible ones
    // behind all the off-screen work).
    if (opts.autoDecode !== false && img.decode) img.decode().catch(() => {});
    if (img.complete && img.naturalWidth > 0) show(); // already decoded → instant
    return container;
  }

  // Streaming path (cache miss): fade the image in over the shimmer as it loads.
  const img = el('img', { class: 'img-fade', alt: alt || '' });
  const reveal = () => {
    if (img.naturalWidth <= 0) return;
    // The decoded image is already in the DOM; fade it in over the shimmer, then
    // stop the shimmer once the image has fully covered it (never a hard cut,
    // never a gap of emptiness between the two states).
    img.classList.add('in');
    setTimeout(() => container.classList.remove('skeleton'), 340);
  };
  img.addEventListener('load', reveal);
  // Keep the shimmer; drop the broken <img> so no broken-image icon appears.
  // Do NOT re-fetch automatically, except once from a revoked cache copy.
  img.addEventListener('error', () => {
    if (retryWithoutBlob(img, url)) return;
    container.classList.add('skeleton');
    if (img.parentNode) img.remove();
  });
  container.append(img);
  if (opts.viaCache) {
    // Load through imageCache instead of native lazy loading (cachedBlobImg's
    // path). For a set the caller is already preloading (My Tickets warms every
    // backdrop), this joins the preload's in-flight request instead of fetching
    // the same file a second time, and doesn't wait on lazy-load intersection.
    imageCache
      .load(url)
      .then((src) => {
        img.src = src || withBase(url);
      })
      .catch(() => {
        img.src = withBase(url);
      });
  } else {
    lazyLoad(img, url);
  }
  // Cache hit may have set src synchronously.
  if (img.complete && img.naturalWidth > 0) reveal();
  return container;
}

// A poster card (2:3). Shows a shimmer skeleton until its image decodes; the
// skeleton stays on error rather than collapsing or showing a broken icon.
export function poster(url, title, opts) {
  return mountPoster(el('div', { class: 'poster-card' }), url, title, opts);
}

// --- Skeleton (ghost-frame) builders --------------------------------------
export function skelLine(opts = {}) {
  const node = el('div', { class: `skeleton skel-line ${opts.cls || ''}` });
  if (opts.width) node.style.width = opts.width;
  if (opts.height) node.style.height = opts.height;
  if (opts.margin) node.style.margin = opts.margin;
  return node;
}

export function skelCard() {
  return el('div', { class: 'poster-card skeleton' });
}

export function skelGrid(n = 9) {
  const g = el('div', { class: 'grid' });
  for (let i = 0; i < n; i++) g.append(skelCard());
  return g;
}

export function placeholder(title) {
  return el('div', { class: 'poster-placeholder' }, [title || t('ui.noImage')]);
}

// A bare <img> that swaps to a text placeholder on error (for hero/backgrounds
// we set background-image instead — see setBg).
export function imgFallback(url, title, className) {
  const container = el('div', { class: className || '' });
  const img = el('img', { alt: title });
  img.addEventListener('error', () => {
    container.replaceChildren(placeholder(title));
  });
  lazyLoad(img, url);
  container.append(img);
  return container;
}

// Set a node's background-image, routed through the in-memory cache so the blob
// is reused on subsequent renders. Sets the bg only once the image is ready
// (avoids a flash), matching the previous preload behaviour.
export function setBg(node, url) {
  if (!url) return;
  imageCache
    .load(url)
    .then((resolved) => {
      node.style.backgroundImage = `url("${resolved || url}")`;
    })
    .catch(() => {
      node.style.backgroundImage = `url("${url}")`;
    });
}

// --- Formatting -----------------------------------------------------------
export function formatWatchTime(minutes, estimated) {
  const prefix = estimated ? '' : '';
  if (!minutes || minutes <= 0) return `${prefix}0h`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) {
    return `${prefix}${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${prefix}${hours}h ${mins}m`;
  }
  return `${prefix}${mins}m`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) {
    // Fall back for 'YYYY-MM-DD ...' strings.
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    return '';
  }
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function epLabel(season, episode) {
  return `S${pad2(season)} E${pad2(episode)}`;
}

// --- Toast ----------------------------------------------------------------
// A transient pill at the bottom of the screen: one glyph, one line of text.
//
//   toast('Notes saved', 'ok')   — it worked
//   toast('Could not save', 'bad') — it did not
//   toast('Enter a name')          — a notice; also the default, so every older
//                                    one-argument call still reads correctly.
//
// Two behaviours worth knowing:
//   • It leaves the way it arrived. The node is removed on animationend (with a
//     timer as the backstop) instead of disappearing in a single frame.
//   • A second toast while one is showing swaps the glyph and text IN PLACE
//     behind a 90ms crossfade, rather than replacing the element — consecutive
//     messages read as one pill changing its mind.
const TOAST_ICONS = { ok: 'circle-check', bad: 'circle-x', info: 'info' };
const TOAST_HOLD_MS = 2200;
const TOAST_SWAP_MS = 90; // must match the .toast-ico/.toast-msg transition
const TOAST_EXIT_MS = 400; // backstop > --dur-medium, in case animationend is missed

let toastNode = null;
let toastHoldTimer = null;
let toastSwapTimer = null;

function toastKindClass(kind) {
  return `toast toast--${TOAST_ICONS[kind] ? kind : 'info'}`;
}

function toastIconName(kind) {
  return TOAST_ICONS[kind] || TOAST_ICONS.info;
}

function dismissToast(node) {
  if (!node || node.dataset.leaving) return;
  node.dataset.leaving = '1';
  node.classList.add('toast-out');
  let removed = false;
  const done = () => {
    if (removed) return;
    removed = true;
    node.remove();
    if (toastNode === node) toastNode = null;
  };
  node.addEventListener('animationend', done, { once: true });
  setTimeout(done, TOAST_EXIT_MS);
}

export function toast(msg, kind = 'info') {
  clearTimeout(toastHoldTimer);
  clearTimeout(toastSwapTimer);

  if (toastNode && !toastNode.dataset.leaving) {
    // Already on screen — recolour now (the ink transitions on its own) and
    // crossfade the glyph + text to the new message.
    const node = toastNode;
    node.className = `${toastKindClass(kind)} toast-swap`;
    toastSwapTimer = setTimeout(() => {
      const ico = node.querySelector('.toast-ico');
      const url = `url("${withBase(`/icons/lucide/${toastIconName(kind)}.svg`)}")`;
      ico.style.webkitMaskImage = url;
      ico.style.maskImage = url;
      node.querySelector('.toast-msg').textContent = msg;
      node.classList.remove('toast-swap');
    }, TOAST_SWAP_MS);
  } else {
    if (toastNode) dismissToast(toastNode);
    toastNode = el('div', { class: toastKindClass(kind), role: 'status' }, [
      lucideIcon(toastIconName(kind), 'toast-ico'),
      el('span', { class: 'toast-msg', text: msg }),
    ]);
    document.body.append(toastNode);
  }

  const shown = toastNode;
  toastHoldTimer = setTimeout(() => dismissToast(shown), TOAST_HOLD_MS);
}

// --- Body scroll lock (shared by every modal / sheet) ----------------------
// While a popup is open, the page behind it must NOT scroll — on mobile the
// touch would otherwise "bleed" through to the underlying app. We simply freeze
// the document with overflow:hidden (no position change, so the popup stays
// anchored to the viewport bottom exactly as before). Chaining/rubber-band is
// stopped by overscroll-behavior on the popup itself (styles.css). A counter
// keeps nested popups correct; the scroll position is untouched.
let scrollLocks = 0;
// Block touch-scrolling of the page while a popup is open, but let the popup's
// own scroll areas (.modal / .sheet-body) still scroll. This holds on iOS where
// overflow:hidden alone leaks, without moving the body (which would un-anchor the
// bottom sheets).
function onLockTouchMove(e) {
  if (e.touches && e.touches.length > 1) return; // leave pinch-zoom alone
  const t = e.target;
  if (!t || !t.closest || !t.closest('.modal, .sheet-body')) {
    e.preventDefault();
  }
}
export function lockScroll() {
  if (scrollLocks === 0 && typeof document !== 'undefined') {
    document.documentElement.classList.add('modal-open');
    document.body.classList.add('modal-open');
    document.addEventListener('touchmove', onLockTouchMove, { passive: false });
  }
  scrollLocks += 1;
}
export function unlockScroll() {
  if (scrollLocks === 0) return;
  scrollLocks -= 1;
  if (scrollLocks === 0 && typeof document !== 'undefined') {
    document.documentElement.classList.remove('modal-open');
    document.body.classList.remove('modal-open');
    document.removeEventListener('touchmove', onLockTouchMove, { passive: false });
  }
}

// Crossfade any in-place change to an element: fade it out, apply `mutate()` at
// the midpoint, fade it back in. One primitive for both of the swaps the app
// does — a label's text, and an icon's mask-image — so neither ever hard-cuts.
//
// Re-entrant: a second call while a fade is running retargets it rather than
// stacking. Instant under reduced-motion.
//
// `label-fade` is added permanently because it carries the transition — it has
// to outlive the swap, or the fade back IN would have nothing to animate.
// `label-swap` is the momentary opacity:0.
const LABEL_SWAP_MS = 90; // half of --dur-short: out + in = one short interaction
const swapTimers = new WeakMap();

export function fadeSwap(node, mutate) {
  if (!node || typeof mutate !== 'function') return;
  const reduce =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    mutate();
    return;
  }
  clearTimeout(swapTimers.get(node));
  node.classList.add('label-fade', 'label-swap');
  swapTimers.set(
    node,
    setTimeout(() => {
      mutate();
      node.classList.remove('label-swap');
      swapTimers.delete(node);
    }, LABEL_SWAP_MS)
  );
}

// Swap an element's text with a crossfade instead of a hard cut. Used wherever a
// label reflects a STATE the user just changed — "Show more" → "Show less",
// "Set as favorite" → "Remove as favorite" — so the change reads as a change
// rather than a flicker. No-op when the text is already what was asked for.
export function setLabel(node, text) {
  if (!node) return;
  // An action button is [glyph][span] now, so writing textContent on the button
  // itself would delete the glyph. When there is a label span, that is the label.
  const target = node.querySelector(':scope > span') || node;
  const next = String(text == null ? '' : text);
  if (target.textContent === next) return;
  fadeSwap(node, () => {
    target.textContent = next;
  });
}

// --- Segmented control ------------------------------------------------------
// The design-system default for a chip-style choice between a small, fixed set
// of options (Movies / TV Shows and friends): ONE rounded track with the active
// option carried by a sliding accent chip, replacing the loose row of .chip
// buttons these selections used to be.
//
//   const seg = segmentedControl({
//     options: [['movie', 'Movies'], ['show', 'TV Shows']],
//     value: 'movie',
//     ariaLabel: 'Library type',
//     onChange: (v) => { … },
//   });
//   parent.append(seg.el);
//
// Returns { el, set(value), value(), setLabel(i, text) }. `set()` moves the chip
// WITHOUT firing onChange, for keeping the control in sync with state changed
// elsewhere; `setLabel()` rewrites one option's text in place (the search
// scopes carry their own result counts).
// Scales past two options on its own — the chip's width and travel are both
// derived from --seg-count, so nothing needs retuning.
export function segmentedControl({
  options = [],
  value,
  onChange,
  ariaLabel = t('ui.selection'),
  center = false,
}) {
  let active = Math.max(0, options.findIndex(([v]) => v === value));
  const chip = el('div', { class: 'seg-chip', 'aria-hidden': 'true' });
  // A third tuple entry is an optional Lucide glyph shown left of the label.
  const labels = [];
  const buttons = options.map(([, label, icon]) => {
    const span = el('span', { text: label });
    labels.push(span);
    return el('button', { class: 'seg-opt', type: 'button', role: 'radio' }, [
      icon ? lucideIcon(icon, 'seg-ico') : null,
      span,
    ]);
  });
  const root = el(
    'div',
    {
      class: 'seg' + (center ? ' seg--center' : ''),
      role: 'radiogroup',
      'aria-label': ariaLabel,
    },
    [chip, ...buttons]
  );
  root.style.setProperty('--seg-count', String(options.length || 1));

  function paint() {
    root.style.setProperty('--seg-i', String(active));
    buttons.forEach((b, i) => b.setAttribute('aria-checked', String(i === active)));
  }
  function pick(i, notify) {
    if (i < 0 || i >= options.length || i === active) return;
    active = i;
    paint();
    if (notify && onChange) onChange(options[active][0]);
  }
  buttons.forEach((b, i) => b.addEventListener('click', () => pick(i, true)));
  // Arrow keys move the selection, as a radio group should.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = active + (e.key === 'ArrowRight' ? 1 : -1);
    if (next < 0 || next >= options.length) return;
    pick(next, true);
    buttons[next].focus();
  });
  paint();

  return {
    el: root,
    set: (v) => pick(options.findIndex(([val]) => val === v), false),
    value: () => (options[active] ? options[active][0] : undefined),
    // Rewrite one option's text without rebuilding the control. The slots are
    // equal-width (a grid of --seg-count), so the chip does not have to move.
    setLabel: (i, text) => {
      if (labels[i]) labels[i].textContent = text;
    },
  };
}

// The SCROLLING sibling of segmentedControl(), for a single choice with more
// options than fit across the screen (the Movies/Series status filter). Same
// visual language — one rounded track, one sliding accent chip — but the track
// scrolls, and because the labels differ in width the chip is measured from the
// active button rather than derived from a count.
//
//   const bar = segmentedBar({
//     options: [['all', 'All'], ['completed', 'Shelved'], …],
//     value: 'completed',
//     dividerAfter: 'all',
//     onChange: (k) => { … },
//   });
//
// Returns { el, set(value), refresh(), optionEl(key) }. Call refresh() after
// showing or hiding options — their widths move the chip.

// Length of the two pills whose overlap is the chip (styles.css --segbar-span).
// Longer than any option plus the track's height, so their far ends never
// reach the visible chip.
const SEGBAR_SPAN = 600;

export function segmentedBar({
  options = [],
  value,
  onChange,
  ariaLabel = t('ui.selection'),
  dividerAfter = null,
}) {
  // The chip sits ABOVE the labels and carries its own dark copy of them (the
  // ink), which slides the opposite way as the chip moves. Whatever part of the
  // chip covers a label shows that label dark, frame by frame, so the text is
  // never grey on the chip or dark on the track mid-move. (The labels used to
  // fade their colour on their own timer, which never matched the chip.)
  //
  // Its size changes by moving things, never by resizing them: the chip is
  // where two long pills overlap, the outer one ending at the chip's right edge
  // (it clips the right side) and the gold one starting at its left edge (it
  // clips the left). Moving, growing or shrinking the chip only slides those
  // two, so the whole change runs off the main thread and stays smooth while a
  // page is being built (a width transition stalled there, then jumped).
  const ink = el('div', { class: 'segbar-ink' });
  const fill = el('div', { class: 'segbar-fill' }, [ink]);
  const chip = el('div', { class: 'segbar-chip', 'aria-hidden': 'true' }, [fill]);
  const root = el('div', { class: 'segbar', role: 'radiogroup', 'aria-label': ariaLabel }, [chip]);
  const byKey = {};
  const buttons = [];
  const inks = [];
  options.forEach(([key, label]) => {
    const b = el('button', { class: 'segbar-opt', type: 'button', role: 'radio', text: label });
    b.dataset.key = key;
    byKey[key] = b;
    buttons.push(b);
    root.append(b);
    const copy = el('span', { class: 'segbar-ink-label', text: label });
    inks.push(copy);
    ink.append(copy);
    if (dividerAfter && key === dividerAfter) {
      root.append(el('span', { class: 'segbar-divider', 'aria-hidden': 'true' }));
    }
  });

  let active = Math.max(0, options.findIndex(([k]) => k === value));
  // The first placement is instant: a new bar's chip would otherwise slide in
  // from the track's left edge on every page that mounts one.
  let placed = false;

  // An option's box in the track's scrolling coordinates, to the fraction of a
  // pixel (offsetLeft/Width round, which leaves the dark copies half a pixel
  // off their labels).
  function boxOf(b) {
    const r = b.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    return { x: r.left - rr.left - root.clientLeft + root.scrollLeft, w: r.width };
  }
  // Each dark copy sits exactly over its label (hidden options included).
  function layoutInk() {
    buttons.forEach((b, i) => {
      const s = inks[i].style;
      s.display = b.style.display === 'none' ? 'none' : '';
      const { x, w } = boxOf(b);
      s.left = `${x}px`;
      s.width = `${w}px`;
    });
  }
  // The chip spans [x, x + w]. Each of the three moves is linear in the same
  // eased progress, so the overlap is a true pill at x..x+w on every frame and
  // the ink stays on the labels (outer + fill = x, x + ink = 0).
  function place(x, w, instant) {
    const parts = [chip, fill, ink];
    if (instant) parts.forEach((p) => (p.style.transition = 'none'));
    chip.style.transform = `translateX(${x + w - SEGBAR_SPAN}px)`;
    fill.style.transform = `translateX(${SEGBAR_SPAN - w}px)`;
    ink.style.transform = `translateX(${-x}px)`;
    if (instant) {
      void chip.offsetWidth; // commit the placement before transitions return
      parts.forEach((p) => (p.style.transition = ''));
    }
  }

  function paint(scrollIntoView) {
    const b = buttons[active];
    if (!b) return;
    // A hidden option has no box to sit on; leave the chip where it is.
    if (b.offsetParent === null && b.offsetWidth === 0) return;
    layoutInk();
    const { x, w } = boxOf(b);
    place(x, w, !placed);
    placed = true;
    buttons.forEach((x, i) => x.setAttribute('aria-checked', String(i === active)));
    // Without this, choosing an option that sits off-screen moves the chip
    // somewhere the user cannot see. On the next frame: the choice's onChange
    // often changes the page's layout right after this (Movies -> Collections
    // swaps the grid for a list), and that cancels a smooth scroll started
    // before it, leaving the chip out of sight.
    if (scrollIntoView && typeof b.scrollIntoView === 'function') {
      requestAnimationFrame(() => {
        if (buttons[active] === b) b.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
      });
    }
  }
  function pick(i, notify, scroll) {
    if (i < 0 || i >= buttons.length || i === active) return;
    active = i;
    paint(scroll);
    if (notify && onChange) onChange(options[active][0]);
  }
  buttons.forEach((b, i) =>
    b.addEventListener('click', () => {
      if (b.disabled) return;
      pick(i, true, true);
    })
  );
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = active + (e.key === 'ArrowRight' ? 1 : -1);
    if (next < 0 || next >= buttons.length) return;
    pick(next, true, true);
    buttons[next].focus();
  });
  // Measured after layout — offsetWidth is 0 until the track is in the DOM.
  requestAnimationFrame(() => paint(false));
  // Labels measured before the web font arrived are narrower than they end up:
  // measure again once it has, so the chip and its dark copies fit.
  if (document.fonts && document.fonts.status !== 'loaded') {
    document.fonts.ready.then(() => {
      if (placed) paint(false);
    });
  }

  return {
    el: root,
    set: (v) => pick(options.findIndex(([k]) => k === v), false, false),
    refresh: () => paint(false),
    optionEl: (key) => byKey[key],
    // Where the chip is now, to hand over to another bar (see glideFrom): its
    // live position, so a hand-over in the middle of a glide (a quick second
    // tap) picks up from where the chip actually is.
    geometry() {
      if (!buttons[active]) return null;
      const outer = new DOMMatrixReadOnly(getComputedStyle(chip).transform).m41; // x + w - span
      const inner = new DOMMatrixReadOnly(getComputedStyle(fill).transform).m41; // span - w
      const w = SEGBAR_SPAN - inner;
      return { x: outer + inner, w, scrollLeft: root.scrollLeft, key: options[active][0] };
    },
    // Start the chip where another bar's chip was (its geometry()) and glide it
    // to this bar's option: Movies and Series hand their chip over this way. The
    // two bars need not hold the same options; the start is just a position.
    // Call once the bar is in the DOM.
    glideFrom(prev) {
      if (!prev) return;
      placed = true;
      root.scrollLeft = prev.scrollLeft;
      // A shorter track (fewer options) can't scroll as far and clamps: start
      // the chip where it was on screen, not where it was in the old track.
      layoutInk();
      place(prev.x - prev.scrollLeft + root.scrollLeft, prev.w, true);
      root.classList.add('segbar--glide');
      requestAnimationFrame(() => paint(true));
      setTimeout(() => root.classList.remove('segbar--glide'), 600);
    },
  };
}

// --- Modal ----------------------------------------------------------------
// Enter and exit are mirrored: the panel slides up + fades in, and on close it
// slides back down + fades out while the backdrop fades with it. The node is
// removed only once the exit animation has finished (with a timeout fallback in
// case animationend never fires), so a modal never just vanishes.
//
// `closed` guards re-entry, so closing DURING the open animation is safe: the
// exit class simply takes over from the entrance one and the removal happens
// once — no double-remove, no stuck backdrop.
// `opts.center` makes it a centered popup dialog (pops in, rounded all round)
// instead of a bottom sheet; `opts.className` adds a class to the panel.
export function openModal(buildContent, opts = {}) {
  const backdrop = el('div', { class: 'modal-backdrop' + (opts.center ? ' modal-backdrop--center' : '') });
  const modal = el('div', {
    class:
      'modal' +
      (opts.handle ? ' modal--handle' : '') +
      (opts.center ? ' modal--popup' : '') +
      (opts.className ? ` ${opts.className}` : ''),
  });
  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  let closed = false;
  let removed = false;
  function close() {
    if (closed) return;
    closed = true;
    modal.classList.add('sheet-closing');
    backdrop.classList.add('backdrop-closing');
    const done = () => {
      if (removed) return;
      removed = true;
      backdrop.remove();
      unlockScroll();
      // `opts.onClose`: told once the popup is gone, however it was closed.
      if (opts.onClose) opts.onClose();
    };
    modal.addEventListener('animationend', done, { once: true });
    setTimeout(done, 400); // fallback if animationend never fires
  }
  // The grey dash: opt-in here, always present on a sheet. Every popup that
  // reads as a bottom sheet carries it, so the dismiss gesture is the same one
  // everywhere.
  if (opts.handle) modal.append(dragHandle(close));
  buildContent(modal, close);
  lockScroll();
  document.body.append(backdrop);
  return { close, modal };
}

// The bottom-sheet drag handle — tap it, or swipe it down, to dismiss. Shared by
// openSheet and by any openModal that asks for one.
function dragHandle(close) {
  const wrap = el('div', { class: 'sheet-handle-wrap' }, [
    el('div', { class: 'sheet-handle' }),
  ]);
  let startY = null;
  wrap.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    try {
      wrap.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });
  wrap.addEventListener('pointerup', (e) => {
    if (startY !== null && e.clientY - startY > 60) close();
    startY = null;
  });
  wrap.addEventListener('click', () => {
    if (startY === null) close();
  });
  return wrap;
}

// Local calendar date as 'YYYY-MM-DD' (avoids the UTC shift of toISOString()).
function localTodayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Reusable "how many times seen" stepper modal (the series rewatch modal). A −/+
// pair adjusts a LOCAL count as much as the user likes (no request per tap); the
// number slides up/down between values. Confirm commits the final count via
// `onConfirm(count, date?)` (async; throws on failure) in one call, then closes;
// an unchanged count closes with no request. Cancel discards. When `showDate` is
// set, a native date picker sits under the stepper (default today) and its value
// is passed as the second argument — so a movie rewatch can carry a date.
//   openWatchCountModal({ title, count: 2, min: 0, showDate: true, onConfirm: async (n, date) => {…} })
export function openWatchCountModal({ title, count: startCount = 1, min = 0, confirmLabel = t('ui.confirm.label'), onConfirm, showDate = false, dateValue }) {
  return openModal((modal, close) => {
    let count = startCount;

    // The number lives in an overflow-clipped well so a change slides the old
    // value out and the new one in — up when increasing, down when decreasing.
    const numWell = el('div', { class: 'ep-count-well' });
    let numEl = el('span', { class: 'rewatch-num', text: String(count) });
    numWell.append(numEl);

    function animateTo(newVal, dir) {
      const outgoing = numEl;
      const incoming = el('span', { class: 'rewatch-num', text: String(newVal) });
      incoming.style.transform = `translateY(${dir > 0 ? '120%' : '-120%'})`;
      incoming.style.opacity = '0';
      numWell.append(incoming);
      void incoming.offsetHeight; // force a reflow so the transition runs
      outgoing.style.transform = `translateY(${dir > 0 ? '-120%' : '120%'})`;
      outgoing.style.opacity = '0';
      incoming.style.transform = 'translateY(0)';
      incoming.style.opacity = '1';
      numEl = incoming;
      setTimeout(() => outgoing.remove(), 320);
    }

    const minusBtn = el('button', { class: 'rewatch-step-btn', 'aria-label': t('ui.stepper.decrease'), html: icons.minus });
    minusBtn.addEventListener('click', () => {
      if (count <= min) return;
      count -= 1;
      animateTo(count, -1);
    });
    const plusBtn = el('button', { class: 'rewatch-step-btn', 'aria-label': t('ui.stepper.increase'), html: icons.plus });
    plusBtn.addEventListener('click', () => {
      count += 1;
      animateTo(count, +1);
    });

    // Optional date picker under the stepper (movie rewatch date).
    const dateInput = showDate
      ? el('input', { class: 'text-field', type: 'date', value: dateValue || localTodayISO() })
      : null;

    const confirmBtn = el('button', { class: 'btn btn-primary' }, [
      lucideIcon('check', 'btn-lucide'),
      el('span', { text: confirmLabel }),
    ]);
    confirmBtn.addEventListener('click', async () => {
      if (count === startCount) {
        close(); // nothing changed — no request needed
        return;
      }
      confirmBtn.disabled = true;
      try {
        if (onConfirm) await onConfirm(count, dateInput ? dateInput.value : undefined);
        close();
      } catch (err) {
        confirmBtn.disabled = false;
        toast((err && err.message) || t('ui.couldNotSave'), 'bad');
      }
    });

    const children = [];
    if (title) children.push(el('h3', { text: title }));
    children.push(el('div', { class: 'rewatch-stepper' }, [minusBtn, numWell, plusBtn]));
    if (dateInput) {
      children.push(
        el('div', { class: 'rewatch-date' }, [
          el('div', { class: 'field-label', text: t('ui.date') }),
          dateInput,
        ])
      );
    }
    children.push(
      el('hr', { class: 'status-sep' }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-secondary', onClick: close }, [
      lucideIcon('x', 'btn-lucide'),
      el('span', { text: t('common.cancel') }),
    ]),
        confirmBtn,
      ])
    );
    modal.append(...children);
  });
}

// A bottom sheet with a drag handle. Same slide-up feel as the modal, but a flex
// column so callers can keep a scrollable body and a fixed footer.
// buildContent(sheet, close) receives the sheet element.
// opts.compact → the sheet sizes to its content (capped at 90vh) instead of
// always filling ~90vh; use it for short forms like the episode-note editor.
export function openSheet(buildContent, opts = {}) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const sheet = el('div', { class: 'modal sheet' + (opts.compact ? ' sheet-compact' : '') });
  backdrop.append(sheet);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  // Dismiss with a slide-down (mirror of the slide-up entrance), then remove.
  let closing = false;
  let removed = false;
  function close() {
    if (closing) return;
    closing = true;
    sheet.classList.add('sheet-closing');
    backdrop.classList.add('backdrop-closing');
    const done = () => {
      if (removed) return;
      removed = true;
      backdrop.remove();
      unlockScroll();
    };
    sheet.addEventListener('animationend', done, { once: true });
    setTimeout(done, 400); // fallback if animationend never fires (> --dur-medium)
  }

  sheet.append(dragHandle(close));

  buildContent(sheet, close);
  lockScroll();
  document.body.append(backdrop);
  return { close, sheet };
}

// Loading phrases — one is picked at random each time a loader is shown.
const loadingPhrases = () => [
  t('ui.loadingPhrase.scratched'),
  t('ui.loadingPhrase.fingerprints'),
  t('ui.loadingPhrase.menuWait'),
  t('ui.loadingPhrase.fbiWarning'),
  t('ui.loadingPhrase.mainMenu'),
  t('ui.loadingPhrase.disc2'),
  t('ui.loadingPhrase.dontScratch'),
  t('ui.loadingPhrase.warmUp'),
  t('ui.loadingPhrase.driveSpin'),
  t('ui.loadingPhrase.specialEdition'),
];

// Loading indicator: the slowly-rotating disc logo + a random loading phrase.
// `opts.compact` drops the full-viewport min-height so it fits centred inside a
// modal / bottom sheet (used by Rate-O-Matic and My Tickets).
export function spinner(opts = {}) {
  const phrases = loadingPhrases();
  const phrase =
    phrases[Math.floor(Math.random() * phrases.length)];
  return el('div', { class: 'loader' + (opts.compact ? ' loader--compact' : '') }, [
    el('div', { class: 'loader-logo', role: 'img', 'aria-label': t('ui.loading') }),
    el('div', { class: 'loader-phrase', text: phrase }),
  ]);
}

// --- Empty / error / offline state ------------------------------------------
// One block for every "there is nothing to show here" screen. Three kinds, and
// the difference between them is the whole point: an error is marked, an
// offline state is marked differently, and a genuine empty is not marked at all
// — "nothing on this shelf yet" is not bad news.
//
//   stateBlock({ kind: 'error', title: "This season didn't load",
//                error: err.message, action: { onClick: retry } })
//   stateBlock({ title: 'This list is empty', detail: 'Add titles from any…' })
//
// `tier` picks the size: 'page' (a whole view), 'section' (a panel inside a
// working page), 'inline' (a single row, replacing a bare .muted line).
// The glyph defaults by kind and can be overridden with any file in
// public/icons/lucide.
const STATE_ICONS = { error: 'signpost', offline: 'earth', empty: 'shelving-unit' };
const STATE_TIERS = ['page', 'section', 'inline'];
const RETRY_REARM_MS = 4000;

export function stateBlock(opts = {}) {
  const kind = STATE_ICONS[opts.kind] ? opts.kind : 'empty';
  const tier = STATE_TIERS.includes(opts.tier) ? opts.tier : 'page';
  const node = el(
    'div',
    {
      class: `empty empty--${kind} empty--${tier}`,
      // Errors interrupt; an empty shelf is just the state of the page.
      role: kind === 'error' ? 'alert' : null,
    },
    [
      el('div', { class: 'empty-art' }, [
        lucideIcon(opts.icon || STATE_ICONS[kind], 'empty-ico'),
      ]),
      el('h3', { class: 'empty-title', text: opts.title || '' }),
      opts.detail ? el('p', { class: 'empty-detail', text: opts.detail }) : null,
    ]
  );

  const action = opts.action;
  if (action && typeof action.onClick === 'function') {
    const btn = el('button', { class: 'empty-act', type: 'button' }, [
      lucideIcon(action.icon || 'refresh-cw', 'empty-act-ico'),
      el('span', { text: action.label || t('ui.tryAgain') }),
    ]);
    btn.addEventListener('click', () => {
      if (btn.classList.contains('is-busy')) return;
      btn.classList.add('is-busy');
      // A retry that succeeds replaces this whole node, so nothing needs to
      // clear the flag; the timer only re-arms the button if we are still here.
      setTimeout(() => btn.classList.remove('is-busy'), RETRY_REARM_MS);
      action.onClick();
    });
    node.append(btn);
  }

  // The raw exception goes last and small: useful to whoever runs the server,
  // never the headline.
  if (opts.error) node.append(el('p', { class: 'empty-err', text: opts.error }));
  return node;
}

// Crossfade a DOM mutation (typically swapping a view's skeleton for its real
// content) using the View Transition API and the same 'fade' styling the router
// uses for navigation. `mutate` MUST be synchronous and do the whole swap
// (clear + append) so the transition snapshots skeleton→content with no frame of
// emptiness. Falls back to an instant swap where VT is unsupported or motion is
// reduced — identical end state, just no animation.
export function crossfadeSwap(mutate) {
  const reduce =
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof document.startViewTransition !== 'function' || reduce) {
    mutate();
    return;
  }
  const root = document.documentElement;
  // A transition is already running (usually the page change that mounted this
  // view, its skeleton fading in). Its incoming side is live, so the change just
  // shows up in it. Starting a second one would cut the first short: a jump to
  // its end, then another fade.
  if (root.dataset.vt) {
    mutate();
    return;
  }
  root.dataset.vt = 'fade';
  const t = document.startViewTransition(() => mutate());
  const done = () => {
    if (root.dataset.vt === 'fade') delete root.dataset.vt;
  };
  // `.ready` rejects on a skipped/aborted transition; swallow it so it isn't an
  // unhandled promise rejection.
  t.ready.catch(() => {});
  t.finished.then(done, done);
}
