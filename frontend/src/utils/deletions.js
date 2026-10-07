import { runSessionBatch } from './batchMutations.js';

export async function deleteInventoryItems(items, deleteItem) {
  const { completed, failed } = await runSessionBatch(items, (item) => deleteItem(item.id), 'Could not delete this item.');
  return {
    deleted: completed.map((item) => item.id),
    failed: failed.map(({ entry: item, message }) => ({ id: item.id, name: item.name, message })),
  };
}
