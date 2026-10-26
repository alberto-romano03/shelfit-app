// Leaving this device: the one way the app signs a member out, used by "Switch
// profile" and "Sign out of all devices" in Settings.
//
// Order matters: notifications on this device belong to the member who is
// leaving, so they stop first (while the session still exists to say whose they
// are); then the session ends; then everything this device holds about the
// member is forgotten (their on-device cache and the service worker's offline
// API copies). The full navigation to /login drops every in-memory cache too,
// and the next person starts from the profile picker with nothing of theirs.

import { api } from './api.js';
import { withBase } from './basePath.js';
import { forgetCurrentUser, userPrefix } from './userScope.js';
import { currentPushEndpoint } from './push.js';

export async function signOut({ everywhere = false } = {}) {
  // Whose data to forget, read now: the logout response clears the uid cookie.
  const prefix = userPrefix();
  // Signing out everywhere stops notifications on every device server-side.
  if (!everywhere) {
    try {
      const endpoint = await currentPushEndpoint();
      if (endpoint) await api.pushUnsubscribe(endpoint);
    } catch {
      /* best-effort: the session ends regardless */
    }
  }
  try {
    await (everywhere ? api.logoutAll() : api.logout());
  } catch {
    /* clear locally regardless */
  }
  await forgetCurrentUser(prefix);
  window.location.href = withBase('/login');
}
