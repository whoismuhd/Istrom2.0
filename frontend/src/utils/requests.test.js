import test from 'node:test';
import assert from 'node:assert/strict';
import { requestCostSummary } from './requests.js';

test('Pending requests show their requested price override, including a zero price', () => {
  const request = { status: 'Pending', qty: 8, item_unit_cost: 1000 };
  assert.deepEqual(requestCostSummary(request), { recorded: false, unitCost: 1000, totalCost: 8000, hasOverride: false });
  assert.equal(requestCostSummary({ ...request, current_price: 1500 }).totalCost, 12000);
  assert.deepEqual(requestCostSummary({ ...request, current_price: 0 }), { recorded: false, unitCost: 0, totalCost: 0, hasOverride: true });
});

test('Approved request costs come from recorded actuals when current inventory prices change', () => {
  const request = { status: 'Approved', qty: 8, item_unit_cost: 2000, actual_cost: 12000 };
  assert.deepEqual(requestCostSummary(request), { recorded: true, unitCost: 1500, totalCost: 12000, hasOverride: false });
  assert.equal(requestCostSummary({ ...request, item_unit_cost: 3000 }).totalCost, 12000);
  assert.equal(requestCostSummary({ ...request, actual_cost: 0 }).totalCost, 0);
});

test('Unknown or overflowing costs are shown as unavailable rather than a zero estimate', () => {
  for (const request of [
    { status: 'Pending', qty: 8 },
    { status: 'Pending', qty: 1e200, item_unit_cost: 1e200 },
    { status: 'Approved', qty: 8, item_unit_cost: 1000 },
  ]) assert.equal(requestCostSummary(request).totalCost, null);
});
