import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Run the actual hook with an isolated React/browser lifecycle. No permission,
// socket, sound, or network request reaches the user's browser or backend.
const hookSource = readFileSync(new URL('./hooks/useNotificationSocket.js', import.meta.url), 'utf8')
  .replace(/^import[^;]+;\n/gm, '')
  .replace('export default function useNotificationSocket', 'function useNotificationSocket')
  .replaceAll('import.meta.env.VITE_API_URL', 'testApiBase');
const loadHook = new Function('dependencies', `
  const { useEffect, useRef, useState, useQueryClient, useAuth, expireSession,
    workspaceGeneration, sessionStorage, window, WebSocket, setInterval,
    clearInterval, setTimeout, clearTimeout, testApiBase } = dependencies;
  ${hookSource}
  return useNotificationSocket;
`);

function lifecycle() {
  let token = 'original-session';
  let generation = 0;
  let user = { username: 'Istrom_Admin' };
  let slot = 0;
  let effectSlot = 0;
  let timerId = 0;
  let expired = 0;
  let cleared = 0;
  const slots = [];
  const effects = [];
  const pendingEffects = [];
  const timers = new Map();
  const allTimers = new Map();
  const sockets = [];
  const invalidated = [];
  const stateUpdates = [];
  const listeners = new Map();
  const queryClient = { invalidateQueries: ({ queryKey }) => invalidated.push(queryKey[0]), clear: () => { cleared += 1; } };
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = Socket.CONNECTING; this.sent = []; this.closed = []; sockets.push(this); }
    send(value) { this.sent.push(value); }
    close(code, reason) { this.closed.push({ code, reason }); this.readyState = Socket.CLOSED; }
    open() { this.readyState = Socket.OPEN; this.onopen?.(); }
    message(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
    end(code) { this.readyState = Socket.CLOSED; this.onclose?.({ code }); }
  }
  const addTimer = (kind) => (callback, delay) => {
    const id = ++timerId;
    const timer = { id, kind, callback, delay };
    timers.set(id, timer);
    allTimers.set(id, timer);
    return id;
  };
  const pageWindow = {
    location: { origin: 'https://app.example.test' },
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
  };
  const hook = loadHook({
    useEffect: (callback, dependencies) => {
      const index = effectSlot++;
      const previous = effects[index];
      if (!previous || dependencies.some((value, position) => value !== previous.dependencies[position])) {
        pendingEffects.push({ index, callback, dependencies });
      }
    },
    useRef: (initial) => {
      const index = slot++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useState: (initial) => {
      const index = slot++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      const state = slots[index];
      return [state.value, (value) => { state.value = value; stateUpdates.push(value); }];
    },
    useQueryClient: () => queryClient,
    useAuth: () => ({ user }),
    expireSession: () => { expired += 1; token = null; user = null; generation += 1; },
    workspaceGeneration: () => generation,
    sessionStorage: { getItem: () => token },
    window: pageWindow,
    WebSocket: Socket,
    setInterval: addTimer('interval'),
    clearInterval: (id) => timers.delete(id),
    setTimeout: addTimer('timeout'),
    clearTimeout: (id) => timers.delete(id),
    testApiBase: 'https://api.example.test/api',
  });
  const render = () => { slot = 0; effectSlot = 0; return hook(); };
  const flushEffects = () => {
    const updates = pendingEffects.splice(0);
    for (const { index } of updates) effects[index]?.cleanup?.();
    for (const { index, callback, dependencies } of updates) effects[index] = { dependencies, cleanup: callback() };
  };
  const unmount = () => { for (const effect of effects) effect?.cleanup?.(); };
  render();
  flushEffects();
  return { sockets, invalidated, stateUpdates, timers, allTimers, listeners, pageWindow,
    render, flushEffects, unmount, expired: () => expired, cleared: () => cleared,
    setToken: (value) => { token = value; user = value ? { username: 'Istrom_Admin' } : null; },
    invalidateWorkspace: () => { generation += 1; },
    tick: (id) => allTimers.get(id).callback(),
  };
}

test('The current socket authenticates, refreshes records, pings and reconnects', () => {
  const app = lifecycle();
  const socket = app.sockets[0];
  assert.equal(socket.url, 'wss://api.example.test/api/ws/notifications');
  socket.open();
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: 'authenticate', token: 'original-session' });
  socket.message({ type: 'connected' });
  assert.equal(app.render().isLive, true);
  app.flushEffects();
  assert.equal(app.invalidated.includes('requests'), true);
  const ping = [...app.timers.values()].find((timer) => timer.delay === 25000);
  app.tick(ping.id);
  assert.equal(socket.sent.at(-1), 'ping');
  socket.end(1006);
  assert.equal(app.render().isLive, false);
  app.flushEffects();
  const reconnect = [...app.timers.values()].find((timer) => timer.kind === 'timeout');
  assert.equal(reconnect.delay, 1500);
  app.tick(reconnect.id);
  assert.equal(app.sockets.length, 2);
  app.sockets[1].open();
  assert.equal(JSON.parse(app.sockets[1].sent[0]).token, 'original-session');
  app.unmount();
});

for (const change of ['token', 'workspace generation']) {
  test(`Stale socket events cannot affect the current session after ${change} changes before cleanup`, () => {
    const app = lifecycle();
    const socket = app.sockets[0];
    socket.open();
    socket.message({ type: 'connected' });
    app.render();
    app.flushEffects();
    const ping = [...app.timers.values()].find((timer) => timer.delay === 25000);
    const invalidations = app.invalidated.length;
    const updates = app.stateUpdates.length;
    const messages = socket.sent.length;
    if (change === 'token') app.setToken('refreshed-session');
    else app.invalidateWorkspace();
    socket.message({ type: 'connected' });
    socket.message({ type: 'notification_created' });
    app.tick(ping.id);
    socket.end(1008);
    assert.equal(app.expired(), 0);
    assert.equal(app.cleared(), 0);
    assert.equal(app.invalidated.length, invalidations);
    assert.equal(app.stateUpdates.length, updates);
    assert.equal(socket.sent.length, messages);
    assert.equal([...app.timers.values()].some((timer) => timer.kind === 'timeout'), false);
    app.unmount();
  });
}

test('A refreshed auth identity closes the old connection and authenticates with the new token', () => {
  const app = lifecycle();
  const oldSocket = app.sockets[0];
  oldSocket.open();
  oldSocket.message({ type: 'connected' });
  assert.equal(app.render().isLive, true);
  app.flushEffects();
  app.setToken('new-password-session');
  assert.equal(app.render().isLive, false);
  app.flushEffects();
  assert.equal(oldSocket.closed.at(-1).code, 1000);
  assert.equal(app.sockets.length, 2);
  const currentSocket = app.sockets[1];
  currentSocket.open();
  currentSocket.message({ type: 'connected' });
  assert.equal(JSON.parse(currentSocket.sent[0]).token, 'new-password-session');
  assert.equal(app.render().isLive, true);
  app.flushEffects();
  oldSocket.end(1008);
  assert.equal(app.expired(), 0);
  assert.equal(app.render().isLive, true);
  app.unmount();
});

test('A current-session policy close still expires that session and clears timers', () => {
  const app = lifecycle();
  const socket = app.sockets[0];
  socket.open();
  socket.message({ type: 'connected' });
  app.render();
  app.flushEffects();
  socket.end(1008);
  assert.equal(app.expired(), 1);
  assert.equal(app.cleared(), 1);
  assert.equal(app.render().isLive, false);
  assert.equal(app.timers.size, 0);
  app.flushEffects();
  app.unmount();
});

test('An old queued reconnect cannot create a connection after the session changes', () => {
  const app = lifecycle();
  app.sockets[0].end(1006);
  const reconnect = [...app.timers.values()].find((timer) => timer.kind === 'timeout');
  app.setToken('new-account-session');
  app.tick(reconnect.id);
  assert.equal(app.sockets.length, 1);
  app.unmount();
});

test('A delayed old socket opening cannot authenticate after the account changes', () => {
  const app = lifecycle();
  app.setToken('new-account-session');
  const socket = app.sockets[0];
  socket.open();
  assert.equal(socket.sent.length, 0);
  assert.equal(socket.closed.at(-1).code, 1000);
  app.unmount();
});

test('A stale fallback poll cannot refresh another account before effect cleanup', () => {
  const app = lifecycle();
  const poll = [...app.timers.values()].find((timer) => timer.delay === 30000);
  app.tick(poll.id);
  assert.equal(app.invalidated.includes('requests'), true);
  const previous = app.invalidated.length;
  app.invalidateWorkspace();
  app.tick(poll.id);
  assert.equal(app.invalidated.length, previous);
  app.unmount();
});

test('A suspended notification sound does not resume into the next account', async () => {
  const app = lifecycle();
  let finishResume;
  let gains = 0;
  const resumed = new Promise((resolve) => { finishResume = resolve; });
  const audio = { state: 'running', resume: () => resumed,
    createGain: () => { gains += 1; throw new Error('The stale sound must stop before creating nodes'); } };
  app.pageWindow.AudioContext = class { constructor() { return audio; } };
  await app.listeners.get('pointerdown')();
  audio.state = 'suspended';
  app.sockets[0].open();
  app.sockets[0].message({ type: 'notification_created' });
  app.setToken('new-account-session');
  finishResume();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(gains, 0);
  app.unmount();
});
