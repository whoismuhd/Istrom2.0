/** Web Push client: service-worker registration + subscribe/unsubscribe. */
import { api } from './api';

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

async function getRegistration() {
  return navigator.serviceWorker.register('/sw.js');
}

/** Current subscription, or null. */
export async function getPushSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

/**
 * Ask permission (user-gesture context), subscribe, and register the
 * subscription with the backend. Returns { ok, reason? }.
 */
export async function enablePush() {
  if (!pushSupported()) return { ok: false, reason: 'This browser does not support push notifications.' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'Notification permission was not granted.' };

  const { public_key: publicKey } = await api.push.vapidPublicKey();
  const reg = await getRegistration();
  await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  await api.push.subscribe(sub.toJSON());
  return { ok: true };
}

export async function disablePush() {
  const sub = await getPushSubscription();
  if (sub) {
    try {
      await api.push.unsubscribe(sub.endpoint);
    } finally {
      await sub.unsubscribe();
    }
  }
  return { ok: true };
}
