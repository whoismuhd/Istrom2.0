import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteInventoryItems } from './deletions.js';
import { runSessionBatch } from './batchMutations.js';
import { clearWorkspaceStates } from './workspaceState.js';

test('Mixed deletion outcomes preserve every failed item and continue after failures', async () => {
  const items = [1, 2, 3, 4].map((id) => ({ id, name: `Item ${id}` }));
  const attempts = [];
  const result = await deleteInventoryItems(items, async (id) => {
    attempts.push(id);
    if (id === 1 || id === 3) throw new Error('Linked to approved usage');
  });
  assert.deepEqual(attempts, [1, 2, 3, 4]);
  assert.deepEqual(result.deleted, [2, 4]);
  assert.deepEqual(result.failed, [
    { id: 1, name: 'Item 1', message: 'Linked to approved usage' },
    { id: 3, name: 'Item 3', message: 'Linked to approved usage' },
  ]);
});

test('An aborted deletion stops before sending the remaining items and retains their failure details', async () => {
  const attempts = [];
  const result = await deleteInventoryItems([1, 2, 3].map((id) => ({ id, name: `Item ${id}` })), async (id) => {
    attempts.push(id);
    throw Object.assign(new Error('Your sign-in changed. Please try again.'), { name: 'AbortError' });
  });
  assert.deepEqual(attempts, [1]);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.failed.map((item) => [item.id, item.name]), [[1, 'Item 1'], [2, 'Item 2'], [3, 'Item 3']]);
  assert.equal(result.failed[0].message, 'Your sign-in changed. Please try again.');
  assert.match(result.failed[1].message, /sign-in changed/);
});

test('Changing the workspace session stops a batch even when the first mutation succeeded', async () => {
  const attempts = [];
  const result = await runSessionBatch([1, 2, 3], async (id) => {
    attempts.push(id);
    clearWorkspaceStates({ length: 0, key: () => null });
  });
  assert.deepEqual(attempts, [1]);
  assert.deepEqual(result.completed, [1]);
  assert.deepEqual(result.failed.map(({ entry }) => entry), [2, 3]);
});

test('Replacing the login token stops old request actions without waiting for another account request', async () => {
  let token = 'first-account';
  globalThis.sessionStorage = { getItem: () => token };
  const attempts = [];
  const result = await runSessionBatch([10, 11, 12], async (id) => {
    attempts.push(id);
    token = 'second-account';
  });
  assert.deepEqual(attempts, [10]);
  assert.deepEqual(result.completed, [10]);
  assert.deepEqual(result.failed.map(({ entry }) => entry), [11, 12]);
  delete globalThis.sessionStorage;
});

test('Bulk request actions preserve successful IDs and continue after ordinary validation failures', async () => {
  const attempts = [];
  const result = await runSessionBatch([10, 11, 12], async (id) => {
    attempts.push(id);
    if (id === 11) throw new Error('Request is unavailable');
  });
  assert.deepEqual(attempts, [10, 11, 12]);
  assert.deepEqual(result.completed, [10, 12]);
  assert.deepEqual(result.failed, [{ entry: 11, message: 'Request is unavailable' }]);
});
