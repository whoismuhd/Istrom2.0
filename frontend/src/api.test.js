import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api.js';

test('Wrong personal login displays the server error without redirecting', async () => {
  const removed = [];
  globalThis.localStorage = { getItem: () => null, removeItem: (key) => removed.push(key) };
  globalThis.window = { location: { href: '/login/site' } };
  globalThis.fetch = async () => ({ status: 401, ok: false, json: async () => ({ detail: 'Invalid username or password.' }) });
  await assert.rejects(api.auth.login({ username: 'person', password: 'incorrect-password', user_type: 'project_site' }), { message: 'Invalid username or password.' });
  assert.deepEqual(removed, []);
  assert.equal(window.location.href, '/login/site');
});

test('Expired or revoked session clears credentials and returns to login', async () => {
  const removed = [];
  globalThis.localStorage = { getItem: () => 'expired-token', removeItem: (key) => removed.push(key) };
  globalThis.window = { location: { href: '/inventory' } };
  globalThis.fetch = async () => ({ status: 401, ok: false, json: async () => ({ detail: 'Invalid or expired token' }) });
  await assert.rejects(api.items.list(), { message: 'Session expired' });
  assert.deepEqual(removed, ['istrom_token', 'istrom_user']);
  assert.equal(window.location.href, '/login');
});

test('Failed approval preserves the insufficient-stock message', async () => {
  globalThis.localStorage = { getItem: () => 'token' };
  globalThis.fetch = async () => ({ status: 409, ok: false, json: async () => ({ detail: 'Insufficient inventory quantity for approval' }) });
  await assert.rejects(api.requests.updateStatus(1, { status: 'Approved' }), { message: 'Insufficient inventory quantity for approval' });
});

test('Import validation identifies the row and field to correct', async () => {
  globalThis.localStorage = { getItem: () => 'token' };
  globalThis.fetch = async () => ({ status: 422, ok: false, json: async () => ({ detail: [
    { loc: ['body', 'rows', 1, 'name'], msg: 'String should have at most 255 characters' },
    { loc: ['body', 'rows', 2, 'unit'], msg: 'Item name and unit cannot be blank.' },
  ] }) });
  await assert.rejects(api.bulkUpload.commit({ rows: [] }), {
    message: 'Row 2, Name: String should have at most 255 characters; Row 3, Unit: Item name and unit cannot be blank.',
  });
});

test('All-sites history and notifications omit empty project filters', async () => {
  const urls = [];
  globalThis.localStorage = { getItem: () => 'token' };
  globalThis.fetch = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => [] }; };
  await api.deletedRequests.list({ project_site: null });
  await api.deletedRequests.list({ project_site: undefined });
  await api.notifications.list({ project_site: null });
  await api.deletedRequests.clear({ project_site: 'Site A' });
  assert.deepEqual(urls, ['/api/deleted-requests', '/api/deleted-requests', '/api/notifications?', '/api/deleted-requests?project_site=Site+A']);
});

test('Admin recovery omits saved login tokens and sends reset secrets only in the request body', async () => {
  const requests = [];
  globalThis.localStorage = { getItem: () => 'stale-login-token' };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await api.auth.requestAdminReset();
  await api.auth.resetAdminPassword({ token: 'reset-secret', new_password: 'New password', confirm_password: 'New password' });
  assert.deepEqual(requests.map(({ url }) => url), ['/api/auth/admin-recovery/request', '/api/auth/admin-recovery/reset']);
  assert.equal(requests[0].options.body, '{}');
  for (const { options } of requests) {
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.publicRequest, undefined);
    assert.equal(options.redirectOnUnauthorized, undefined);
  }
  assert.equal(JSON.parse(requests[1].options.body).token, 'reset-secret');
});

test('An expired initial identity check preserves the open password reset page', async () => {
  globalThis.localStorage = { getItem: () => 'expired-login-token' };
  globalThis.window = { location: { href: '/reset-password' } };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/auth/me');
    assert.equal(options.headers.Authorization, 'Bearer expired-login-token');
    assert.equal(options.redirectOnUnauthorized, undefined);
    return { ok: false, status: 401, json: async () => ({ detail: 'Invalid or expired token' }) };
  };
  await assert.rejects(api.auth.me(), { message: 'Invalid or expired token', status: 401 });
  assert.equal(window.location.href, '/reset-password');
});

test('A temporary identity-check failure preserves credentials and the current page', async () => {
  const removed = [];
  globalThis.localStorage = { getItem: () => 'saved-token', removeItem: (key) => removed.push(key) };
  globalThis.window = { location: { href: '/actuals' } };
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ detail: 'Server is starting. Please try again.' }) });
  await assert.rejects(api.auth.me(), { status: 503 });
  assert.deepEqual(removed, []);
  assert.equal(window.location.href, '/actuals');
});

test('Restoring a saved project can handle expired credentials without forcing a public-page redirect', async () => {
  const removed = [];
  globalThis.localStorage = { getItem: () => 'expired-token', removeItem: (key) => removed.push(key) };
  globalThis.window = { location: { href: '/reset-password' } };
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ detail: 'Invalid or expired token' }) });
  await assert.rejects(api.projectSites.list({ redirectOnUnauthorized: false }), { status: 401 });
  assert.deepEqual(removed, []);
  assert.equal(window.location.href, '/reset-password');
});
