// Keeping an open Season or title page true to changes made somewhere else.
//   • The Now Playing toast's actions (and their Undo) name the title they
//     changed (markTitleChanged); a page open on that title reloads at once.
//   • Back in the app after a while away (the nightly Kodi sync, another device),
//     the page asks the server again and reloads only if what it shows changed.
// A reload re-mounts the page on the same route, which keeps its scroll.
import { navigate, onCleanup } from './router.js';

const AWAY_MS = 10 * 60 * 1000; // hidden at least this long before a check

export function markTitleChanged(itemId) {
  if (itemId == null) return;
  window.dispatchEvent(new CustomEvent('shelfit:title-changed', { detail: { itemId: String(itemId) } }));
}

// `signature()` sums up what the page shows now; `fetchSignature()` asks the
// server for the same. Call it while the page is mounting (it registers cleanup).
export function keepTitleFresh(itemId, { signature, fetchSignature }) {
  let alive = true;
  const reload = () => {
    if (alive) navigate(location.pathname, { replace: true });
  };
  const onChanged = (e) => {
    if (e.detail && e.detail.itemId === String(itemId)) reload();
  };
  let hiddenAt = 0;
  const onVisibility = async () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (away < AWAY_MS) return;
    try {
      if ((await fetchSignature()) !== signature()) reload();
    } catch {
      /* offline or the server is down: keep the page as it is */
    }
  };
  window.addEventListener('shelfit:title-changed', onChanged);
  document.addEventListener('visibilitychange', onVisibility);
  onCleanup(() => {
    alive = false;
    window.removeEventListener('shelfit:title-changed', onChanged);
    document.removeEventListener('visibilitychange', onVisibility);
  });
}
