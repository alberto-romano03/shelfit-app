// Getting a new deploy onto the phone.
//
// The browser looks for a new service worker on navigations, but an installed
// PWA that is resumed rather than relaunched never navigates, so it could run an
// old build for days. Here:
//   - every return to the foreground asks for the worker again (at most every
//     few minutes); a new build installs and takes over in the background
//     (sw.js: skipWaiting + clients.claim), so the next launch is already new;
//   - the page already open keeps its old code until it is reloaded. That
//     happens on a later return to the foreground after a real absence, when the
//     user reads it as reopening the app, and never under an open sheet or while
//     typing.

import { anySheetOpen } from './sheetStack.js';

const CHECK_EVERY_MS = 5 * 60 * 1000;
const RELOAD_AFTER_AWAY_MS = 5 * 60 * 1000;

function typing() {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
}

export function watchForUpdates(registration) {
  // The very first install also takes control of the page: that is not an update.
  let replaced = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) replaced = true;
  });

  let lastCheck = Date.now();
  let hiddenAt = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (replaced && away >= RELOAD_AFTER_AWAY_MS && !anySheetOpen() && !typing()) {
      location.reload();
      return;
    }
    if (Date.now() - lastCheck >= CHECK_EVERY_MS) {
      lastCheck = Date.now();
      registration.update().catch(() => {});
    }
  });
}
