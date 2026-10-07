import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthTransitions } from './authTransitions.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function workspace(token = null) {
  const state = { token, draft: 'Current account draft', clears: 0, accepted: [] };
  const transitions = createAuthTransitions(() => state.token);
  const accept = (response) => {
    state.token = response.token;
    state.accepted.push(response.token);
    return response;
  };
  const clear = () => {
    transitions.invalidate();
    state.token = null;
    state.draft = null;
    state.clears += 1;
  };
  return { state, transitions, accept, clear };
}

test('The latest login wins when an earlier account response finishes afterward', async () => {
  const { state, transitions, accept } = workspace();
  const earlier = deferred();
  const latest = deferred();
  const oldLogin = transitions.authenticate(() => earlier.promise, accept);
  const rejected = assert.rejects(oldLogin, { name: 'AbortError' });
  const newLogin = transitions.authenticate(() => latest.promise, accept);
  latest.resolve({ token: 'site-user-session' });
  await newLogin;
  earlier.resolve({ token: 'previous-admin-session' });
  await rejected;
  assert.equal(state.token, 'site-user-session');
  assert.deepEqual(state.accepted, ['site-user-session']);
  assert.equal(state.draft, 'Current account draft');
});

test('Leaving a login or setup form prevents its late response from signing in', async () => {
  for (const kind of ['login', 'setup']) {
    const { state, transitions, accept } = workspace();
    const response = deferred();
    const controller = new AbortController();
    const attempted = transitions.authenticate(() => response.promise, accept, controller.signal);
    const rejected = assert.rejects(attempted, { name: 'AbortError' });
    controller.abort();
    response.resolve({ token: `${kind}-session` });
    await rejected;
    assert.equal(state.token, null);
    assert.deepEqual(state.accepted, []);
  }
});

test('Cancelling a form before submission prevents the authentication request', async () => {
  const { transitions, accept } = workspace();
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(transitions.authenticate(async () => { calls += 1; }, accept, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('A failed latest login cannot resurrect an earlier successful attempt', async () => {
  const { state, transitions, accept } = workspace();
  const earlier = deferred();
  const oldLogin = transitions.authenticate(() => earlier.promise, accept);
  const rejected = assert.rejects(oldLogin, { name: 'AbortError' });
  await assert.rejects(transitions.authenticate(async () => { throw new Error('Invalid password'); }, accept), /Invalid password/);
  earlier.resolve({ token: 'previous-account-session' });
  await rejected;
  assert.equal(state.token, null);
});

test('Repeated sign-out shares one cleanup and clears the original session once', async () => {
  const { state, transitions, clear } = workspace('original-session');
  const cleanup = deferred();
  let calls = 0;
  const unsubscribe = () => { calls += 1; return cleanup.promise; };
  const first = transitions.signOut(unsubscribe, clear);
  const second = transitions.signOut(unsubscribe, clear);
  assert.equal(first, second);
  assert.equal(calls, 1);
  cleanup.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(state.token, null);
  assert.equal(state.clears, 1);
});

test('A delayed sign-out cannot clear a newly signed-in account or its draft', async () => {
  const { state, transitions, accept, clear } = workspace('original-session');
  const cleanup = deferred();
  const oldSignOut = transitions.signOut(() => cleanup.promise, clear);
  await transitions.authenticate(async () => ({ token: 'new-account-session' }), accept);
  state.draft = 'New account draft';
  cleanup.resolve();
  assert.equal(await oldSignOut, false);
  assert.equal(state.token, 'new-account-session');
  assert.equal(state.draft, 'New account draft');
  assert.equal(state.clears, 0);
});

test('An externally replaced login token also protects the newer account from old sign-out', async () => {
  const { state, transitions, clear } = workspace('original-session');
  const cleanup = deferred();
  const oldSignOut = transitions.signOut(() => cleanup.promise, clear);
  state.token = 'new-account-session';
  cleanup.resolve();
  assert.equal(await oldSignOut, false);
  assert.equal(state.clears, 0);
});

test('Failed notification cleanup still allows local sign-out', async () => {
  const { state, transitions, clear } = workspace('original-session');
  assert.equal(await transitions.signOut(async () => { throw new Error('Offline'); }, clear), true);
  assert.equal(state.token, null);
  assert.equal(state.clears, 1);
});

test('Sign-out invalidates pending authentication and password-change completions', async () => {
  const { state, transitions, accept, clear } = workspace('original-session');
  const response = deferred();
  const changing = transitions.authenticate(() => response.promise, accept);
  const rejected = assert.rejects(changing, { name: 'AbortError' });
  await transitions.signOut(async () => {}, clear);
  response.resolve({ token: 'old-password-change-session' });
  await rejected;
  assert.equal(state.token, null);
  assert.deepEqual(state.accepted, []);
});

test('Password changes refresh the unchanged current session and preserve its draft', async () => {
  const { state, transitions, accept } = workspace('original-session');
  await transitions.authenticate(async () => ({ token: 'refreshed-password-session' }), accept);
  assert.equal(state.token, 'refreshed-password-session');
  assert.equal(state.draft, 'Current account draft');
  assert.equal(state.clears, 0);
});

test('A stale password response cannot replace a token changed outside the guard', async () => {
  const { state, transitions, accept } = workspace('original-session');
  const response = deferred();
  const changing = transitions.authenticate(() => response.promise, accept);
  const rejected = assert.rejects(changing, { name: 'AbortError' });
  state.token = 'new-account-session';
  response.resolve({ token: 'old-password-change-session' });
  await rejected;
  assert.equal(state.token, 'new-account-session');
  assert.deepEqual(state.accepted, []);
});

test('A delayed public admin reset cannot clear a newer site-user session or its draft', async () => {
  const { state, transitions, accept, clear } = workspace('original-admin-session');
  const response = deferred();
  const resetting = transitions.resetPassword(() => response.promise, clear);
  await transitions.authenticate(async () => ({ token: 'new-site-user-session' }), accept);
  state.draft = 'New site-user request draft';
  response.resolve({ success: true });
  assert.deepEqual(await resetting, { success: true });
  assert.equal(state.token, 'new-site-user-session');
  assert.equal(state.draft, 'New site-user request draft');
  assert.equal(state.clears, 0);
});

test('A successful public reset remains visible when session restoration expires the old token', async () => {
  const { state, transitions, clear } = workspace('expired-stored-session');
  const response = deferred();
  const resetting = transitions.resetPassword(() => response.promise, clear);
  // The initial /auth/me response removes the expired stored session while the
  // public reset request is still pending.
  state.token = null;
  state.draft = null;
  response.resolve({ success: true });
  assert.deepEqual(await resetting, { success: true });
  assert.equal(state.token, null);
  assert.equal(state.clears, 0);
});

test('Leaving the reset form prevents its late completion from clearing local work', async () => {
  const { state, transitions, clear } = workspace('original-session');
  const response = deferred();
  const controller = new AbortController();
  const resetting = transitions.resetPassword(() => response.promise, clear, controller.signal);
  const rejected = assert.rejects(resetting, { name: 'AbortError' });
  controller.abort();
  response.resolve({ success: true });
  await rejected;
  assert.equal(state.token, 'original-session');
  assert.equal(state.draft, 'Current account draft');
  assert.equal(state.clears, 0);
});

test('A normal successful admin reset clears the session that started it', async () => {
  const { state, transitions, clear } = workspace('original-admin-session');
  assert.deepEqual(await transitions.resetPassword(async () => ({ success: true }), clear), { success: true });
  assert.equal(state.token, null);
  assert.equal(state.draft, null);
  assert.equal(state.clears, 1);
});

test('A failed public reset keeps the original session and work', async () => {
  const { state, transitions, clear } = workspace('original-session');
  await assert.rejects(transitions.resetPassword(async () => { throw new Error('The reset link expired'); }, clear), /reset link expired/);
  assert.equal(state.token, 'original-session');
  assert.equal(state.draft, 'Current account draft');
  assert.equal(state.clears, 0);
});
