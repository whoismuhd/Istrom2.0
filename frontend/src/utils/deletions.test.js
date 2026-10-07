import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteInventoryItems } from './deletions.js';

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
