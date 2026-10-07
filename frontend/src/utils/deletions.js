export async function deleteInventoryItems(items, deleteItem) {
  const deleted = [];
  const failed = [];
  for (const item of items) {
    try {
      await deleteItem(item.id);
      deleted.push(item.id);
    } catch (error) {
      failed.push({ id: item.id, name: item.name, message: error.message || 'Could not delete this item.' });
    }
  }
  return { deleted, failed };
}
