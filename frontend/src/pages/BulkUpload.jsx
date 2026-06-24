import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatNaira } from '../api';
import './BulkUpload.css';

const BUILDING_TYPES = ['Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];
const BUDGET_NUMBERS = Array.from({ length: 20 }, (_, i) => i + 1);

const rowKey = (it) => `${it.sheet_name}::${it.row_number}`;
const buildBudget = (bt, bn, grp) => (bt && bn && grp ? `Budget ${bn} - ${bt}(${grp})` : '');

export default function BulkUpload() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);
  const [projectSite, setProjectSite] = useState('');
  const [file, setFile] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [skipExisting, setSkipExisting] = useState(true);
  // Editable working state, seeded from the analysis.
  const [sheetMeta, setSheetMeta] = useState({}); // sheetName -> { buildingType, budgetNumber }
  const [rowEdits, setRowEdits] = useState({});   // rowKey -> { category, grp, section, excluded }
  const [feedback, setFeedback] = useState({ type: '', message: '' });

  const { data: sites = [] } = useQuery({
    queryKey: ['project-sites'],
    queryFn: () => api.projectSites.list(),
  });
  const { data: constants = {} } = useQuery({
    queryKey: ['constants'],
    queryFn: () => api.constants.get(),
  });
  const sectionOptions = constants.CONSTRUCTION_SECTIONS || [];
  const categoryOptions = constants.CATEGORY_OPTIONS || ['Materials', 'Labour', 'Material/Labour'];
  const groupOptions =
    constants.BUDGET_CATEGORIES ||
    ['General Materials', 'Woods', 'Plumbings', 'Irons', 'Labour', 'Electrical', 'Mechanical'];

  const analyzeMutation = useMutation({
    mutationFn: () => api.bulkUpload.analyze({ file, projectSite }),
    onSuccess: (data) => {
      const meta = {};
      const edits = {};
      for (const s of data.sheets) {
        meta[s.sheet_name] = { buildingType: s.building_type || '', budgetNumber: s.budget_number || '' };
        for (const it of s.items) {
          edits[rowKey(it)] = {
            category: it.category || '',
            grp: it.grp || '',
            section: it.section || '',
            excluded: false,
          };
        }
      }
      setSheetMeta(meta);
      setRowEdits(edits);
      setAnalysis(data);
      setStep(2);
      setFeedback({ type: '', message: '' });
    },
    onError: (err) =>
      setFeedback({ type: 'error', message: err?.message || 'Could not read the file.' }),
  });

  const commitMutation = useMutation({
    mutationFn: (rows) => api.bulkUpload.commit({ projectSite, skipExisting, rows }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
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
    setSheetMeta((prev) => ({ ...prev, [sheetName]: { ...prev[sheetName], [field]: value } }));
  const setRowField = (k, field, value) =>
    setRowEdits((prev) => ({ ...prev, [k]: { ...prev[k], [field]: value } }));
  const toggleRow = (k) =>
    setRowEdits((prev) => ({ ...prev, [k]: { ...prev[k], excluded: !prev[k]?.excluded } }));

  // Build the commit payload from the edited working state.
  const includedRows = useMemo(() => {
    if (!analysis) return [];
    const rows = [];
    for (const s of analysis.sheets) {
      const meta = sheetMeta[s.sheet_name] || {};
      for (const it of s.items) {
        const e = rowEdits[rowKey(it)] || {};
        if (e.excluded) continue;
        rows.push({
          name: it.name, qty: it.qty, unit: it.unit, unit_cost: it.unit_cost,
          category: e.category, grp: e.grp, section: e.section,
          building_type: meta.buildingType,
          budget: buildBudget(meta.buildingType, meta.budgetNumber, e.grp),
          project_site: projectSite,
        });
      }
    }
    return rows;
  }, [analysis, sheetMeta, rowEdits, projectSite]);

  const incompleteCount = useMemo(
    () => includedRows.filter((r) => !r.building_type || !r.grp).length,
    [includedRows]
  );

  const handleAnalyze = (e) => {
    e.preventDefault();
    if (!projectSite) return setFeedback({ type: 'warning', message: 'Select a project site first.' });
    if (!file) return setFeedback({ type: 'warning', message: 'Choose a .xlsx file.' });
    analyzeMutation.mutate();
  };

  return (
    <div className="bulk-upload-page">
      <div className="card">
        <h2>Import Budget Workbook</h2>
        <p className="caption">Upload an Istrom budget .xlsx; review and correct what it will create; then import.</p>

        {feedback.message && (
          <div className={`alert bulk-alert bulk-alert-${feedback.type}`}>{feedback.message}</div>
        )}

        {step === 1 && (
          <form className="bulk-upload-form" onSubmit={handleAnalyze}>
            <div className="form-row">
              <div className="form-group">
                <label>Project Site (required)</label>
                <select value={projectSite} onChange={(e) => setProjectSite(e.target.value)} required>
                  <option value="">Select project site…</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group form-group-wide">
                <label>Budget Workbook (.xlsx)</label>
                <input type="file" accept=".xlsx"
                  onChange={(e) => { setFile(e.target.files?.[0] || null); setAnalysis(null); }} required />
              </div>
            </div>
            <button className="btn btn-primary" type="submit" disabled={analyzeMutation.isPending}>
              {analyzeMutation.isPending ? 'Reading…' : 'Read & Preview'}
            </button>
          </form>
        )}
      </div>

      {step === 2 && analysis && (
        <div className="card">
          <div className="bulk-upload-head">
            <h3>Review: {analysis.file_name}</h3>
            <p className="caption">
              {analysis.item_count} item(s) across {analysis.sheet_count} sheet(s).
              {analysis.duplicate_count > 0 && ` ${analysis.duplicate_count} already in inventory.`}
              {' '}Correct any highlighted field before importing.
            </p>
          </div>

          <label className="bulk-toggle">
            <input type="checkbox" checked={skipExisting} onChange={(e) => setSkipExisting(e.target.checked)} />
            Skip rows already in inventory ({analysis.duplicate_count})
          </label>

          {analysis.sheets.map((sheet) => {
            const meta = sheetMeta[sheet.sheet_name] || {};
            return (
              <div key={sheet.sheet_name} className="bulk-sheet-block">
                <div className="bulk-sheet-title">
                  <strong>{sheet.sheet_name}</strong>
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
                      {BUDGET_NUMBERS.map((n) => <option key={n} value={n}>Budget {n}</option>)}
                    </select>
                  </label>
                </div>
                <div className="table-wrap">
                  <table className="data-table bulk-review-table">
                    <thead>
                      <tr><th></th><th>Item</th><th>Qty</th><th>Unit</th><th>Rate</th>
                        <th>Category</th><th>Group</th><th>Section</th><th>Budget</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {sheet.items.map((it) => {
                        const k = rowKey(it);
                        const e = rowEdits[k] || {};
                        const budget = buildBudget(meta.buildingType, meta.budgetNumber, e.grp);
                        return (
                          <tr key={k} className={e.excluded ? 'bulk-row-excluded' : ''}>
                            <td><input type="checkbox" checked={!e.excluded} onChange={() => toggleRow(k)} /></td>
                            <td>{it.name}</td>
                            <td>{it.qty}</td>
                            <td>{it.unit}</td>
                            <td>{formatNaira(it.unit_cost)}</td>
                            <td>
                              <select value={e.category} onChange={(ev) => setRowField(k, 'category', ev.target.value)}>
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
              </div>
            );
          })}

          <div className="action-bar">
            <button className="btn btn-secondary" type="button" onClick={() => setStep(1)}>Back</button>
            <button className="btn btn-primary" type="button"
              disabled={commitMutation.isPending || includedRows.length === 0}
              onClick={() => commitMutation.mutate(includedRows)}>
              {commitMutation.isPending ? 'Importing…' : `Import ${includedRows.length} item(s)`}
            </button>
            {incompleteCount > 0 && (
              <span className="bulk-warn-note">
                {incompleteCount} item(s) missing building type or group — they will import with an empty budget.
              </span>
            )}
          </div>
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
