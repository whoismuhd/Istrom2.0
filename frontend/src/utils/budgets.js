import { decimalDifference, decimalProduct, roundMoney, sumDecimals } from './numbers.js';

/** Compare the budget number, rather than matching a prefix such as 1 in 10. */
export function matchesBudget(label, selectedBudget) {
  if (!selectedBudget || selectedBudget === 'All') return true;
  const number = String(label || '').match(/^Budget\s+(\d+)\b/i)?.[1];
  const selected = String(selectedBudget).match(/^Budget\s+(\d+)\b/i)?.[1];
  return number != null && selected != null && Number(number) === Number(selected);
}

export function budgetNumberOptions(items) {
  const numbers = new Set(Array.from({ length: 20 }, (_, i) => i + 1));
  for (const item of items) {
    const number = Number(String(item.budget || '').match(/^Budget\s+(\d+)\b/i)?.[1]);
    if (Number.isSafeInteger(number) && number > 0) numbers.add(number);
  }
  return [...numbers].sort((a, b) => a - b).map((number) => `Budget ${number}`);
}

export function plannedQuantity(item) {
  return item.planned_qty ?? item.qty ?? 0;
}

export function plannedUnitCost(item) {
  return item.planned_unit_cost ?? item.unit_cost ?? 0;
}

export function plannedAmount(item) {
  return decimalProduct(plannedQuantity(item), plannedUnitCost(item));
}

export function plannedTotal(items) {
  return sumDecimals(items.map(plannedAmount));
}

export function buildingTypeLabel(item) {
  return item.building_type?.trim() || 'Unassigned building';
}

export function budgetBuildingTypes(items, standardTypes = []) {
  return [...new Set([...standardTypes, ...items.map(buildingTypeLabel)])];
}

export function budgetBalance(planned, actual) {
  return decimalDifference(roundMoney(planned), roundMoney(actual));
}

export function budgetPosition(planned, actual) {
  const balance = budgetBalance(planned, actual);
  return { remainingBudget: Math.max(0, balance), overBudget: Math.max(0, -balance) };
}

export function scopeTotals(items) {
  const groups = new Map();
  for (const item of items) {
    const scope = item.budget_scope || 'Site budget';
    const key = JSON.stringify([item.project_site || '', scope]);
    const group = groups.get(key) || { scope, projectSite: item.project_site || '', items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].map(({items, ...group}) => ({...group, total:plannedTotal(items)}));
}

export function toCSV(rows) {
  return rows.map((row) => row.map((value) => {
    let text = String(value ?? '');
    // Spreadsheet applications can execute formulas in text cells on opening.
    if (typeof value === 'string' && /^[\s]*[=+\-@]|^[\t\r\n]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(',')).join('\r\n');
}
