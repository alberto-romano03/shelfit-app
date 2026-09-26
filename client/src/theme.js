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
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved(theme) === 'light' ? '#f5f5f5' : '#0a0a0a');
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

// Quick two-way flip for the Home cover button: pin the opposite of whatever is
// showing right now (so from 'system' it commits to an explicit light/dark).
export function toggleTheme() {
  return setTheme(resolved(currentTheme()) === 'light' ? 'dark' : 'light');
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
