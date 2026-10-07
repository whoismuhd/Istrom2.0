import test from 'node:test';
import assert from 'node:assert/strict';
import { disablePush, deviceNotificationsEnabled } from './push.js';

function setup(t, response) {
  let browserUnsubscriptions = 0;
  const calls = [];
  const sub = {endpoint:'https://push.example/test', toJSON:() => ({endpoint:'https://push.example/test'}),
    unsubscribe: async () => { browserUnsubscriptions++; }};
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({url, data:JSON.parse(options.body)});
    if (response instanceof Error) throw response;
    return {status:200, ok:true, json:async () => response};
  });
  Object.defineProperty(globalThis, 'navigator', {configurable:true, value:{serviceWorker:{getRegistration:async () => ({pushManager:{getSubscription:async () => sub}})}}});
  globalThis.window = {PushManager: function(){}, Notification:{}};
  globalThis.sessionStorage = {getItem:() => 'test-token'};
  return {calls, browserUnsubscriptions:() => browserUnsubscriptions};
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
