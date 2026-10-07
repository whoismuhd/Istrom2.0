export const IMPORT_FIELDS = [
  ['name', 'Item name', true], ['qty', 'Quantity', true], ['unit_cost', 'Unit cost', true],
  ['unit', 'Unit'], ['section', 'Section'], ['grp', 'Group'], ['category', 'Category'],
  ['building_type', 'Building type'], ['budget_no', 'Budget number'],
  ['amount', 'Line amount'], ['budget_scope', 'Building scope'],
];

export const importRowKey = (item) => `${item.sheet_name}::${item.row_number}`;

export function numericImportValue(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function importRowIssues(row) {
  const issues = [];
  if (!row.building_type || !row.budget || !row.grp || !row.category) issues.push('Select a building type, budget number, group, and category.');
  if (numericImportValue(row.qty) == null) issues.push('Enter a valid quantity.');
  if (numericImportValue(row.unit_cost) == null) issues.push('Enter a valid unit cost.');
  return issues;
}

export function mappingChanged(layout, draft) {
  if (!draft) return false;
  if (Boolean(draft.skip) !== (layout.status === 'skipped')) return true;
  if (draft.skip) return false;
  if (Number(draft.header_row) !== (layout.header_row ?? 1)) return true;
  return IMPORT_FIELDS.some(([field]) => (draft.columns[field] ?? '') !== (layout.suggested_mapping[field] ?? ''));
}

export function sheetReconciliation(sheet, meta, edits) {
  const multiplier = numericImportValue(meta.multiplier);
  const rows = sheet.items.filter((item) => !edits[importRowKey(item)]?.excluded);
  const total = rows.reduce((sum, item) => {
    const edit = edits[importRowKey(item)] || {};
    const qty = numericImportValue(edit.qty), cost = numericImportValue(edit.unit_cost);
    return sum + (qty != null && cost != null && multiplier > 0 ? qty * cost * multiplier : 0);
  }, 0);
  const expected = sheet.source_total ?? numericImportValue(meta.reviewedTotal);
  const difference = expected == null ? null : total - expected;
  const matches = !sheet.total_unreadable && expected != null && Number.isFinite(total) && Math.abs(difference) <= .01;
  return { total, expected, difference, matches, rowCount: rows.length,
    ready: matches && multiplier > 0 && multiplier <= 10000 && meta.confirmed && (meta.budgetScope || '').trim().length <= 255 };
}

export function mappingPayload(layouts, drafts) {
  return Object.fromEntries(layouts.filter((layout) => layout.is_manual || mappingChanged(layout, drafts[layout.sheet_name]))
    .map((layout) => [layout.sheet_name, drafts[layout.sheet_name]]));
}
