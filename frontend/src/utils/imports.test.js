import test from 'node:test';
import assert from 'node:assert/strict';
import { numericImportValue, importRowIssues, mappingChanged, mappingPayload, importRowKey, sheetReconciliation } from './imports.js';

test('Invalid or blank import numbers require correction and zero remains valid', () => {
  for (const value of ['', null, undefined, 'bad', Infinity, -1]) assert.equal(numericImportValue(value), null);
  assert.equal(numericImportValue('0'), 0);
  assert.equal(numericImportValue('1.25'), 1.25);
  const row = { building_type: 'Flats', budget: 'Budget 1', grp: 'Woods', category: 'Materials', qty: '', unit_cost: 100 };
  assert.equal(importRowIssues(row).length, 1);
  assert.equal(importRowIssues({ ...row, qty: 0 }).length, 0);
});
test('Only manual, edited, or excluded sheets get mapping overrides', () => {
  const layout = { sheet_name: 'Data', status: 'ready', header_row: 2, is_manual: false, suggested_mapping: { name: 0, qty: 1, unit_cost: 2 } };
  const draft = { header_row: 2, skip: false, columns: { name: 0, qty: 1, unit_cost: 2 } };
  assert.equal(mappingChanged(layout, draft), false);
  assert.deepEqual(mappingPayload([layout], { Data: draft }), {});
  assert.equal(mappingChanged(layout, { ...draft, header_row: 0 }), true);
  assert.deepEqual(mappingPayload([{ ...layout, is_manual: true }], { Data: draft }), { Data: draft });
  assert.deepEqual(mappingPayload([layout], { Data: { ...draft, skip: true } }), { Data: { ...draft, skip: true } });
});
test('Headerless mappings preserve row zero and source row keys stay unique', () => {
  const layout = { header_row: 0, status: 'ready', suggested_mapping: { name: 0 } };
  assert.equal(mappingChanged(layout, { header_row: 0, skip: false, columns: { name: 0 } }), false);
  assert.notEqual(importRowKey({ sheet_name: 'A', row_number: 3 }), importRowKey({ sheet_name: 'B', row_number: 3 }));
});

test('Reconciliation scales selected quantities, preserves zero, and requires confirmation', () => {
  const sheet = { source_total: 320, items: [{ sheet_name: 'Budget', row_number: 4 }, { sheet_name: 'Budget', row_number: 5 }] };
  const edits = { 'Budget::4': { qty: 2, unit_cost: 10 }, 'Budget::5': { qty: 3, unit_cost: 20 } };
  const meta = { multiplier: 4, budgetScope: 'SD 22-25', confirmed: false };
  assert.equal(sheetReconciliation(sheet, meta, edits).total, 320);
  assert.equal(sheetReconciliation(sheet, meta, edits).ready, false);
  assert.equal(sheetReconciliation(sheet, { ...meta, confirmed: true }, edits).ready, true);
  assert.equal(sheetReconciliation(sheet, { ...meta, multiplier: 2, confirmed: true }, edits).matches, false);
  assert.equal(sheetReconciliation(sheet, meta, { ...edits, 'Budget::5': { ...edits['Budget::5'], excluded: true } }).total, 80);
  assert.equal(sheetReconciliation({ ...sheet, source_total: 0 }, meta, {}).expected, 0);
  assert.equal(sheetReconciliation({ ...sheet, source_total: null }, meta, {}).matches, false);
  assert.equal(sheetReconciliation({ ...sheet, total_unreadable: true }, { ...meta, confirmed: true }, edits).ready, false);
});

test('Automatically excluded hidden and summary sheets stay excluded until selected', () => {
  const layout = { status: 'skipped', header_row: 2, is_manual: false, suggested_mapping: { name: 1, qty: 2, unit_cost: 4 } };
  const draft = { skip: true, header_row: 2, columns: layout.suggested_mapping };
  assert.equal(mappingChanged(layout, draft), false);
  assert.equal(mappingChanged(layout, { ...draft, skip: false }), true);
});
