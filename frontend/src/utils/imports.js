import { decimalDifference, decimalProduct, sumDecimals } from './numbers.js';

export const IMPORT_FIELDS = [
  ['name', 'Item name', true], ['qty', 'Quantity'], ['unit_cost', 'Unit cost'],
  ['unit', 'Unit'], ['section', 'Section'], ['grp', 'Group'], ['category', 'Category'],
  ['building_type', 'Building type'], ['budget_no', 'Budget number'],
  ['amount', 'Line amount'], ['budget_scope', 'Building scope'],
];

export const importRowKey = (item) => `${item.sheet_name}::${item.row_number}`;

export function importMappingIssues(columns) {
  const issues = [];
  if (columns.name == null) issues.push('Select the item name column.');
  if (columns.amount == null && (columns.qty == null || columns.unit_cost == null)) {
    issues.push('Select quantity and unit cost columns, or a line amount column.');
  }
  const selected = Object.values(columns).filter((value) => value != null);
  if (new Set(selected).size !== selected.length) issues.push('Each field needs a different column.');
  return issues;
}

export function numericImportValue(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function importRowIssues(row) {
  const issues = [];
  if (!String(row.name || '').trim() || row.name.length > 255) issues.push('Enter an item name up to 255 characters.');
  if (!String(row.unit || '').trim() || row.unit.length > 50) issues.push('Enter a unit up to 50 characters.');
  if (!row.building_type || !row.budget || !row.grp || !row.category) issues.push('Select a building type, budget number, group, and category.');
  if (numericImportValue(row.qty) == null) issues.push('Enter a valid quantity.');
  if (numericImportValue(row.unit_cost) == null) issues.push('Enter a valid unit cost.');
  return issues;
}

export function importCategoryForGroup(group, category) {
  if (group === 'Labour') return 'Labour';
  return category === 'Material/Labour' ? category : 'Materials';
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
  const total = sumDecimals(rows.map((item) => {
    const edit = edits[importRowKey(item)] || {};
    const qty = numericImportValue(edit.qty), cost = numericImportValue(edit.unit_cost);
    return qty != null && cost != null && multiplier > 0
      ? decimalProduct(decimalProduct(qty, multiplier), cost) : 0;
  }));
  const expected = sheet.source_total ?? numericImportValue(meta.reviewedTotal);
  const difference = expected == null ? null : decimalDifference(total, expected);
  const matches = !sheet.total_unreadable && expected != null && Number.isFinite(total) && Math.abs(difference) <= .01;
  return { total, expected, difference, matches, rowCount: rows.length,
    ready: matches && multiplier > 0 && multiplier <= 10000 && meta.confirmed && (meta.budgetScope || '').trim().length <= 255 };
}

export function mappingPayload(layouts, drafts) {
  return Object.fromEntries(layouts.filter((layout) => layout.is_manual || mappingChanged(layout, drafts[layout.sheet_name]))
    .map((layout) => [layout.sheet_name, drafts[layout.sheet_name]]));
}

function previewClaims(analysis) {
  try {
    const payload = analysis?.preview_token?.split('.')[1];
    return JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/')));
  } catch {
    return null;
  }
}

// These claims only guide the interface; the server still verifies the signature.
export function importPreviewExpiresAt(analysis) {
  const exp = previewClaims(analysis)?.exp;
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}

export function sameImportPreviewSources(previous, next) {
  const oldWorkbook = previewClaims(previous)?.workbook;
  if (!oldWorkbook || oldWorkbook !== previewClaims(next)?.workbook) return false;
  if (![previous, next].every((analysis) => Array.isArray(analysis?.sheets)
    && analysis.sheets.every((sheet) => typeof sheet.sheet_name === 'string' && Array.isArray(sheet.items)))) return false;
  const sources = (analysis) => analysis.sheets.map((sheet) => [sheet.sheet_name,
    sheet.items.map(importRowKey).sort()]).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(sources(previous)) === JSON.stringify(sources(next));
}

export function importPreviewMappings(analysis) {
  const layouts = analysis?.layouts || [];
  return mappingPayload(layouts, Object.fromEntries(layouts.map((layout) => [layout.sheet_name, {
    header_row: layout.header_row ?? 1, columns: layout.suggested_mapping,
    skip: layout.status === 'skipped',
  }])));
}
