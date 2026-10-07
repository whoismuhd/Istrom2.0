import test from 'node:test';
import assert from 'node:assert/strict';
import { requestAvailability, summarizeActuals, inventorySectionOptions, formatQuantity } from './inventory.js';
import { plannedAmount, plannedQuantity } from './budgets.js';

const item = { id: 1, qty: 6, unit_cost: 1100, planned_qty: 10, planned_unit_cost: 1000 };
const actuals = [
  { item_id: 1, actual_qty: 3, actual_cost: 3300, building_subtype: 'B1' },
  { item_id: 1, actual_qty: 1, actual_cost: 0, building_subtype: 'B2' },
  { item_id: 2, actual_qty: 50, actual_cost: 50000, building_subtype: 'B1' },
];

test('Inventory filters include custom workbook sections without duplicates or blank options', () => {
  const items = [
    { section: 'Concrete' }, { section: 'Site mobilisation' }, { section: 'Site mobilisation' },
    { section: 'Roof inspection' }, { section: '' }, { section: '  ' }, {},
  ];
  const sections = inventorySectionOptions(items, ['Concrete', 'Electrical']);
  assert.deepEqual(sections, ['Concrete', 'Electrical', 'Site mobilisation', 'Roof inspection']);
  assert.deepEqual(items.filter((item) => item.section === sections[2]), [items[1], items[2]]);
});

test('Original inventory totals stay fixed after approved usage', () => {
  assert.equal(plannedQuantity(item), 10);
  assert.equal(plannedAmount(item), 10000);
  assert.deepEqual(summarizeActuals(item, actuals), { used: 4, cost: 3300, averageUnitCost: 825, remaining: 6, balance: 6700 });
});

test('Block filters limit usage and cost while remaining availability stays site-wide', () => {
  assert.deepEqual(summarizeActuals(item, actuals, 'B1'), { used: 3, cost: 3300, averageUnitCost: 1100, remaining: 6, balance: 6700 });
  assert.equal(summarizeActuals(item, actuals, 'B2').averageUnitCost, 0);
});

test('Shortage warnings use remaining quantity rather than original quantity', () => {
  assert.equal(requestAvailability(8, item.qty).shortage, 2);
  assert.equal(requestAvailability(8, item.qty).insufficient, true);
  assert.equal(requestAvailability(6, item.qty).insufficient, false);
  assert.equal(requestAvailability(1, 0).shortage, 1);
  assert.equal(requestAvailability(0.5, 0.25).shortage, 0.25);
});

test('Blank, invalid, and unknown quantities are handled explicitly', () => {
  for (const value of ['', 0, -1, 'NaN', 'Infinity']) assert.equal(requestAvailability(value, 6).valid, false);
  assert.equal(requestAvailability(5, null).known, false);
});

test('Over-quantity approvals retain signed balances and all usage costs', () => {
  const overItem = { ...item, qty: -2 };
  const overActuals = [{ item_id: 1, actual_qty: 12, actual_cost: 12000 }];
  assert.deepEqual(summarizeActuals(overItem, overActuals), { used: 12, cost: 12000, averageUnitCost: 1000, remaining: -2, balance: -2000 });
  assert.equal(plannedAmount(overItem), 10000);
  assert.equal(requestAvailability(3, -2).remaining, 0);
  assert.equal(requestAvailability(3, -2).shortage, 3);
});

test('Fractional usage totals exactly match the original quantity and price', () => {
  const fractional = { id: 1, qty: 0, planned_qty: 0.3, planned_unit_cost: 1 };
  const records = [{ item_id: 1, actual_qty: 0.1, actual_cost: 0.1 }, { item_id: 1, actual_qty: 0.2, actual_cost: 0.2 }];
  assert.deepEqual(summarizeActuals(fractional, records), { used: 0.3, cost: 0.3, averageUnitCost: 1, remaining: 0, balance: 0 });
  assert.equal(requestAvailability(0.3, 0.3).insufficient, false);
  const realShortage = requestAvailability(0.3000001, 0.3);
  assert.equal(realShortage.shortage, 0.0000001);
  assert.equal(formatQuantity(realShortage.shortage), '0.0000001');
});
