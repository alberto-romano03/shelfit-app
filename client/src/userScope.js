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
// Per-member keys a sign-out keeps (persist.js names): device-level knowledge
// about the member, not their library.
const KEEP_ON_SIGN_OUT = ['showcase:seen'];
// Keys from before per-member storage. Removed once, on the first start of this
// version, so a former single-user cache can't surface under anyone's profile.
const LEGACY_RE = /^shelfit:(profile|stats|home|plan|discover|showcase|search|kodi-enabled|oc):/;
// The device-wide poster colour store is per member now (posterColour.js): its
// URLs name every title a member's grids showed.
const LEGACY_EXACT = new Set(['shelfit:kodi-enabled', 'shelfit:poster-hues']);
const MEMBER_KEY_RE = /^shelfit:u\d+:/;
// Which member this browser's push subscription was made for. Not a member-scoped
// key on purpose: the login page clears those, and this must outlive it.
const PUSH_OWNER_KEY = 'shelfit:push-owner';

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

// Record (or, with null, forget) which member the push subscription belongs to.
export function setPushOwner(uid) {
  try {
    if (uid) localStorage.setItem(PUSH_OWNER_KEY, String(uid));
    else localStorage.removeItem(PUSH_OWNER_KEY);
  } catch {
    /* storage disabled */
  }
}

// A push subscription made for another member stops: on a shared device their
// notifications (titles, reminders, loans) must not keep arriving for whoever
// signs in next, by a magic link or after their session ended. A subscription of
// unknown owner (made before this was recorded) is taken as the current member's.
async function dropForeignPush(uid, last) {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
    if (!sub) return setPushOwner(null);
    const owner = localStorage.getItem(PUSH_OWNER_KEY) || last;
    if (!owner) return setPushOwner(uid);
    if (owner === uid) return;
    await sub.unsubscribe();
    setPushOwner(null);
  } catch {
    /* unsupported or blocked: the server stops on its own once the endpoint is gone */
  }
}

// Run once at startup, before anything reads the stores: drops pre-multi-user
// keys, and when this browser now belongs to a different member than last time
// (a session expired and someone else signed in, or a magic link was opened),
// whatever the previous member left on it: their member-scoped keys, the offline
// API cache, and a push subscription made for them.
export function initUserScope() {
  // The one legacy flag worth keeping: "the feature tour was already shown". It
  // carries no personal data, and dropping it would replay the tour for the
  // owner on their first start after the upgrade.
  try {
    const seen = localStorage.getItem('shelfit:showcase:seen');
    const uid0 = readUidCookie();
    if (seen !== null && uid0 && localStorage.getItem(`shelfit:u${uid0}:showcase:seen`) === null) {
      localStorage.setItem(`shelfit:u${uid0}:showcase:seen`, seen);
    }
  } catch {
    /* storage disabled */
  }
  removeKeys(localStorage, (k) => LEGACY_EXACT.has(k) || LEGACY_RE.test(k));
  const uid = readUidCookie();
  if (!uid) return;
  let last = null;
  try {
    last = localStorage.getItem(LAST_UID_KEY);
  } catch {
    /* ignore */
  }
  dropForeignPush(uid, last);
  if (last !== uid) {
    dropOfflineApiCache();
    // Other members' keys. Kept: that they have seen the first-run tour (it is no
    // personal data, see KEEP_ON_SIGN_OUT).
    const mine = `shelfit:u${uid}:`;
    removeKeys(
      localStorage,
      (k) => MEMBER_KEY_RE.test(k) && !k.startsWith(mine) && !KEEP_ON_SIGN_OUT.some((keep) => k.endsWith(`:${keep}`))
    );
    removeKeys(sessionStorage, (k) => MEMBER_KEY_RE.test(k) && !k.startsWith(mine));
    try {
      localStorage.setItem(LAST_UID_KEY, uid);
    } catch {
      /* ignore */
    }
  }
}

// The prefix of the member this browser last belonged to (initUserScope records
// it): a 401 answer clears the uid cookie before the client can read it.
function lastPrefix() {
  try {
    const uid = localStorage.getItem(LAST_UID_KEY);
    return uid && /^\d+$/.test(uid) ? `shelfit:u${uid}:` : null;
  } catch {
    return null;
  }
}

// Called on an explicit sign-out (or profile switch), and when the server says the
// session is gone: forget everything this device holds about the member who is
// leaving. Device preferences stay. Pass the prefix read BEFORE signing out: the
// logout response clears the uid cookie.
export async function forgetCurrentUser(prefix = userPrefix() || lastPrefix()) {
  if (prefix) {
    // Kept: that this member has seen the first-run tour, or it would open again
    // after every profile switch on a shared device.
    const keep = new Set(KEEP_ON_SIGN_OUT.map((k) => prefix + k));
    removeKeys(localStorage, (k) => k.startsWith(prefix) && !keep.has(k));
    removeKeys(sessionStorage, (k) => k.startsWith(prefix));
  }
  try {
    localStorage.removeItem(LAST_UID_KEY);
  } catch {
    /* ignore */
  }
  await dropOfflineApiCache();
}
