// Client-side UI preferences (localStorage). Each is a simple boolean with a
// default; storage survives an iOS PWA relaunch, same as the theme setting.
// These are pure client toggles (snow, haptics). Push notifications keep their
// own server-side state — only the local intent flag lives here.

const PREFIX = 'shelfit:pref:';

const DEFAULTS = {
  snow: true, // December snow effect on the home cover
  haptic: true, // vibration feedback on rating interactions
  push: false, // push notifications (also gated by the server subscription)
};

export function getPref(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return DEFAULTS[key] ?? false;
    return raw === '1';
  } catch {
    return DEFAULTS[key] ?? false; // storage disabled (private mode)
  }
}

export function setPref(key, on) {
  try {
    localStorage.setItem(PREFIX + key, on ? '1' : '0');
  } catch {
    /* best-effort */
  }
}
