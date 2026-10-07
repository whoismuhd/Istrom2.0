import { budgetBalance, plannedAmount } from './budgets.js';
import { decimalDifference, sumDecimals } from './numbers.js';

export function inventorySectionOptions(items, standardSections = []) {
  return [...new Set([...standardSections, ...items.map((item) => item.section)]
    .filter((section) => typeof section === 'string' && section.trim()))];
}

export function formatQuantity(value) {
  if (Number(value) !== 0 && Math.abs(Number(value)) < 0.000001) return Number(value).toLocaleString('en-NG', { maximumSignificantDigits: 6 });
  return Number(value).toLocaleString('en-NG', { maximumFractionDigits: 6 });
}

export function requestAvailability(quantity, available) {
  const requested = Number(quantity);
  const rawRemaining = Number(available);
  const remaining = Math.max(0, rawRemaining);
  const valid = quantity !== '' && Number.isFinite(requested) && requested > 0;
  const known = available != null && Number.isFinite(rawRemaining);
  const shortage = valid && known ? Math.max(0, decimalDifference(requested, remaining)) : 0;
  return { valid, known, requested, remaining, shortage, insufficient: shortage > 0 };
}

export function summarizeActuals(item, actuals, buildingSubtype = '') {
  const records = actuals.filter((record) => record.item_id === item.id && (!buildingSubtype || record.building_subtype === buildingSubtype));
  const used = sumDecimals(records.map((record) => record.actual_qty));
  const cost = sumDecimals(records.map((record) => record.actual_cost));
  return { used, cost, averageUnitCost: used > 0 ? cost / used : 0, remaining: item.qty, balance: budgetBalance(plannedAmount(item), cost) };
}
