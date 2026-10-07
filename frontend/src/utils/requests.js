import { decimalProduct } from './numbers.js';

function nonnegative(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function requestCostSummary(request) {
  const quantity = nonnegative(request.qty);
  const recorded = request.status === 'Approved';
  const unitCost = recorded
    ? quantity > 0 && nonnegative(request.actual_cost) != null ? Number(request.actual_cost) / quantity : null
    : nonnegative(request.current_price ?? request.item_unit_cost);
  const total = recorded ? nonnegative(request.actual_cost) : quantity != null && unitCost != null ? decimalProduct(quantity, unitCost) : null;
  return { recorded, unitCost: nonnegative(unitCost), totalCost: Number.isFinite(total) ? total : null,
    hasOverride: request.current_price != null };
}
