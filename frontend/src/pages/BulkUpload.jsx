import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatNaira } from '../api';
import './BulkUpload.css';

const BUILDING_TYPES = ['Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];

export default function BulkUpload() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);
  const [projectSite, setProjectSite] = useState('');
  const [file, setFile] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [skipExisting, setSkipExisting] = useState(true);
  const [excluded, setExcluded] = useState(() => new Set());
  const [feedback, setFeedback] = useState({ type: '', message: '' });

  const { data: sites = [] } = useQuery({
    queryKey: ['project-sites'],
    queryFn: () => api.projectSites.list(),
  });

  const analyzeMutation = useMutation({
    mutationFn: () => api.bulkUpload.analyze({ file, projectSite }),
    onSuccess: (data) => {
      setAnalysis(data);
      setExcluded(new Set());
      setStep(2);
      setFeedback({ type: '', message: '' });
    },
    onError: (err) =>
      setFeedback({ type: 'error', message: err?.message || 'Could not read the file.' }),
  });

  const commitMutation = useMutation({
    mutationFn: (rows) =>
      api.bulkUpload.commit({ projectSite, skipExisting, rows }),
    onSuccess: (res) => {
      queryClient.invalidateQueries(['items']);
      setStep(3);
      setFeedback({
        type: 'success',
        message: `Imported ${res.inserted_count} item(s). Skipped ${res.skipped.length}.`,
      });
    },
    onError: (err) =>
      setFeedback({ type: 'error', message: err?.message || 'Import failed.' }),
  });

  const rowKey = (it) => `${it.sheet_name}::${it.row_number}`;

  const includedRows = useMemo(() => {
    if (!analysis) return [];
    const rows = [];
    for (const sheet of analysis.sheets) {
      for (const it of sheet.items) {
        if (excluded.has(rowKey(it))) continue;
        rows.push({
          name: it.name, qty: it.qty, unit: it.unit, unit_cost: it.unit_cost,
          category: it.category, budget: it.budget, section: it.section,
          building_type: sheet.building_type, project_site: projectSite, grp: it.grp,
        });
      }
    }
    return rows;
  }, [analysis, excluded, projectSite]);

  const toggleRow = (it) => {
    const k = rowKey(it);
    setExcluded((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  };

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
        <p className="caption">Upload an Istrom budget .xlsx; review what it will create; then import.</p>

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
            <h3>Preview: {analysis.file_name}</h3>
            <p className="caption">
              {analysis.item_count} item(s) across {analysis.sheet_count} sheet(s).
              {analysis.duplicate_count > 0 && ` ${analysis.duplicate_count} already in inventory.`}
            </p>
          </div>

          <label className="bulk-toggle">
            <input type="checkbox" checked={skipExisting} onChange={(e) => setSkipExisting(e.target.checked)} />
            Skip rows already in inventory ({analysis.duplicate_count})
          </label>

          {analysis.sheets.map((sheet) => (
            <div key={sheet.sheet_name} className="bulk-sheet-block">
              <div className="bulk-sheet-title">
                <strong>{sheet.sheet_name}</strong>
                <span className={`bulk-chip ${sheet.building_type_confident ? '' : 'bulk-chip-warn'}`}>
                  {sheet.building_type || 'building type?'}
                </span>
                <span className={`bulk-chip ${sheet.budget_confident ? '' : 'bulk-chip-warn'}`}>
                  {sheet.budget_number ? `Budget ${sheet.budget_number}` : 'budget?'}
                </span>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr><th></th><th>Item</th><th>Qty</th><th>Unit</th><th>Rate</th>
                      <th>Category</th><th>Group</th><th>Section</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {sheet.items.map((it) => {
                      const k = rowKey(it);
                      const isExcluded = excluded.has(k);
                      return (
                        <tr key={k} className={isExcluded ? 'bulk-row-excluded' : ''}>
                          <td><input type="checkbox" checked={!isExcluded} onChange={() => toggleRow(it)} /></td>
                          <td>{it.name}</td>
                          <td>{it.qty}</td>
                          <td>{it.unit}</td>
                          <td>{formatNaira(it.unit_cost)}</td>
                          <td>{it.category || '—'}</td>
                          <td>{it.grp || '—'}</td>
                          <td className={it.section_matched ? '' : 'bulk-cell-warn'}>{it.section || '—'}</td>
                          <td>{it.duplicate ? <span className="bulk-chip bulk-chip-warn">duplicate</span> : 'new'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <div className="action-bar">
            <button className="btn btn-secondary" type="button" onClick={() => setStep(1)}>Back</button>
            <button className="btn btn-primary" type="button"
              disabled={commitMutation.isPending || includedRows.length === 0}
              onClick={() => commitMutation.mutate(includedRows)}>
              {commitMutation.isPending ? 'Importing…' : `Import ${includedRows.length} item(s)`}
            </button>
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
