import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api';
import './BulkUpload.css';

const AMOUNT_HEADER_RE = /(amount|unit[\s_]?cost|cost|price|total|value|rate)/i;
const NUMBER_HEADER_RE = /(qty|quantity|count|number|no|s\/n|serial)/i;

function parseNumeric(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text
    .replace(/[₦$£€\s]/g, '')
    .replace(/,/g, '')
    .replace(/^\((.*)\)$/, '-$1');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

function formatNumericWithCommas(num) {
  const hasDecimals = Math.abs(num % 1) > 0;
  return num.toLocaleString('en-US', {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: hasDecimals ? 2 : 0,
  });
}

function getHeaderKind(header) {
  const key = String(header || '').trim().toLowerCase();
  if (AMOUNT_HEADER_RE.test(key)) return 'amount';
  if (NUMBER_HEADER_RE.test(key)) return 'number';
  return 'text';
}

function formatCellByHeader(header, value) {
  const kind = getHeaderKind(header);
  if (kind === 'text') return value ?? '';
  const parsed = parseNumeric(value);
  if (parsed == null) return value ?? '';
  return formatNumericWithCommas(parsed);
}

export default function BulkUpload() {
  const [file, setFile] = useState(null);
  const [viewerData, setViewerData] = useState(null);
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const [feedback, setFeedback] = useState({ type: '', message: '' });

  const viewMutation = useMutation({
    mutationFn: () => api.bulkUpload.view({ file }),
    onSuccess: (data) => {
      setViewerData(data);
      setActiveSheetIndex(0);
      setFeedback({
        type: 'success',
        message: 'File uploaded successfully. Preview is shown below and nothing was imported into inventory.',
      });
    },
    onError: (err) => {
      setViewerData(null);
      setFeedback({
        type: 'error',
        message: err?.message || 'Unable to preview file. Please check format and try again.',
      });
    },
  });

  const activeSheet = useMemo(
    () => viewerData?.sheets?.[activeSheetIndex] || null,
    [viewerData, activeSheetIndex]
  );

  const handleUpload = (e) => {
    e.preventDefault();
    if (!file) {
      setFeedback({ type: 'warning', message: 'Choose a .xlsx or .csv file first.' });
      return;
    }
    setFeedback({ type: '', message: '' });
    viewMutation.mutate();
  };

  return (
    <div className="bulk-upload-page">
      <div className="card">
        <div className="bulk-upload-head">
          <div>
            <h2>Excel File Viewer</h2>
            <p className="caption">
              Upload an Excel or CSV file and view it in-app. This viewer does not write to inventory or update any records.
            </p>
          </div>
        </div>

        <form className="bulk-upload-form" onSubmit={handleUpload}>
          <div className="form-row">
            <div className="form-group form-group-wide">
              <label>Upload File (.xlsx or .csv)</label>
              <input
                type="file"
                accept=".xlsx,.csv"
                onChange={(e) => {
                  setFile(e.target.files?.[0] || null);
                  setViewerData(null);
                  setActiveSheetIndex(0);
                  setFeedback({ type: '', message: '' });
                }}
                required
              />
            </div>
          </div>

          <div className="action-bar">
            <button className="btn btn-primary" type="submit" disabled={viewMutation.isPending}>
              {viewMutation.isPending ? 'Uploading...' : 'Upload & View'}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setFile(null);
                setViewerData(null);
                setActiveSheetIndex(0);
                setFeedback({ type: '', message: '' });
              }}
            >
              Clear
            </button>
          </div>
        </form>

        {feedback.message && (
          <div className={`alert bulk-alert ${feedback.type ? `bulk-alert-${feedback.type}` : ''}`}>
            {feedback.message}
          </div>
        )}
      </div>

      {viewerData && (
        <div className="card">
          <div className="bulk-upload-head">
            <div>
              <h3>Preview: {viewerData.file_name}</h3>
              <p className="caption">
                Showing uploaded file only. No data has been imported into the system.
              </p>
            </div>
          </div>

          {(viewerData.sheets?.length || 0) > 1 && (
            <div className="bulk-sheet-tabs">
              {viewerData.sheets.map((sheet, index) => (
                <button
                  key={`${sheet.sheet_name}-${index}`}
                  className={index === activeSheetIndex ? 'active' : ''}
                  onClick={() => setActiveSheetIndex(index)}
                  type="button"
                >
                  {sheet.sheet_name}
                </button>
              ))}
            </div>
          )}

          {activeSheet && (
            <>
              <div className="bulk-sheet-meta">
                <span><strong>Sheet:</strong> {activeSheet.sheet_name}</span>
                <span><strong>Rows:</strong> {activeSheet.returned_rows} / {activeSheet.total_rows}</span>
                {activeSheet.truncated && (
                  <span className="bulk-sheet-truncated">Preview truncated for performance.</span>
                )}
              </div>

              <div className="table-wrap">
                <table className="data-table bulk-upload-table">
                  <thead>
                    <tr>
                      <th className="bulk-col-sn">S/N</th>
                      {activeSheet.headers.map((header, idx) => (
                        <th key={`${header}-${idx}`}>{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {activeSheet.rows.length === 0 ? (
                      <tr className="table-empty-row">
                        <td colSpan={Math.max(activeSheet.headers.length + 1, 1)}>No rows found in this sheet.</td>
                      </tr>
                    ) : (
                      activeSheet.rows.map((row, rowIndex) => (
                        <tr key={`row-${rowIndex}`}>
                          <td className="bulk-col-sn">{formatNumericWithCommas(rowIndex + 1)}</td>
                          {activeSheet.headers.map((header, cellIndex) => (
                            <td
                              key={`cell-${rowIndex}-${cellIndex}`}
                              className={getHeaderKind(header) === 'text' ? '' : 'bulk-cell-number'}
                            >
                              {formatCellByHeader(header, row[cellIndex])}
                            </td>
                          ))}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
