// Client side of Web Push: feature detection, subscribe/unsubscribe via the
// existing service worker, and posting the subscription to the backend. All
// Web Push cryptography and delivery happen server-side; this only manages the
// browser subscription and the permission prompt.

import { api } from './api.js';
import { t } from './i18n.js';

export function pushSupported() {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

// The VAPID public key arrives base64url; the PushManager needs a Uint8Array.
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function registration() {
  return navigator.serviceWorker.ready; // resolves once the SW is active
}

// Request permission, subscribe through the SW, and register the subscription
// with the backend. Returns true on success; throws with a message otherwise.
export async function enablePush() {
  if (!pushSupported()) throw new Error(t('push.unsupported'));
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(t('push.permissionDenied'));

  const cfg = await api.pushConfig();
  if (!cfg || !cfg.publicKey) throw new Error(t('push.missingConfig'));

  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true, // required by browsers for Web Push
      applicationServerKey: urlBase64ToUint8Array(cfg.publicKey),
    });
  }
  await api.pushSubscribe(sub.toJSON());
  return true;
}

// Unsubscribe in the browser and remove the subscription from the backend.
export async function disablePush() {
  try {
    const reg = await registration();
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch {
    /* remove server-side regardless */
  }
  await api.pushUnsubscribe();
}
