import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { disablePush, deviceNotificationsEnabled, enablePush } from './push.js';
import { clearWorkspaceStates } from './utils/workspaceState.js';
import { createAuthTransitions } from './utils/authTransitions.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(t, response) {
  let browserUnsubscriptions = 0;
  let browserSubscriptions = 0;
  let token = 'test-token';
  const calls = [];
  const authorizations = [];
  const sub = {endpoint:'https://push.example/test', toJSON:() => ({endpoint:'https://push.example/test'}),
    unsubscribe: async () => { browserUnsubscriptions++; }};
  const registration = {pushManager: {getSubscription:async () => sub,
    subscribe:async () => { browserSubscriptions++; return sub; }}};
  const serviceWorker = {getRegistration:async () => registration, register:async () => registration,
    ready:Promise.resolve(registration)};
  const notification = {requestPermission:async () => 'granted'};
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({url, data:options.body ? JSON.parse(options.body) : undefined});
    authorizations.push(options.headers.Authorization);
    if (response instanceof Error) throw response;
    const data = typeof response === 'function' ? await response(url, options) : response;
    return {status:200, ok:true, json:async () => data};
  });
  Object.defineProperty(globalThis, 'navigator', {configurable:true, value:{serviceWorker}});
  globalThis.window = {PushManager: function(){}, Notification:notification, atob:globalThis.atob};
  globalThis.Notification = notification;
  globalThis.sessionStorage = {getItem:() => token};
  return {calls, authorizations, sub, registration, serviceWorker, notification,
    setToken:(value) => { token = value; }, browserUnsubscriptions:() => browserUnsubscriptions,
    browserSubscriptions:() => browserSubscriptions};
}

test('Signing out unregisters only the current account and preserves the shared browser subscription', async (t) => {
  const state = setup(t, {ok:true, removed:false});
  await disablePush({signingOut:true});
  assert.deepEqual(state.calls[0], {url:'/api/push/unsubscribe', data:{endpoint:'https://push.example/test',current_account_only:true}});
  assert.equal(state.browserUnsubscriptions(), 0);
});

test('An explicit device opt-out removes both registrations after the server accepts it', async (t) => {
  const state = setup(t, {ok:true, removed:true});
  await disablePush();
  assert.equal(state.browserUnsubscriptions(), 1);
});

test('Failed server unsubscription preserves other tabs device notifications', async (t) => {
  const state = setup(t, new Error('Offline'));
  await assert.rejects(disablePush(), {message:'Offline'});
  assert.equal(state.browserUnsubscriptions(), 0);
});

test('Device notification status follows the signed-in account instead of another tabs subscription', async (t) => {
  const state = setup(t, {enabled:false});
  assert.equal(await deviceNotificationsEnabled(), false);
  assert.equal(state.calls[0].url, '/api/push/subscription-status');
});

for (const signingOut of [false, true]) {
  test(`A delayed ${signingOut ? 'sign-out' : 'opt-out'} cannot unregister the next account`, async (t) => {
    const state = setup(t, {ok:true, removed:true});
    const lookup = deferred();
    state.serviceWorker.getRegistration = () => lookup.promise;
    const pending = disablePush({signingOut});
    const stopped = assert.rejects(pending, {name:'AbortError'});
    state.setToken('new-account-token');
    lookup.resolve(state.registration);
    await stopped;
    assert.equal(state.calls.length, 0);
    assert.equal(state.browserUnsubscriptions(), 0);
  });
}

test('A stale device status lookup does not read the next account registration', async (t) => {
  const state = setup(t, {enabled:true});
  const lookup = deferred();
  state.serviceWorker.getRegistration = () => lookup.promise;
  const pending = deviceNotificationsEnabled();
  const stopped = assert.rejects(pending, {name:'AbortError'});
  state.setToken('new-account-token');
  lookup.resolve(state.registration);
  await stopped;
  assert.equal(state.calls.length, 0);
});

test('A session cleared while opt-out is sending cannot remove the shared browser subscription', async (t) => {
  const response = deferred();
  const sent = deferred();
  const state = setup(t, () => { sent.resolve(); return response.promise; });
  const pending = disablePush();
  const stopped = assert.rejects(pending, {name:'AbortError'});
  await sent.promise;
  // A local sign-out invalidates pending work even if the next token happens
  // to equal the old token (for example a rapid login to the same account).
  clearWorkspaceStates();
  response.resolve({ok:true, removed:true});
  await stopped;
  assert.deepEqual(state.authorizations, ['Bearer test-token']);
  assert.equal(state.browserUnsubscriptions(), 0);
});

for (const step of ['permission', 'registration', 'readiness', 'lookup', 'subscription']) {
  test(`Enabling notifications stops when the account changes during ${step}`, async (t) => {
    const state = setup(t, {public_key:'AQID'});
    const paused = deferred();
    const entered = deferred();
    const wait = () => { entered.resolve(); return paused.promise; };
    if (step === 'permission') state.notification.requestPermission = wait;
    if (step === 'registration') state.serviceWorker.register = wait;
    if (step === 'readiness') Object.defineProperty(state.serviceWorker, 'ready', {get:wait});
    if (step === 'lookup') state.registration.pushManager.getSubscription = wait;
    if (step === 'subscription') {
      state.registration.pushManager.getSubscription = async () => null;
      state.registration.pushManager.subscribe = wait;
    }
    const pending = enablePush();
    const stopped = assert.rejects(pending, {name:'AbortError'});
    await entered.promise;
    state.setToken('new-account-token');
    paused.resolve(step === 'permission' ? 'granted'
      : ['lookup', 'subscription'].includes(step) ? state.sub : state.registration);
    await stopped;
    assert.equal(state.calls.some((call) => call.url.endsWith('/push/subscribe')), false);
    assert.equal(state.browserUnsubscriptions(), 0);
    assert.equal(state.browserSubscriptions(), 0);
    assert.equal(state.authorizations.every((header) => header === 'Bearer test-token'), true);
  });
}

test('The current account can enable and register its device', async (t) => {
  const state = setup(t, {public_key:'AQID'});
  state.registration.pushManager.getSubscription = async () => null;
  assert.deepEqual(await enablePush(), {ok:true});
  assert.equal(state.browserSubscriptions(), 1);
  assert.equal(state.calls.at(-1).url, '/api/push/subscribe');
  assert.deepEqual(state.authorizations, ['Bearer test-token', 'Bearer test-token']);
});

test('Sign-out removes an already-sent registration after its server commit', async (t) => {
  const sent = deferred();
  const release = deferred();
  const events = [];
  let serverOwner = null;
  const state = setup(t, async (url, options) => {
    if (url.endsWith('/push/vapid-public-key')) return {public_key:'AQID'};
    if (url.endsWith('/push/subscribe')) {
      events.push('subscribe sent');
      sent.resolve();
      await release.promise;
      serverOwner = options.headers.Authorization;
      events.push('subscribe committed');
    }
    if (url.endsWith('/push/unsubscribe')) {
      serverOwner = null;
      events.push('unsubscribe committed');
    }
    return {ok:true};
  });
  const transitions = createAuthTransitions(() => sessionStorage.getItem('istrom_token'));
  const enable = enablePush();
  const cancelled = assert.rejects(enable, {name:'AbortError'});
  await sent.promise;
  const signOut = transitions.signOut(() => disablePush({signingOut:true}), () => {
    clearWorkspaceStates();
    state.setToken(null);
    transitions.invalidate();
    events.push('session cleared');
  });
  // Give an incorrectly unqueued unsubscribe time to complete before the old
  // subscribe commits. Release either way so a failing test leaves no work pending.
  await new Promise(setImmediate);
  release.resolve();
  await cancelled;
  assert.equal(await signOut, true);
  assert.deepEqual(events, ['subscribe sent', 'subscribe committed', 'unsubscribe committed', 'session cleared']);
  assert.equal(serverOwner, null);
  assert.equal(state.browserUnsubscriptions(), 0);
});

for (const step of ['permission', 'lookup']) {
  test(`Sign-out cancels enabling during ${step} before the token clears`, async (t) => {
    const state = setup(t, {public_key:'AQID'});
    const paused = deferred();
    const entered = deferred();
    if (step === 'permission') {
      state.notification.requestPermission = () => { entered.resolve(); return paused.promise; };
    } else {
      let lookups = 0;
      state.registration.pushManager.getSubscription = () => {
        if (++lookups === 1) { entered.resolve(); return paused.promise; }
        return Promise.resolve(state.sub);
      };
    }
    const enable = enablePush();
    const cancelled = assert.rejects(enable, {name:'AbortError'});
    await entered.promise;
    // Cleanup must finish while the prompt or old lookup is still pending.
    assert.deepEqual(await disablePush({signingOut:true}), {ok:true});
    assert.equal(sessionStorage.getItem('istrom_token'), 'test-token');
    paused.resolve(step === 'permission' ? 'granted' : state.sub);
    await cancelled;
    assert.equal(state.calls.some((call) => call.url.endsWith('/push/subscribe')), false);
    assert.equal(state.browserUnsubscriptions(), 0);
  });
}

for (const intent of ['enable', 'disable']) {
  test(`An old notification status cannot overwrite a newer ${intent} intent`, async (t) => {
    const response = deferred();
    const sent = deferred();
    setup(t, (url) => {
      if (url.endsWith('/push/subscription-status')) { sent.resolve(); return response.promise; }
      return {public_key:'AQID', ok:true};
    });
    const status = deviceNotificationsEnabled();
    const cancelled = assert.rejects(status, {name:'AbortError'});
    await sent.promise;
    await (intent === 'enable' ? enablePush() : disablePush());
    response.resolve({enabled:intent === 'disable'});
    await cancelled;
  });
}

test('A failed registration releases queued sign-out and later registration', async (t) => {
  const sent = deferred();
  const release = deferred();
  const events = [];
  let subscriptions = 0;
  const state = setup(t, async (url) => {
    if (url.endsWith('/push/vapid-public-key')) return {public_key:'AQID'};
    if (url.endsWith('/push/subscribe')) {
      if (++subscriptions === 1) {
        events.push('subscribe sent');
        sent.resolve();
        await release.promise;
        events.push('subscribe failed');
        throw new Error('Offline');
      }
      events.push('subscribe accepted');
    }
    if (url.endsWith('/push/unsubscribe')) events.push('unsubscribe accepted');
    return {ok:true};
  });
  const failed = assert.rejects(enablePush(), {message:'Offline'});
  await sent.promise;
  const signOut = disablePush({signingOut:true});
  await new Promise(setImmediate);
  release.resolve();
  await failed;
  assert.deepEqual(await signOut, {ok:true});
  assert.deepEqual(await enablePush(), {ok:true});
  assert.deepEqual(events, ['subscribe sent', 'subscribe failed', 'unsubscribe accepted', 'subscribe accepted']);
  assert.equal(state.browserUnsubscriptions(), 0);
});

for (const intent of ['enable', 'disable']) {
  test(`A newer ${intent} during pending sign-out cannot cancel account cleanup`, async (t) => {
    const response = deferred();
    const sent = deferred();
    const state = setup(t, (url) => {
      if (url.endsWith('/push/unsubscribe')) { sent.resolve(); return response.promise; }
      return {public_key:'AQID', ok:true};
    });
    const signOut = disablePush({signingOut:true});
    await sent.promise;
    const change = intent === 'enable' ? enablePush() : disablePush();
    const cancelled = assert.rejects(change, {name:'AbortError'});
    // Allow a mistaken registration time to send before finishing sign-out.
    await new Promise(setImmediate);
    response.resolve({ok:true, removed:true});
    await cancelled;
    assert.deepEqual(await signOut, {ok:true});
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].url, '/api/push/unsubscribe');
    assert.equal(state.browserUnsubscriptions(), 0);
  });
}

test('Queued old-account cleanup cannot unregister a newer account', async (t) => {
  const sent = deferred();
  const release = deferred();
  let serverOwner = null;
  let registrations = 0;
  const state = setup(t, async (url, options) => {
    if (url.endsWith('/push/vapid-public-key')) return {public_key:'AQID'};
    if (url.endsWith('/push/subscribe')) {
      if (++registrations === 1) { sent.resolve(); await release.promise; }
      serverOwner = options.headers.Authorization;
    }
    if (url.endsWith('/push/unsubscribe')) serverOwner = null;
    return {ok:true};
  });
  const oldEnable = assert.rejects(enablePush(), {name:'AbortError'});
  await sent.promise;
  const oldSignOut = assert.rejects(disablePush({signingOut:true}), {name:'AbortError'});
  await new Promise(setImmediate);
  state.setToken('new-account-token');
  const newEnable = enablePush();
  await new Promise(setImmediate);
  release.resolve();
  await oldEnable;
  await oldSignOut;
  assert.deepEqual(await newEnable, {ok:true});
  assert.equal(serverOwner, 'Bearer new-account-token');
  assert.equal(state.calls.some((call) => call.url.endsWith('/push/unsubscribe')), false);
  assert.equal(state.browserUnsubscriptions(), 0);
});

test('Enable refreshes the browser subscription after an in-flight physical opt-out', async (t) => {
  const removed = deferred();
  const started = deferred();
  const nextSubscription = {endpoint:'https://push.example/new',
    toJSON:() => ({endpoint:'https://push.example/new'})};
  const events = [];
  const state = setup(t, (url) => {
    if (url.endsWith('/push/subscribe')) events.push('server subscribed');
    return {public_key:'AQID', ok:true};
  });
  let current = state.sub;
  state.sub.unsubscribe = async () => {
    started.resolve();
    await removed.promise;
    current = null;
    events.push('browser unsubscribed');
  };
  state.registration.pushManager.getSubscription = async () => current;
  state.registration.pushManager.subscribe = async () => {
    current = nextSubscription;
    events.push('browser subscribed');
    return current;
  };
  const disable = disablePush();
  // A newer enable supersedes the old UI result, but the browser operation
  // already sent must finish before registering the replacement endpoint.
  const cancelled = assert.rejects(disable, {name:'AbortError'});
  await started.promise;
  const enable = enablePush();
  await new Promise(setImmediate);
  removed.resolve();
  await cancelled;
  assert.deepEqual(await enable, {ok:true});
  assert.deepEqual(events, ['browser unsubscribed', 'browser subscribed', 'server subscribed']);
  assert.equal(state.calls.at(-1).data.endpoint, 'https://push.example/new');
});
