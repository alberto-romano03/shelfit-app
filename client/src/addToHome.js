// "Add to Home Screen" helper.
//
// iOS/Safari exposes NO programmatic install — the user must go through the
// Share sheet — so on iOS this opens a short illustrated instruction sheet.
// Android/Chromium fires `beforeinstallprompt`, which we capture at startup
// (initInstallPrompt) and replay on demand for a real native install dialog.

import { el, openSheet, toast, lucideIcon } from './ui.js';
import { t } from './i18n.js';

// The captured beforeinstallprompt event (Android/desktop Chromium), if any.
let deferredPrompt = null;

// Call once at app startup so the (single, early) beforeinstallprompt event is
// captured before any Settings screen exists to consume it.
export function initInstallPrompt() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // stop Chrome's mini-infobar; we trigger it ourselves
    deferredPrompt = e;
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
  });
}

export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports as "Macintosh"; disambiguate via touch points.
  const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/.test(ua) || iPadOS;
}

// True when already launched as an installed PWA (so we can hide the entry).
export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.navigator.standalone === true || // iOS
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
  );
}

// Whether it's worth showing an "Add to Home Screen" entry at all.
export function canInstall() {
  return !isStandalone() && (isIOS() || !!deferredPrompt);
}

// The iOS Share glyph (box with an up-arrow) — recognizable from the Safari bar.
const SHARE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m8 8 4-4 4 4"/><path d="M8 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-2"/></svg>';
const PLUS_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>';

function iosStep(numberIcon, text) {
  return el('div', { class: 'a2hs-step' }, [
    el('div', { class: 'a2hs-step-ico', html: numberIcon }),
    el('div', { class: 'a2hs-step-text', html: text }),
  ]);
}

// Open the platform-appropriate flow. On Android/desktop with a captured
// prompt, trigger the native dialog; on iOS, show the Share-sheet steps.
export async function openAddToHome() {
  if (isStandalone()) {
    toast(t('a2hs.alreadyAdded'));
    return;
  }
  if (deferredPrompt) {
    try {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
    } catch {
      /* user dismissed / unsupported */
    }
    deferredPrompt = null; // a prompt can only be used once
    return;
  }
  // iOS (and any browser with no native prompt): show instructions.
  openSheet(
    (sheet, close) => {
      sheet.append(
        el('div', { class: 'sheet-header' }, [
          el('div', { class: 'sheet-title-row' }, [
            el('h3', { text: t('a2hs.title') }),
          ]),
        ]),
        el('div', { class: 'sheet-body a2hs-body' }, [
          el('p', { class: 'a2hs-intro', text: t('a2hs.intro') }),
          iosStep(SHARE_SVG, t('a2hs.stepShare')),
          iosStep(PLUS_SVG, t('a2hs.stepAdd')),
          iosStep('<b>OK</b>', t('a2hs.stepConfirm')),
          el('p', { class: 'a2hs-note muted', text: t('a2hs.tip') }),
        ]),
        el('div', { class: 'sheet-footer' }, [
          el('button', { class: 'btn btn-primary', onClick: close }, [
      lucideIcon('check', 'btn-lucide'),
      el('span', { text: t('a2hs.gotIt') }),
    ]),
        ])
      );
    },
    { compact: true }
  );
}
