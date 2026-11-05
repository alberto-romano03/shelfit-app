// What the phone's back gesture does while a sheet is open: it closes the sheet, and
// nothing else moves.
//
// Chrome answers the back gesture through CloseWatcher, with no history entry at all, so
// the history stack stays exactly as it was (the same watcher gives Esc on a desktop).
// Where there is no CloseWatcher, or for a browser's own Back button, the popstate has
// already moved the URL: close the sheet and put the page's entry back, without rendering.
//
// The status bar follows the scrim too: the sheet's scrim stops at the top of the page,
// and the bar above it stays lit unless theme-color dims with it.

import { setChromeDim } from './theme.js';

const open = [];
let page = null;

const here = () => location.pathname + location.search + location.hash;

// Call once a sheet is on screen. Returns what to call when it starts to close.
export function trackSheet(close) {
  if (!open.length) {
    page = { state: history.state, url: here() };
    setChromeDim(true);
  }
  const entry = { close, watcher: null };
  if (typeof CloseWatcher === 'function') {
    try {
      entry.watcher = new CloseWatcher();
      entry.watcher.onclose = () => close();
    } catch {
      /* the fallback below still covers Back */
    }
  }
  open.push(entry);
  return () => {
    const i = open.indexOf(entry);
    if (i === -1) return;
    open.splice(i, 1);
    if (entry.watcher) entry.watcher.destroy();
    if (!open.length) setChromeDim(false);
  };
}

// The router asks this first on every popstate. True means a sheet took it.
export function closeTopSheetOnPop() {
  if (!open.length) return false;
  const { url, state } = page;
  open[open.length - 1].close();
  if (here() !== url) history.pushState(state, '', url);
  return true;
}
