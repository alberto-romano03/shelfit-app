// Whose device cache is this? On a shared device several household members use
// the same browser, so everything the app keeps on the device about a person
// (home screen, stats, watchlists, offline datasets, recent searches) lives under
// that member's own key prefix, `shelfit:u<id>:`, never a shared one. Device
// preferences (theme, language, snow, haptics, ticket sort) stay shared.
//
// The member comes from the `shelfit_uid` cookie the server sets next to the
// session cookie. It is readable on purpose and grants nothing (the HttpOnly
// session cookie is what authenticates); it only lets the very first paint pick
// the right cache synchronously, before any request has answered.

const LAST_UID_KEY = 'shelfit:last-uid';
// Keys from before per-member storage. Removed once, on the first start of this
// version, so a former single-user cache can't surface under anyone's profile.
const LEGACY_RE = /^shelfit:(profile|stats|home|plan|discover|showcase|search|kodi-enabled|oc):/;
const LEGACY_EXACT = new Set(['shelfit:kodi-enabled']);

function readUidCookie() {
  try {
    const m = /(?:^|;\s*)shelfit_uid=(\d+)/.exec(document.cookie);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// The signed-in member's id as a string, or null when unknown (then nothing is
// read from or written to the per-member stores).
export function currentUid() {
  return readUidCookie();
}

// `shelfit:u<id>:` for the signed-in member, or null.
export function userPrefix() {
  const uid = readUidCookie();
  return uid ? `shelfit:u${uid}:` : null;
}

function removeKeys(storage, test) {
  try {
    const doomed = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && test(k)) doomed.push(k);
    }
    doomed.forEach((k) => storage.removeItem(k));
  } catch {
    /* storage disabled: nothing stored either */
  }
}

// The service worker's offline copies of API responses (profile, stats, plan to
// watch, profile images). Keyed by URL alone, so they are dropped whenever the
// member on this device changes. Matches every version of the data cache.
async function dropOfflineApiCache() {
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('shelfit-data-')).map((n) => caches.delete(n)));
  } catch {
    /* Cache Storage unavailable */
  }
}

// Run once at startup, before anything reads the stores: drops pre-multi-user
// keys, and when this browser now belongs to a different member than last time
// (a session expired and someone else signed in), the offline API cache too.
export function initUserScope() {
  removeKeys(localStorage, (k) => LEGACY_EXACT.has(k) || LEGACY_RE.test(k));
  const uid = readUidCookie();
  if (!uid) return;
  let last = null;
  try {
    last = localStorage.getItem(LAST_UID_KEY);
  } catch {
    /* ignore */
  }
  if (last !== uid) {
    dropOfflineApiCache();
    try {
      localStorage.setItem(LAST_UID_KEY, uid);
    } catch {
      /* ignore */
    }
  }
}

// Called on an explicit sign-out (or profile switch): forget everything this
// device holds about the member who is leaving. Device preferences stay. Pass the
// prefix read BEFORE signing out: the logout response clears the uid cookie.
export async function forgetCurrentUser(prefix = userPrefix()) {
  if (prefix) {
    removeKeys(localStorage, (k) => k.startsWith(prefix));
    removeKeys(sessionStorage, (k) => k.startsWith(prefix));
  }
  try {
    localStorage.removeItem(LAST_UID_KEY);
  } catch {
    /* ignore */
  }
  await dropOfflineApiCache();
}
