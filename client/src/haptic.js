// Haptic feedback for rating interactions.
//
// Android/Chromium: the standard Vibration API (navigator.vibrate).
// iOS Safari: has NO vibrate, and a *programmatic* toggle of an <input switch>
// does NOT tick — only a GENUINE tap on the control does. So on iOS we overlay
// an invisible <input type="checkbox" switch> on the tappable element
// (attachHaptic): the real tap toggles it (native haptic tick) and the click
// still bubbles to the element's own handler. (Technique: github.com/tijnjh/ios-haptics.)
//
// Respects the user's haptic preference (Settings) — a no-op when disabled.

import { getPref } from './prefs.js';

function hasVibrate() {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

// Android path: a short vibration. On iOS this is a no-op (no vibrate) — there,
// attachHaptic() provides the tick instead.
export function haptic() {
  try {
    if (!getPref('haptic')) return;
    if (hasVibrate()) navigator.vibrate(15);
  } catch {
    /* never let feedback break an interaction */
  }
}
export function hapticStar() {
  haptic();
}

// A hidden global switch used only for the iOS second-tick attempt (below).
let beatSwitch = null;
function ensureBeatSwitch() {
  if (beatSwitch || typeof document === 'undefined') return beatSwitch;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.setAttribute('aria-hidden', 'true');
  input.tabIndex = -1;
  Object.assign(input.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
    margin: '0',
  });
  document.body.appendChild(input);
  beatSwitch = input;
  return input;
}

// Heartbeat "da-dum" — a double pulse for the favourite heart. Android gets a
// two-hit vibration pattern. On iOS the first tick comes from the real tap on the
// heart's overlay switch (attachHaptic); we then attempt a second tick shortly
// after for the double-beat feel (best-effort — iOS may ignore the programmatic
// one, in which case a single tick + the beat animation still convey it).
export function hapticFavorite() {
  try {
    if (!getPref('haptic')) return;
    if (hasVibrate()) {
      navigator.vibrate([16, 80, 26]);
      return;
    }
    const sw = ensureBeatSwitch();
    if (sw) setTimeout(() => { try { sw.click(); } catch { /* ignore */ } }, 95);
  } catch {
    /* never let feedback break an interaction */
  }
}

// Overlay an invisible iOS haptic switch on a tappable element. A real tap
// toggles it (native tick) and the click bubbles through to the element's own
// listeners, so behaviour is unchanged. No-op where the Vibration API exists
// (Android) or when haptics are off. The overlay lives INSIDE the element, so
// re-attach after re-rendering that element.
export function attachHaptic(target) {
  try {
    if (!target || typeof document === 'undefined') return;
    if (!getPref('haptic')) return;
    if (hasVibrate()) return; // Android already covered by haptic()/vibrate
    if (target.querySelector('input[data-haptic]')) return; // already attached
    if (!target.style.position) target.style.position = 'relative';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', ''); // the iOS 17.4+ switch control
    input.setAttribute('data-haptic', '');
    input.setAttribute('aria-hidden', 'true');
    input.tabIndex = -1;
    Object.assign(input.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      margin: '0',
      padding: '0',
      border: '0',
      opacity: '0',
      cursor: 'inherit',
      touchAction: 'manipulation',
      WebkitTapHighlightColor: 'transparent',
    });
    target.appendChild(input);
  } catch {
    /* ignore */
  }
}
