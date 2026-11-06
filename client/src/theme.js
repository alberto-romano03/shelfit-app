// Theme: 'system' (follow the OS), 'dark' or 'light', persisted in localStorage.
// 'system' leaves <html> with no data-theme attribute and lets the CSS decide via
// prefers-color-scheme; an explicit choice stamps data-theme so it wins over the OS.

const KEY = 'shelfit-theme';
const THEMES = ['system', 'dark', 'light'];

export function currentTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.includes(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

// The palette a given choice actually resolves to right now (system asks the OS).
function resolved(theme) {
  if (theme !== 'system') return theme;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

// The palette currently on screen ('light' or 'dark'), with system resolved. Use
// this to reflect the *effective* appearance (e.g. the cover's quick-toggle icon).
export function resolvedTheme() {
  return resolved(currentTheme());
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme'); // system → let the media query decide
  paintChrome();
}

// The status bar, which a sheet's scrim can't reach. The dimmed values are the page
// colours under the same rgba(0, 0, 0, 0.6) as .modal-backdrop.
let chromeDim = false;
function paintChrome() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const light = resolved(currentTheme()) === 'light';
  meta.setAttribute('content', chromeDim ? (light ? '#626262' : '#040404') : light ? '#f5f5f5' : '#0a0a0a');
}
export function setChromeDim(on) {
  chromeDim = !!on;
  paintChrome();
}

export function setTheme(theme) {
  const next = THEMES.includes(theme) ? theme : 'system';
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode — applies for this session only */
  }
  applyTheme(next);
  return next;
}

// The new theme spreads in a circle from `origin` ({ x, y }, where it was tapped), through
// the browser's own page transition. Anything that can't do that simply switches. `onStart`
// runs as the new look starts to show.
export function revealTheme(theme, origin, onStart) {
  const started = () => {
    if (onStart) onStart();
    onStart = null;
  };
  const same = resolved(theme) === resolved(currentTheme());
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (same || still || !origin || typeof document.startViewTransition !== 'function') {
    const set = setTheme(theme);
    queueMicrotask(started);
    return set;
  }
  const root = document.documentElement;
  root.classList.add('theme-reveal');
  const change = document.startViewTransition(() => setTheme(theme));
  change.ready
    .then(() => {
      started();
      const r = Math.hypot(
        Math.max(origin.x, innerWidth - origin.x),
        Math.max(origin.y, innerHeight - origin.y)
      );
      root.animate(
        { clipPath: [`circle(0px at ${origin.x}px ${origin.y}px)`, `circle(${r}px at ${origin.x}px ${origin.y}px)`] },
        { duration: 600, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)' }
      );
    })
    .catch(started);
  change.finished.finally(() => root.classList.remove('theme-reveal'));
  return theme;
}

// Quick two-way flip for the Home cover button: pin the opposite of whatever is
// showing right now (so from 'system' it commits to an explicit light/dark).
export function toggleTheme(origin, onStart) {
  const next = resolved(currentTheme()) === 'light' ? 'dark' : 'light';
  revealTheme(next, origin, onStart);
  return next;
}

export function initTheme() {
  applyTheme(currentTheme());
  // Keep 'system' in sync when the OS flips light/dark while the app is open.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (currentTheme() === 'system') applyTheme('system');
    });
  }
}
