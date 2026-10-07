/** Web Push client: service-worker registration + subscribe/unsubscribe. */
import { api } from './api.js';
import { workspaceGeneration } from './utils/workspaceState.js';

let pushEpoch = 0;
let registrationQueue = Promise.resolve();
const pendingSignOuts = new Set();

function captureSession() {
  return { token:sessionStorage.getItem('istrom_token'), generation:workspaceGeneration(), epoch:pushEpoch };
}

function requireCurrentSession(session, checkIntent = true) {
  if (session.token !== sessionStorage.getItem('istrom_token') || session.generation !== workspaceGeneration()
    || (checkIntent && session.epoch !== pushEpoch)) {
    const error = new Error('Your sign-in changed. Please try again.');
    error.name = 'AbortError';
    throw error;
  }
}

function beginChange(signingOut = false) {
  const session = captureSession();
  // A new toggle must not cancel the cleanup of this same account's sign-out.
  if (!signingOut && [...pendingSignOuts].some((pending) => pending.token === session.token
    && pending.generation === session.generation)) {
    const error = new Error('Sign-out is in progress.');
    error.name = 'AbortError';
    throw error;
  }
  session.epoch = ++pushEpoch;
  return session;
}

function queueRegistration(change) {
  const result = registrationQueue.then(change);
  // A failed request must still allow the next account cleanup to run.
  registrationQueue = result.catch(() => {});
  return result;
}

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

export async function deviceNotificationsEnabled() {
  const session = captureSession();
  const sub = await getPushSubscription();
  requireCurrentSession(session);
  if (!sub) return false;
  const status = await api.push.subscriptionStatus({endpoint: sub.endpoint});
  requireCurrentSession(session);
  return status.enabled;
}

/**
 * Ask permission (user-gesture context), subscribe, and register the
 * subscription with the backend. Returns { ok, reason? }.
 */
export async function enablePush() {
  if (!pushSupported()) return { ok: false, reason: 'This browser does not support push notifications.' };
  const session = beginChange();

  const permission = await Notification.requestPermission();
  requireCurrentSession(session);
  if (permission !== 'granted') return { ok: false, reason: 'Notification permission was not granted.' };

  const { public_key: publicKey } = await api.push.vapidPublicKey();
  requireCurrentSession(session);
  const reg = await getRegistration();
  requireCurrentSession(session);
  await navigator.serviceWorker.ready;
  requireCurrentSession(session);

  let sub = await reg.pushManager.getSubscription();
  requireCurrentSession(session);
  await queueRegistration(async () => {
    requireCurrentSession(session);
    // A preceding opt-out can remove the subscription found during preparation.
    // Refresh it after queued browser cleanup before creating/registering one.
    sub = await reg.pushManager.getSubscription();
    requireCurrentSession(session);
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      requireCurrentSession(session);
    }
    await api.push.subscribe(sub.toJSON());
    requireCurrentSession(session);
  });
  return { ok: true };
}

export async function disablePush({ signingOut = false } = {}) {
  const session = beginChange(signingOut);
  if (signingOut) pendingSignOuts.add(session);
  // Sign-out cleanup remains valid for its captured account even if another
  // sign-out intent occurs; token/generation checks still protect a new login.
  const checkSession = () => requireCurrentSession(session, !signingOut);
  try {
    const sub = await getPushSubscription();
    checkSession();
    if (sub) {
      await queueRegistration(async () => {
        checkSession();
        await api.push.unsubscribe({...sub.toJSON(), ...(signingOut ? {current_account_only:true} : {})});
        checkSession();
        // Browser subscriptions are shared across tabs. Sign-out removes only
        // this account's server registration; another tab can keep using it.
        if (!signingOut) {
          await sub.unsubscribe();
          checkSession();
        }
      });
    }
    return { ok: true };
  } finally {
    pendingSignOuts.delete(session);
  }
}
