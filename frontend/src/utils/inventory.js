import { plannedAmount } from './budgets.js';

export function formatQuantity(value) {
  return Number(value).toLocaleString('en-NG', { maximumFractionDigits: 6 });
}

export function requestAvailability(quantity, available) {
  const requested = Number(quantity);
  const rawRemaining = Number(available);
  const remaining = Math.max(0, rawRemaining);
  const valid = quantity !== '' && Number.isFinite(requested) && requested > 0;
  const known = available != null && Number.isFinite(rawRemaining);
  const shortage = valid && known ? Math.max(0, requested - remaining) : 0;
  return { valid, known, requested, remaining, shortage, insufficient: shortage > 0 };
}

export function summarizeActuals(item, actuals, buildingSubtype = '') {
  const records = actuals.filter((record) => record.item_id === item.id && (!buildingSubtype || record.building_subtype === buildingSubtype));
  const used = records.reduce((sum, record) => sum + record.actual_qty, 0);
  const cost = records.reduce((sum, record) => sum + record.actual_cost, 0);
  return { used, cost, averageUnitCost: used > 0 ? cost / used : 0, remaining: item.qty, balance: plannedAmount(item) - cost };
}
