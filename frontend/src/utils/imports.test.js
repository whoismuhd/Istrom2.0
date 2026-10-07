import test from 'node:test';
import assert from 'node:assert/strict';
import { numericImportValue, importRowIssues, importMappingIssues, importCategoryForGroup, mappingChanged, mappingPayload, importRowKey, sheetReconciliation, importPreviewExpiresAt, sameImportPreviewSources, importPreviewMappings } from './imports.js';

const previewToken = (claims) => `header.${btoa(JSON.stringify(claims))}.signature`;

test('Saved previews use the token expiry without treating client claims as server authorization', () => {
  assert.equal(importPreviewExpiresAt({ preview_token: previewToken({ exp: 1234 }) }), 1234000);
  for (const analysis of [null, {}, { preview_token: 'invalid' }, { preview_token: previewToken({ exp: '1234' }) }]) {
    assert.equal(importPreviewExpiresAt(analysis), 0);
  }
});

test('Refreshing a saved preview preserves edits only for the same workbook and source rows', () => {
  const previous = { preview_token: previewToken({ workbook: 'same-file', exp: 1000 }), sheets: [
    { sheet_name: 'Budget A', items: [{ sheet_name: 'Source', row_number: 3 }, { sheet_name: 'Source', row_number: 4 }] },
    { sheet_name: 'Budget B', items: [{ sheet_name: 'Source', row_number: 7 }] },
  ] };
  const next = { ...previous, preview_token: previewToken({ workbook: 'same-file', exp: 2000 }), sheets: [...previous.sheets].reverse() };
  assert.equal(sameImportPreviewSources(previous, next), true);
  assert.equal(sameImportPreviewSources(previous, { ...next, preview_token: previewToken({ workbook: 'different-file' }) }), false);
  assert.equal(sameImportPreviewSources(previous, { ...next, sheets: [previous.sheets[0]] }), false);
  assert.equal(sameImportPreviewSources(previous, { ...next, sheets: [{ ...previous.sheets[0], items: [{ sheet_name: 'Source', row_number: 8 }] }, previous.sheets[1]] }), false);
  assert.equal(sameImportPreviewSources({ ...previous, file_name: 'original.xlsx' }, { ...next, file_name: 'renamed.xlsx' }), true);
  assert.equal(sameImportPreviewSources(previous, { ...next, file_name: 'original.xlsx',
    preview_token: previewToken({ workbook: 'different-file' }) }), false);
});

test('Workbook recovery uses reviewed mappings, including headerless and manually excluded sheets', () => {
  const layouts = [
    { sheet_name: 'Detected', status: 'ready', header_row: 3, is_manual: false,
      suggested_mapping: { name: 0, qty: 1, unit_cost: 3 } },
    { sheet_name: 'Headerless', status: 'ready', header_row: 0, is_manual: true,
      suggested_mapping: { name: 1, amount: 4 } },
    { sheet_name: 'Excluded', status: 'skipped', header_row: null, is_manual: true,
      suggested_mapping: {} },
  ];
  assert.deepEqual(importPreviewMappings({ layouts }), {
    Headerless: { header_row: 0, columns: { name: 1, amount: 4 }, skip: false },
    Excluded: { header_row: 1, columns: {}, skip: true },
  });
  assert.deepEqual(importPreviewMappings(null), {});
  assert.equal(layouts[1].header_row, 0);
});

test('Mapping supports priced quantities or line amounts and rejects ambiguous selections', () => {
  assert.deepEqual(importMappingIssues({ name: 0, qty: 2, unit_cost: 4 }), []);
  assert.deepEqual(importMappingIssues({ name: 0, amount: 4 }), []);
  assert.deepEqual(importMappingIssues({ name: 0, qty: 2, amount: 4 }), []);
  assert.equal(importMappingIssues({ name: 0, qty: 2 }).length, 1);
  assert.equal(importMappingIssues({ amount: 4 }).length, 1);
  assert.equal(importMappingIssues({ name: 0, qty: 0, unit_cost: 4 }).length, 1);
});

test('Invalid or blank import numbers require correction and zero remains valid', () => {
  for (const value of ['', null, undefined, 'bad', Infinity, -1]) assert.equal(numericImportValue(value), null);
  assert.equal(numericImportValue('0'), 0);
  assert.equal(numericImportValue('1.25'), 1.25);
  const row = { name: 'Planks', unit: 'length', building_type: 'Flats', budget: 'Budget 1', grp: 'Woods', category: 'Materials', qty: '', unit_cost: 100 };
  assert.equal(importRowIssues(row).length, 1);
  assert.equal(importRowIssues({ ...row, qty: 0 }).length, 0);
});

test('Missing units cannot reach import and can be corrected without changing quantity or cost', () => {
  const row = { name: 'Transport', unit: '', building_type: 'Flats', budget: 'Budget 1', grp: 'General Materials', category: 'Materials', qty: 1, unit_cost: 15000 };
  assert.deepEqual(importRowIssues(row), ['Enter a unit up to 50 characters.']);
  assert.deepEqual(importRowIssues({ ...row, unit: 'sum' }), []);
  assert.equal(importRowIssues({ ...row, unit: 'sum', name: ' ' }).length, 1);
  assert.equal(importRowIssues({ ...row, unit: 'x'.repeat(51) }).length, 1);
});

test('Changing a trade group keeps category consistent and preserves combined costs', () => {
  assert.equal(importCategoryForGroup('Labour', 'Materials'), 'Labour');
  assert.equal(importCategoryForGroup('Woods', 'Labour'), 'Materials');
  assert.equal(importCategoryForGroup('Irons', 'Material/Labour'), 'Material/Labour');
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

test('Reconciliation accepts one kobo of source rounding without binary errors', () => {
  const sheet = {source_total:100, items:[{sheet_name:'Budget', row_number:4}]};
  const meta = {multiplier:1, budgetScope:'Block A', confirmed:true};
  const review = sheetReconciliation(sheet, meta, {'Budget::4':{qty:1, unit_cost:100.01}});
  assert.equal(review.difference, 0.01);
  assert.equal(review.ready, true);
  assert.equal(sheetReconciliation(sheet, meta, {'Budget::4':{qty:1, unit_cost:100.02}}).ready, false);
});

test('Large imports and fractional multipliers reconcile exactly', () => {
  const items = Array.from({length:2000}, (_, index) => ({sheet_name:'Budget', row_number:index+1}));
  const edits = Object.fromEntries(items.map((item) => [importRowKey(item), {qty:1, unit_cost:1_000_000_000.01}]));
  const meta = {multiplier:1, confirmed:true};
  const review = sheetReconciliation({source_total:2_000_000_000_020, items}, meta, edits);
  assert.equal(review.total, 2_000_000_000_020);
  assert.equal(review.ready, true);
  const fractional = sheetReconciliation({source_total:0.006, items:[items[0]]}, {...meta, multiplier:0.2},
    {[importRowKey(items[0])]:{qty:0.1, unit_cost:0.3}});
  assert.equal(fractional.total, 0.006);
  assert.equal(fractional.ready, true);
});
