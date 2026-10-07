import { IMPORT_FIELDS, importRowKey as rowKey, importRowIssues, numericImportValue, mappingChanged, mappingPayload, sheetReconciliation } from '../utils/imports.js';
import LoadError from '../components/LoadError';
import { useAuth } from '../contexts/useAuth';
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatNaira } from '../api';
import './BulkUpload.css';

const BUILDING_TYPES = ['Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];
const BUDGET_NUMBERS = Array.from({ length: 20 }, (_, i) => i + 1);

const buildBudget = (bt, bn, grp) => (bt && bn && grp ? `Budget ${bn} - ${bt}(${grp})` : '');

export default function BulkUpload() {
  const queryClient = useQueryClient();
  const { user, isGlobalAdmin, getEffectiveProjectSite } = useAuth();
  const [step, setStep] = useState(1);
  const [projectSite, setProjectSite] = useState(() => getEffectiveProjectSite() || user?.project_site || '');
  const [file, setFile] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [columnMappings, setColumnMappings] = useState({});
  // Editable working state, seeded from the analysis.
  const [sheetMeta, setSheetMeta] = useState({}); // sheetName -> { buildingType, budgetNumber }
  const [rowEdits, setRowEdits] = useState({});   // rowKey -> { category, grp, section, excluded }
  const [feedback, setFeedback] = useState({ type: '', message: '' });
  const [openSheets, setOpenSheets] = useState({});

  const { data: globalSites = [], error: sitesError, refetch: retrySites } = useQuery({
    queryKey: ['projectSites'],
    queryFn: () => api.projectSites.list(),
    enabled: isGlobalAdmin,
  });
  const { data: constants = {}, error: constantsError, refetch: retryConstants } = useQuery({
    queryKey: ['constants'],
    queryFn: () => api.constants.get(),
  });
  const sites = isGlobalAdmin ? globalSites : [{ id: user?.project_site, name: user?.project_site }];
  const sectionOptions = constants.CONSTRUCTION_SECTIONS || [];
  const categoryOptions = constants.CATEGORY_OPTIONS || ['Materials', 'Labour', 'Material/Labour'];
  const groupOptions =
    constants.BUDGET_CATEGORIES ||
    ['General Materials', 'Woods', 'Plumbings', 'Irons', 'Labour', 'Electrical', 'Mechanical'];

  const analyzeMutation = useMutation({
    mutationFn: (mappings) => api.bulkUpload.analyze({ file, projectSite, mappings }),
    onSuccess: (data) => {
      const meta = {};
      const edits = {};
      for (const s of data.sheets) {
        meta[s.sheet_name] = { buildingType: BUILDING_TYPES.includes(s.building_type) ? s.building_type : '', budgetNumber: Number.isSafeInteger(s.budget_number) && s.budget_number > 0 ? s.budget_number : '',
          budgetScope: s.budget_scope || '', multiplier: s.suggested_multiplier || 1, confirmed: false, reviewedTotal: '', included: true };
        for (const it of s.items) {
          edits[rowKey(it)] = {
            category: categoryOptions.includes(it.category) ? it.category : '',
            grp: groupOptions.includes(it.grp) ? it.grp : '',
            section: it.section || '',
            qty: it.qty ?? '', unit_cost: it.unit_cost ?? '',
            excluded: Boolean(it.excluded_by_default),
          };
        }
      }
      setSheetMeta(meta);
      setRowEdits(edits);
      setAnalysis(data);
      setOpenSheets({});
      setColumnMappings(Object.fromEntries((data.layouts || []).map((layout) => [layout.sheet_name, {
        header_row: layout.header_row ?? 1, columns: layout.suggested_mapping,
        skip: layout.status === 'skipped',
      }])));
      setStep(2);
      setFeedback({ type: '', message: '' });
    },
    onError: (err) =>
      setFeedback({ type: 'error', message: err?.message || 'Could not read the file.' }),
  });

  const commitMutation = useMutation({
    mutationFn: (rows) => api.bulkUpload.commit({ projectSite, skipExisting: true, rows, previewToken: analysis.preview_token,
      sheetChecks: analysis.sheets.filter((s) => sheetMeta[s.sheet_name]?.included).map((s) => ({ sheet_name: s.sheet_name,
        multiplier: Number(sheetMeta[s.sheet_name].multiplier), budget_scope: sheetMeta[s.sheet_name].budgetScope.trim(),
        confirmed: sheetMeta[s.sheet_name].confirmed, reviewed_total: numericImportValue(sheetMeta[s.sheet_name].reviewedTotal) })) }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['actuals'] });
      setStep(3);
      setFeedback({
        type: 'success',
        message: `Imported ${res.inserted_count} item(s). Skipped ${res.skipped.length}.`,
      });
    },
    onError: (err) =>
      setFeedback({ type: 'error', message: err?.message || 'Import failed.' }),
  });

  const setSheetField = (sheetName, field, value) =>
    setSheetMeta((prev) => ({ ...prev, [sheetName]: { ...prev[sheetName], [field]: value,
      ...(field !== 'confirmed' ? { confirmed: false } : {}) } }));
  const invalidateConfirmation = (k) => {
    const sheet = analysis?.sheets.find((s) => s.items.some((it) => rowKey(it) === k));
    if (sheet) setSheetField(sheet.sheet_name, 'confirmed', false);
  };
  const setRowField = (k, field, value) => {
    invalidateConfirmation(k);
    setRowEdits((prev) => ({ ...prev, [k]: { ...prev[k], [field]: value } }));
  };
  const toggleRow = (k) => {
    invalidateConfirmation(k);
    setRowEdits((prev) => ({ ...prev, [k]: { ...prev[k], excluded: !prev[k]?.excluded } }));
  };

  // Bulk-apply a field (grp/section) to every row in one sheet.
  const setSheetAllRows = (sheetName, field, value) => {
    const sheet = analysis?.sheets.find((s) => s.sheet_name === sheetName);
    if (!sheet || !value) return;
    setSheetField(sheetName, 'confirmed', false);
    setRowEdits((prev) => {
      const next = { ...prev };
      for (const it of sheet.items) {
        const k = rowKey(it);
        next[k] = { ...next[k], [field]: value };
      }
      return next;
    });
  };

  // Build the commit payload from the edited working state.
  const includedRows = useMemo(() => {
    if (!analysis) return [];
    const rows = [];
    for (const s of analysis.sheets) {
      const meta = sheetMeta[s.sheet_name] || {};
      if (!meta.included) continue;
      for (const it of s.items) {
        const e = rowEdits[rowKey(it)] || {};
        if (e.excluded) continue;
        rows.push({
          name: it.name, qty: numericImportValue(e.qty) == null || numericImportValue(meta.multiplier) == null ? null : numericImportValue(e.qty) * Number(meta.multiplier), unit: it.unit, unit_cost: numericImportValue(e.unit_cost),
          category: e.category, grp: e.grp, section: e.section,
          building_type: meta.buildingType,
          budget: buildBudget(meta.buildingType, meta.budgetNumber, e.grp),
          project_site: projectSite,
          budget_scope: (meta.budgetScope || '').trim(), source_sheet: it.sheet_name, source_row: it.row_number,
          import_sheet: s.sheet_name, source_qty: numericImportValue(e.qty),
        });
      }
    }
    return rows;
  }, [analysis, sheetMeta, rowEdits, projectSite]);

  const incompleteCount = useMemo(
    () => includedRows.filter((r) => importRowIssues(r).length > 0).length,
    [includedRows]
  );
  const reconciliations = useMemo(() => (analysis?.sheets || []).map((sheet) => ({ sheet,
    meta: sheetMeta[sheet.sheet_name] || {}, ...sheetReconciliation(sheet, sheetMeta[sheet.sheet_name] || {}, rowEdits) })), [analysis, sheetMeta, rowEdits]);
  const pendingChecks = reconciliations.filter((r) => r.meta.included && !r.ready).length;
  const reviewedTotal = reconciliations.filter((r) => r.meta.included).reduce((sum, r) => sum + r.total, 0);
  const budgetNumbers = [...new Set([...BUDGET_NUMBERS, ...(analysis?.sheets || []).map((s) => s.budget_number).filter((n) => Number.isSafeInteger(n) && n > 0)])].sort((a, b) => a - b);

  const handleAnalyze = (e) => {
    e.preventDefault();
    if (!projectSite) return setFeedback({ type: 'warning', message: 'Select a project site first.' });
    if (!file) return setFeedback({ type: 'warning', message: 'Choose a .xlsx file.' });
    analyzeMutation.mutate({});
  };

  const layouts = analysis?.layouts || [];
  const mappingsDirty = layouts.some((layout) => mappingChanged(layout, columnMappings[layout.sheet_name]));
  const unresolvedSheets = layouts.filter((layout) => layout.status === 'needs_mapping').length;
  const changeMapping = (sheetName, field, value) => {
    setColumnMappings((prev) => ({ ...prev, [sheetName]: {
      ...prev[sheetName], columns: { ...prev[sheetName].columns, [field]: value === '' ? undefined : Number(value) },
    } }));
  };
  const changeMappingOption = (sheetName, field, value) => {
    setColumnMappings((prev) => ({ ...prev, [sheetName]: { ...prev[sheetName], [field]: value } }));
  };
  const mappingErrors = layouts.flatMap((layout) => {
    const draft = columnMappings[layout.sheet_name];
    if (!draft || draft.skip || (!layout.is_manual && !mappingChanged(layout, draft))) return [];
    const selected = Object.values(draft.columns).filter((value) => value != null);
    return [
      ...IMPORT_FIELDS.filter(([field, , required]) => required && draft.columns[field] == null).map(([, label]) => `${layout.sheet_name}: select a column for ${label}.`),
      ...(new Set(selected).size !== selected.length ? [`${layout.sheet_name}: each field needs a different column.`] : []),
      ...(!Number.isInteger(Number(draft.header_row)) || Number(draft.header_row) < 0 ? [`${layout.sheet_name}: enter a valid header row.`] : []),
    ];
  });

  const handleDownloadTemplate = async () => {
    try {
      const blob = await api.bulkUpload.downloadTemplate();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'istrom-import-template.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setFeedback({ type: 'error', message: err?.message || 'Could not download the template.' });
    }
  };

  if (sitesError || constantsError) return <LoadError error={sitesError || constantsError} onRetry={() => { retrySites(); retryConstants(); }} />;
  if (user?.user_type !== 'admin') return <div className="card">Administrator access is required to import inventory.</div>;

  return (
    <div className="bulk-upload-page">
      <div className="card">
        <h1>Import workbook</h1>
        <p className="caption">Upload an Excel workbook, check the column mapping and item details, then import.</p>

        {feedback.message && (
          <div className={`alert bulk-alert bulk-alert-${feedback.type}`}>{feedback.message}</div>
        )}

        {step === 1 && (
          <form className="bulk-upload-form" onSubmit={handleAnalyze}>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="import-project-site">Project site (required)</label>
                <select id="import-project-site" value={projectSite} onChange={(e) => setProjectSite(e.target.value)} disabled={analyzeMutation.isPending} required>
                  <option value="">Select project site…</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group form-group-wide">
                <label htmlFor="import-workbook">Excel workbook (.xlsx)</label>
                <input id="import-workbook" type="file" accept=".xlsx" disabled={analyzeMutation.isPending}
                  onChange={(e) => { setFile(e.target.files?.[0] || null); setAnalysis(null); setColumnMappings({}); }} required />
              </div>
            </div>
            <div className="action-bar">
              <button className="btn btn-primary" type="submit" disabled={analyzeMutation.isPending}>
                {analyzeMutation.isPending ? 'Reading…' : 'Preview workbook'}
              </button>
              <button className="btn btn-secondary" type="button" onClick={handleDownloadTemplate}>
                Download blank template
              </button>
            </div>
            <p className="caption bulk-template-hint">
              Use the blank template for a new budget. Review the preview before importing.
            </p>
          </form>
        )}
      </div>

      {step === 2 && analysis && (
        <div className="card">
          <fieldset className="bulk-review-fields" disabled={analyzeMutation.isPending || commitMutation.isPending}>
          <div className="bulk-upload-head">
            <h3>Review: {analysis.file_name}</h3>
            <p className="caption">
              {analysis.item_count} item(s) across {analysis.sheet_count} sheet(s).
              {analysis.duplicate_count > 0 && ` ${analysis.duplicate_count} already in inventory.`}
              {' '}Correct any highlighted field before importing.
            </p>
          </div>

          <section className="bulk-total-panel" aria-label="Import totals">
            <div><span>Selected import total</span><strong>{formatNaira(reviewedTotal)}</strong></div>
            <div><span>Budgets awaiting review</span><strong>{pendingChecks}</strong></div>
            <p>Check each budget against its Excel total. Confirm the building scope and quantity multiplier before importing.</p>
          </section>

          {analysis.duplicate_count > 0 && <p className="caption">{analysis.duplicate_count} source rows already imported will be skipped.</p>}

          <section className="bulk-mapping-section" aria-label="Workbook column mapping">
            <h3>Check sheet columns</h3>
            <p className="caption">Columns are detected from their headings. Expand a sheet to check them, choose unfamiliar columns, or exclude a sheet. Updating the preview resets row corrections below.</p>
            {layouts.map((layout) => {
              const draft = columnMappings[layout.sheet_name];
              if (!draft) return null;
              const chosenHeader = layout.sample_rows.find((row) => row.row_number === Number(draft.header_row));
              return <details key={layout.sheet_name} className="bulk-mapping-sheet" open={layout.status === 'needs_mapping'}>
                <summary>{layout.sheet_name} <span className={`bulk-chip ${layout.status === 'needs_mapping' ? 'bulk-chip-warn' : ''}`}>
                  {layout.status === 'needs_mapping' ? 'Choose columns' : layout.status === 'skipped' ? 'Excluded / empty' : 'Columns detected'}
                </span></summary>
                {layout.warnings.length > 0 && <ul className="bulk-sheet-warnings">{layout.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
                <label className="bulk-toggle"><input type="checkbox" checked={draft.skip}
                  onChange={(e) => changeMappingOption(layout.sheet_name, 'skip', e.target.checked)} />Exclude this sheet</label>
                {!draft.skip && <>
                  <label className="bulk-inline-field">Header row for {layout.sheet_name}
                    <input aria-label={`Header row for ${layout.sheet_name}`} type="number" min="0" max="10000" value={draft.header_row}
                      onChange={(e) => changeMappingOption(layout.sheet_name, 'header_row', e.target.value)} />
                  </label>
                  <p className="caption">Use 0 if the sheet has no header row.</p>
                  <div className="bulk-mapping-grid">{IMPORT_FIELDS.map(([field, label, required]) => <label key={field}>
                    {label}{required ? ' (required)' : ''}
                    <select aria-label={`${label} column for ${layout.sheet_name}`} value={draft.columns[field] ?? ''}
                      onChange={(e) => changeMapping(layout.sheet_name, field, e.target.value)}>
                      <option value="">{required ? 'Choose column…' : 'Not in this sheet'}</option>
                      {layout.columns.map((col) => <option key={col.index} value={col.index}>
                        {chosenHeader ? `${col.label.split(':')[0]}: ${chosenHeader.cells[col.index] || 'unnamed'}` : col.label}
                      </option>)}
                    </select>
                  </label>)}</div>
                  <div className="table-wrap bulk-source-preview"><table className="data-table">
                    <caption>Source rows from {layout.sheet_name} (first 20 non-empty rows)</caption>
                    <thead><tr><th>Row</th>{layout.columns.map((col) => <th key={col.index}>{col.label.split(':')[0]}</th>)}</tr></thead>
                    <tbody>{layout.sample_rows.map((row) => <tr key={row.row_number} className={row.row_number === Number(draft.header_row) ? 'bulk-header-row' : ''}>
                      <th>{row.row_number}</th>{layout.columns.map((col) => <td key={col.index}>{row.cells[col.index] || ''}</td>)}
                    </tr>)}</tbody>
                  </table></div>
                </>}
              </details>;
            })}
            {(mappingsDirty || unresolvedSheets > 0) && <div className="alert bulk-alert-warning">Check or exclude every sheet that needs column mapping, then update the preview before importing.</div>}
            {mappingErrors.length > 0 && <ul className="bulk-sheet-warnings">{mappingErrors.map((error) => <li key={error}>{error}</li>)}</ul>}
            <button type="button" className="btn btn-secondary" disabled={analyzeMutation.isPending || mappingErrors.length > 0 || commitMutation.isPending}
              onClick={() => analyzeMutation.mutate(mappingPayload(layouts, columnMappings))}>
              {analyzeMutation.isPending ? 'Updating…' : 'Update preview with these columns'}
            </button>
          </section>

          {analysis.sheets.map((sheet) => {
            const meta = sheetMeta[sheet.sheet_name] || {};
            const review = reconciliations.find((r) => r.sheet.sheet_name === sheet.sheet_name);
            return (
              <div key={sheet.sheet_name} className={`bulk-sheet-block${!meta.included ? ' bulk-budget-excluded' : ''}`}>
                <div className="bulk-budget-heading">
                  <label className="bulk-toggle"><input type="checkbox" checked={meta.included} aria-label={`Include budget ${sheet.sheet_name}`}
                    onChange={(e) => setSheetField(sheet.sheet_name, 'included', e.target.checked)} /><strong>{sheet.sheet_name}</strong></label>
                  <span className={`bulk-chip ${meta.included && !review.matches ? 'bulk-chip-error' : ''}`}>{!meta.included ? 'Excluded' : review.matches ? 'Totals match' : 'Needs correction'}</span>
                </div>
                <div className="bulk-sheet-title">
                  <label className="bulk-inline-field">
                    Building
                    <select
                      className={meta.buildingType ? '' : 'bulk-select-warn'}
                      value={meta.buildingType}
                      onChange={(e) => setSheetField(sheet.sheet_name, 'buildingType', e.target.value)}>
                      <option value="">— set —</option>
                      {BUILDING_TYPES.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </label>
                  <label className="bulk-inline-field">
                    Budget
                    <select
                      className={meta.budgetNumber ? '' : 'bulk-select-warn'}
                      value={meta.budgetNumber}
                      onChange={(e) => setSheetField(sheet.sheet_name, 'budgetNumber', Number(e.target.value) || '')}>
                      <option value="">— set —</option>
                      {budgetNumbers.map((n) => <option key={n} value={n}>Budget {n}</option>)}
                    </select>
                  </label>
                  <label className="bulk-inline-field bulk-scope-field">Building scope
                    <input aria-label={`Building scope for ${sheet.sheet_name}`} maxLength="255" value={meta.budgetScope}
                      onChange={(e) => setSheetField(sheet.sheet_name, 'budgetScope', e.target.value)} /></label>
                  <label className="bulk-inline-field">Quantity multiplier
                    <input aria-label={`Quantity multiplier for ${sheet.sheet_name}`} type="number" min="0.000001" max="10000" step="any" value={meta.multiplier}
                      onChange={(e) => setSheetField(sheet.sheet_name, 'multiplier', e.target.value)} /></label>
                </div>
                {sheet.source_total_label && <p className="bulk-source-label">{sheet.source_total_label}</p>}
                {sheet.summary_label && sheet.summary_label !== sheet.source_total_label && <p className="caption">Summary: {sheet.summary_label}</p>}
                <div className="bulk-reconciliation">
                  <span>Excel total{sheet.source_total_cell ? ` (${sheet.source_total_cell})` : ''}<strong>{sheet.source_total == null ? 'Not available' : formatNaira(sheet.source_total)}</strong></span>
                  <span>Import total<strong>{formatNaira(review.total)}</strong></span>
                  <span className={!review.matches ? 'bulk-total-error' : ''}>Difference<strong>{review.difference == null ? 'Review required' : Math.abs(review.difference) <= .01 ? formatNaira(0) : `${formatNaira(Math.abs(review.difference))} ${review.difference > 0 ? 'over' : 'short'}`}</strong></span>
                </div>
                {sheet.source_total_formula && <details className="bulk-formula"><summary>View Excel total formula</summary><code>{sheet.source_total_formula}</code></details>}
                {sheet.source_total == null && !sheet.total_unreadable && <label className="bulk-inline-field">Reviewed budget total
                  <input aria-label={`Reviewed budget total for ${sheet.sheet_name}`} type="number" min="0" step="any" value={meta.reviewedTotal}
                    onChange={(e) => setSheetField(sheet.sheet_name, 'reviewedTotal', e.target.value)} /></label>}
                {sheet.warnings?.length > 0 && <ul className="bulk-sheet-warnings">{sheet.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
                <label className="bulk-toggle"><input type="checkbox" checked={meta.confirmed} disabled={!meta.included || !review.matches}
                  aria-label={`Confirm scope and total for ${sheet.sheet_name}`} onChange={(e) => setSheetField(sheet.sheet_name, 'confirmed', e.target.checked)} />
                  Confirm building scope, multiplier and total</label>
                <button type="button" className="btn btn-secondary btn-sm" aria-expanded={Boolean(openSheets[sheet.sheet_name])}
                  onClick={() => setOpenSheets((prev) => ({ ...prev, [sheet.sheet_name]: !prev[sheet.sheet_name] }))}>
                  {openSheets[sheet.sheet_name] ? 'Hide' : 'Review'} {sheet.item_count} source lines ({review.rowCount} selected)
                </button>
                {openSheets[sheet.sheet_name] && <>
                <div className="bulk-sheet-title bulk-row-tools">
                  <span className="bulk-bulk-sep">apply to all rows:</span>
                  <label className="bulk-inline-field">
                    Group
                    <select value="" onChange={(e) => setSheetAllRows(sheet.sheet_name, 'grp', e.target.value)}>
                      <option value="">—</option>
                      {groupOptions.map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </label>
                  <label className="bulk-inline-field">
                    Section
                    <select value="" onChange={(e) => setSheetAllRows(sheet.sheet_name, 'section', e.target.value)}>
                      <option value="">—</option>
                      {sectionOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                </div>
                <div className="table-wrap">
                  <table className="data-table bulk-review-table">
                    <thead>
                      <tr><th>Include</th><th>Item / source row</th><th>Source qty</th><th>Import qty</th><th>Unit</th><th>Rate</th>
                        <th>Category</th><th>Group</th><th>Section</th><th>Budget</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {sheet.items.map((it) => {
                        const k = rowKey(it);
                        const e = rowEdits[k] || {};
                        const budget = buildBudget(meta.buildingType, meta.budgetNumber, e.grp);
                        return (
                          <tr key={k} className={e.excluded ? 'bulk-row-excluded' : ''}>
                            <td><input type="checkbox" aria-label={`Include ${it.name} row ${it.row_number} in ${it.sheet_name}`} checked={!e.excluded} onChange={() => toggleRow(k)} /></td>
                            <td>{it.name}<small>Excel row {it.row_number}{it.source_amount != null ? ` · Amount ${formatNaira(it.source_amount)}` : ''}</small>{[...(it.warnings || []), ...(it.errors || [])].length > 0 && <details className="bulk-row-notes"><summary>Source warnings</summary><ul>{[...(it.warnings || []), ...(it.errors || [])].map((note, i) => <li key={i}>{note}</li>)}</ul></details>}</td>
                            <td><input type="number" min="0" step="any" aria-label={`Quantity for ${it.name} row ${it.row_number} in ${it.sheet_name}`}
                              className={numericImportValue(e.qty) == null ? 'bulk-select-warn' : ''} value={e.qty}
                              onChange={(ev) => setRowField(k, 'qty', ev.target.value)} /></td>
                            <td>{numericImportValue(e.qty) == null || numericImportValue(meta.multiplier) == null ? '—' : numericImportValue(e.qty) * Number(meta.multiplier)}</td>
                            <td>{it.unit}</td>
                            <td><input type="number" min="0" step="any" aria-label={`Unit cost for ${it.name} row ${it.row_number} in ${it.sheet_name}`}
                              className={numericImportValue(e.unit_cost) == null ? 'bulk-select-warn' : ''} value={e.unit_cost}
                              onChange={(ev) => setRowField(k, 'unit_cost', ev.target.value)} />
                              <small>{numericImportValue(e.unit_cost) != null ? formatNaira(numericImportValue(e.unit_cost)) : 'Value required'}</small></td>
                            <td>
                              <select className={e.category ? '' : 'bulk-select-warn'} value={e.category} onChange={(ev) => setRowField(k, 'category', ev.target.value)}>
                                <option value="">— set —</option>
                                {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                              </select>
                            </td>
                            <td>
                              <select className={e.grp ? '' : 'bulk-select-warn'}
                                value={e.grp} onChange={(ev) => setRowField(k, 'grp', ev.target.value)}>
                                <option value="">— set —</option>
                                {groupOptions.map((g) => <option key={g} value={g}>{g}</option>)}
                              </select>
                            </td>
                            <td>
                              <select className={it.section_matched ? '' : 'bulk-select-warn'}
                                value={e.section} onChange={(ev) => setRowField(k, 'section', ev.target.value)}>
                                {!sectionOptions.includes(e.section) && e.section && (
                                  <option value={e.section}>{e.section} (as-is)</option>
                                )}
                                <option value="">— none —</option>
                                {sectionOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                              </select>
                            </td>
                            <td className={budget ? 'bulk-cell-budget' : 'bulk-cell-warn'}>{budget || 'incomplete'}</td>
                            <td>{it.duplicate ? <span className="bulk-chip bulk-chip-warn">duplicate</span> : 'new'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                </>}
              </div>
            );
          })}

          <div className="action-bar">
            <button className="btn btn-secondary" type="button" onClick={() => setStep(1)}>Back</button>
            <button className="btn btn-primary" type="button"
              disabled={commitMutation.isPending || analyzeMutation.isPending || includedRows.length === 0 || incompleteCount > 0 || pendingChecks > 0 || mappingsDirty || unresolvedSheets > 0 || includedRows.length > 2000}
              onClick={() => commitMutation.mutate(includedRows)}>
              {commitMutation.isPending ? 'Importing…' : `Import ${includedRows.length} item(s)`}
            </button>
            {includedRows.length > 2000 && <span className="bulk-warn-note">Select up to 2,000 rows for one import. Split larger workbooks into smaller files.</span>}
            {incompleteCount > 0 && (
              <span className="bulk-warn-note">
                {incompleteCount} item(s) need valid quantities, costs, and budget fields before import.
              </span>
            )}
            {pendingChecks > 0 && <span className="bulk-warn-note">{pendingChecks} budget(s) need matching totals and confirmation.</span>}
          </div>
          </fieldset>
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <h3>Import complete</h3>
          <p className="caption">{feedback.message}</p>
          <button className="btn btn-primary" type="button"
            onClick={() => { setStep(1); setFile(null); setAnalysis(null); }}>
            Import another file
          </button>
        </div>
      )}
    </div>
  );
}
