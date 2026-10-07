import { IMPORT_FIELDS, importRowKey as rowKey, importRowIssues, importMappingIssues, importCategoryForGroup, numericImportValue, mappingChanged, mappingPayload, sheetReconciliation, importPreviewExpiresAt, sameImportPreviewSources, importPreviewMappings } from '../utils/imports.js';
import LoadError from '../components/LoadError';
import { useAuth } from '../contexts/useAuth';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatNaira } from '../api';
import './BulkUpload.css';
import { downloadBlob } from '../utils/downloads';
import { decimalProduct, sumDecimals } from '../utils/numbers';
import { readImportDraft, saveImportDraft, clearImportDraft, IMPORT_DRAFT_MAX_FILE_SIZE, captureImportDraftIdentity, isCurrentImportDraftIdentity } from '../utils/importDrafts';
import { workspaceGeneration } from '../utils/workspaceState';

const BUILDING_TYPES = ['Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];
const BUDGET_NUMBERS = Array.from({ length: 20 }, (_, i) => i + 1);
const PAGE_SIZE = 50;

const buildBudget = (bt, bn, grp) => (bt && bn && grp ? `Budget ${bn} - ${bt}(${grp})` : '');

export default function BulkUpload() {
  const queryClient = useQueryClient();
  const { user, isGlobalAdmin, getEffectiveProjectSite } = useAuth();
  const [step, setStep] = useState(1);
  const [projectSite, setProjectSite] = useState(() => getEffectiveProjectSite() || user?.project_site || '');
  const [file, setFile] = useState(null);
  const [fileName, setFileName] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [columnMappings, setColumnMappings] = useState({});
  const [sheetMeta, setSheetMeta] = useState({});
  const [rowEdits, setRowEdits] = useState({});
  const [feedback, setFeedback] = useState({ type: '', message: '' });
  const [activeSheetName, setActiveSheetName] = useState('');
  const [rowSearch, setRowSearch] = useState('');
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [rowPage, setRowPage] = useState(0);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [draftSaving, setDraftSaving] = useState(false);
  const [previewClock, setPreviewClock] = useState(Date.now);
  const pendingSaves = useRef(0);
  const mounted = useRef(false);
  const fileInput = useRef(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    readImportDraft(user).then((draft) => {
      if (!active || !draft) return;
      setProjectSite(draft.projectSite);
      setFile(draft.file || null);
      setFileName(draft.file?.name || draft.fileName || draft.analysis?.file_name || '');
      setAnalysis(draft.analysis || null);
      setColumnMappings(draft.columnMappings || {});
      setSheetMeta(draft.sheetMeta || {});
      setRowEdits(draft.rowEdits || {});
      const restoredSheets = draft.analysis?.sheets || [];
      setActiveSheetName(restoredSheets.some((sheet) => sheet.sheet_name === draft.activeSheetName)
        ? draft.activeSheetName : restoredSheets[0]?.sheet_name || '');
      setRowSearch(typeof draft.rowSearch === 'string' ? draft.rowSearch : '');
      setIssuesOnly(draft.issuesOnly === true);
      setRowPage(Number.isSafeInteger(draft.rowPage) && draft.rowPage >= 0 ? draft.rowPage : 0);
      setReviewConfirmed(draft.reviewConfirmed === true);
      setStep(draft.analysis ? 2 : 1);
      if (!draft.file && (draft.fileName || draft.analysis?.file_name)) {
        setDraftError('The saved workbook could not be restored. Choose it again.');
      }
    }).catch(() => {
      if (active) setDraftError('This browser could not restore the saved preview.');
    }).finally(() => { if (active) setDraftReady(true); });
    return () => { active = false; };
  }, [user]);

  useEffect(() => {
    if (!draftReady || step !== 2 || !analysis) return;
    let active = true;
    pendingSaves.current += 1;
    saveImportDraft(user, { projectSite, file, analysis, columnMappings, sheetMeta, rowEdits,
      activeSheetName, rowSearch, issuesOnly, rowPage, reviewConfirmed }).then(() => {
      if (active) { setDraftSaving(false); setDraftError(file ? '' : 'The saved workbook could not be restored. Choose it again.'); }
    }).catch(() => {
      if (active) { setDraftSaving(false); setDraftError('Preview could not be saved in this browser. Keep this tab open until you finish.'); }
    }).finally(() => { pendingSaves.current -= 1; });
    return () => { active = false; };
  }, [draftReady, step, user, projectSite, file, analysis, columnMappings, sheetMeta, rowEdits,
    activeSheetName, rowSearch, issuesOnly, rowPage, reviewConfirmed]);

  useEffect(() => {
    const beforeUnload = (event) => {
      if (pendingSaves.current > 0) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    const timer = window.setInterval(() => setPreviewClock(Date.now()), 30000);
    return () => { window.removeEventListener('beforeunload', beforeUnload); window.clearInterval(timer); };
  }, []);

  const { data: globalSites = [], error: sitesError, isPending: sitesLoading, refetch: retrySites } = useQuery({
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
  const previewExpired = Boolean(analysis) && importPreviewExpiresAt(analysis) <= previewClock;
  const siteAvailable = sites.some((site) => site.name === projectSite);

  const markDraftChanged = () => setDraftSaving(true);
  const persistStagedDraft = async (nextSite, nextFile, nextName, replaceFile = false) => {
    pendingSaves.current += 1;
    setDraftSaving(true);
    try {
      // Remove the old pointer immediately when the file is cleared or replaced.
      const removing = replaceFile ? clearImportDraft() : null;
      const saving = nextSite || nextName
        ? saveImportDraft(user, { stage: 'workbook', projectSite: nextSite, fileName: nextName, analysis: null, file: nextFile })
        : clearImportDraft();
      await Promise.all([removing, saving]);
      setDraftError(!nextFile && nextName ? 'The saved workbook could not be restored. Choose it again.' : '');
      return true;
    } catch {
      setDraftError('Draft could not be saved in this browser. Keep this tab open until you finish.');
      return false;
    } finally {
      pendingSaves.current -= 1;
      if (pendingSaves.current === 0) setDraftSaving(false);
    }
  };
  const selectWorkbook = (event) => {
    const nextFile = event.target.files?.[0] || null;
    const nextName = nextFile?.name || '';
    setFile(nextFile);
    setFileName(nextName);
    setAnalysis(null);
    setColumnMappings({});
    setFeedback(nextFile && nextFile.size > IMPORT_DRAFT_MAX_FILE_SIZE
      ? { type: 'warning', message: 'Choose a workbook no larger than 15 MB.' } : { type: '', message: '' });
    persistStagedDraft(projectSite, nextFile, nextName, true);
  };
  const discardDraft = () => {
    clearImportDraft().catch(() => setDraftError('Could not remove the saved preview from this browser.'));
    setStep(1);
    setFile(null);
    setFileName('');
    if (fileInput.current) fileInput.current.value = '';
    setAnalysis(null);
    setColumnMappings({});
    setSheetMeta({});
    setRowEdits({});
    setReviewConfirmed(false);
    setFeedback({ type: '', message: '' });
    setDraftSaving(false);
    setDraftError('');
  };

  const analyzeMutation = useMutation({
    mutationFn: async (variables) => {
      const { mappings, staged = false, selectedFile = file, selectedSite = projectSite } = variables;
      variables.sessionGeneration = workspaceGeneration();
      if (staged) await persistStagedDraft(selectedSite, selectedFile, selectedFile.name);
      if (!mounted.current || variables.sessionGeneration !== workspaceGeneration()) {
        throw new Error('The import screen is no longer open.');
      }
      variables.draftIdentity = captureImportDraftIdentity();
      return api.bulkUpload.analyze({ file: selectedFile, projectSite: selectedSite, mappings });
    },
    onSuccess: (data, { keepEdits, draftIdentity, sessionGeneration, replacementFile, previousAnalysis }) => {
      if (!mounted.current || sessionGeneration !== workspaceGeneration()
        || (draftIdentity && !isCurrentImportDraftIdentity(draftIdentity))) return;
      if (keepEdits) {
        if (!sameImportPreviewSources(previousAnalysis || analysis, data)) {
          setFeedback({ type: 'error', message: 'Choose the original workbook. Your edits are unchanged.' });
          return;
        }
        markDraftChanged();
        if (replacementFile) {
          setFile(replacementFile);
          setFileName(replacementFile.name);
          setDraftError('');
        }
        setAnalysis(data);
        setReviewConfirmed(false);
        setPreviewClock(Date.now());
        setFeedback({ type: '', message: '' });
        return;
      }
      const meta = {};
      const edits = {};
      for (const s of data.sheets) {
        meta[s.sheet_name] = { buildingType: BUILDING_TYPES.includes(s.building_type) ? s.building_type : '', budgetNumber: Number.isSafeInteger(s.budget_number) && s.budget_number > 0 ? s.budget_number : '',
          budgetScope: s.budget_scope || '', multiplier: s.suggested_multiplier || 1, reviewedTotal: '', included: true };
        for (const it of s.items) {
          edits[rowKey(it)] = {
            name: it.name, unit: it.unit || '',
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
      const firstIncompleteSheet = data.sheets.find((s) => s.items.some((it) => !it.excluded_by_default
        && (!it.name?.trim() || !it.unit?.trim() || !it.grp || !it.category || it.qty == null || it.unit_cost == null)));
      setActiveSheetName((firstIncompleteSheet || data.sheets[0])?.sheet_name || '');
      setRowSearch('');
      setIssuesOnly(false);
      setRowPage(0);
      setReviewConfirmed(false);
      setColumnMappings(Object.fromEntries((data.layouts || []).map((layout) => [layout.sheet_name, {
        header_row: layout.header_row ?? 1, columns: layout.suggested_mapping,
        skip: layout.status === 'skipped',
      }])));
      setStep(2);
      markDraftChanged();
      setPreviewClock(Date.now());
      setFeedback({ type: '', message: '' });
    },
    onError: (err, { draftIdentity, sessionGeneration }) => {
      if (mounted.current && sessionGeneration === workspaceGeneration()
        && (!draftIdentity || isCurrentImportDraftIdentity(draftIdentity))) {
        setFeedback({ type: 'error', message: err?.message || 'Could not read the file.' });
      }
    },
  });

  const recoverWorkbook = (event) => {
    const replacementFile = event.target.files?.[0];
    event.target.value = '';
    if (!replacementFile) return;
    if (!replacementFile.name.toLowerCase().endsWith('.xlsx')) {
      setFeedback({ type: 'warning', message: 'Choose the original .xlsx workbook.' });
      return;
    }
    if (replacementFile.size > IMPORT_DRAFT_MAX_FILE_SIZE) {
      setFeedback({ type: 'warning', message: 'Choose a workbook no larger than 15 MB.' });
      return;
    }
    setFeedback({ type: '', message: '' });
    analyzeMutation.mutate({ mappings: importPreviewMappings(analysis), keepEdits: true,
      selectedFile: replacementFile, replacementFile, selectedSite: projectSite, previousAnalysis: analysis });
  };

  const commitMutation = useMutation({
    mutationFn: (variables) => {
      variables.draftIdentity = captureImportDraftIdentity();
      return api.bulkUpload.commit({ projectSite, skipExisting: true, rows: variables.rows, previewToken: analysis.preview_token,
        sheetChecks: analysis.sheets.filter((s) => sheetMeta[s.sheet_name]?.included).map((s) => ({ sheet_name: s.sheet_name,
          multiplier: Number(sheetMeta[s.sheet_name].multiplier), budget_scope: sheetMeta[s.sheet_name].budgetScope.trim(),
          confirmed: reviewConfirmed, reviewed_total: numericImportValue(sheetMeta[s.sheet_name].reviewedTotal) })) });
    },
    onSuccess: (res, { draftIdentity }) => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['actuals'] });
      if (!mounted.current || (draftIdentity && !isCurrentImportDraftIdentity(draftIdentity))) return;
      if (draftIdentity) clearImportDraft(draftIdentity).catch(() => setDraftError('Could not remove the saved preview from this browser.'));
      setStep(3);
      setDraftSaving(false);
      setFeedback({
        type: 'success',
        message: `${res.inserted_count} ${res.inserted_count === 1 ? 'item' : 'items'} imported${res.skipped.length ? ` · ${res.skipped.length} skipped` : ''}.`,
      });
    },
    onError: (err, { draftIdentity }) => {
      if (mounted.current && (!draftIdentity || isCurrentImportDraftIdentity(draftIdentity))) {
        setFeedback({ type: 'error', message: err?.message || 'Import failed.' });
      }
    },
  });

  const setSheetField = (sheetName, field, value) => {
    markDraftChanged();
    setReviewConfirmed(false);
    setSheetMeta((prev) => ({ ...prev, [sheetName]: { ...prev[sheetName], [field]: value } }));
  };
  const setRowField = (k, field, value) => {
    markDraftChanged();
    setReviewConfirmed(false);
    setRowEdits((prev) => ({ ...prev, [k]: { ...prev[k], [field]: value,
      ...(field === 'grp' ? { category: importCategoryForGroup(value, prev[k]?.category) } : {}) } }));
  };
  const toggleRow = (k) => {
    markDraftChanged();
    setReviewConfirmed(false);
    setRowEdits((prev) => ({ ...prev, [k]: { ...prev[k], excluded: !prev[k]?.excluded } }));
  };

  // Bulk-apply a field (grp/section) to every row in one sheet.
  const setSheetAllRows = (sheetName, field, value) => {
    const sheet = analysis?.sheets.find((s) => s.sheet_name === sheetName);
    if (!sheet || !value) return;
    markDraftChanged();
    setReviewConfirmed(false);
    setRowEdits((prev) => {
      const next = { ...prev };
      for (const it of sheet.items) {
        const k = rowKey(it);
        next[k] = { ...next[k], [field]: value,
          ...(field === 'grp' ? { category: importCategoryForGroup(value, next[k]?.category) } : {}) };
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
          name: (e.name || '').trim(), qty: numericImportValue(e.qty) == null || numericImportValue(meta.multiplier) == null ? null : decimalProduct(numericImportValue(e.qty), Number(meta.multiplier)), unit: (e.unit || '').trim(), unit_cost: numericImportValue(e.unit_cost),
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

  const incompleteRows = useMemo(() => includedRows.filter((row) => importRowIssues(row).length > 0), [includedRows]);
  const incompleteCount = incompleteRows.length;
  const reconciliations = useMemo(() => (analysis?.sheets || []).map((sheet) => ({ sheet,
    meta: sheetMeta[sheet.sheet_name] || {}, ...sheetReconciliation(sheet, { ...sheetMeta[sheet.sheet_name], confirmed: true }, rowEdits),
    incompleteCount: incompleteRows.filter((row) => row.import_sheet === sheet.sheet_name).length,
  })), [analysis, sheetMeta, rowEdits, incompleteRows]);
  const budgetsNeedingFixes = reconciliations.filter((r) => r.meta.included && (!r.ready || r.incompleteCount > 0));
  const reviewedTotal = sumDecimals(reconciliations.filter((r) => r.meta.included).map((r) => r.total));
  const budgetNumbers = [...new Set([...BUDGET_NUMBERS, ...(analysis?.sheets || []).map((s) => s.budget_number).filter((n) => Number.isSafeInteger(n) && n > 0)])].sort((a, b) => a - b);
  const activeReview = reconciliations.find((r) => r.sheet.sheet_name === activeSheetName);
  const activeSheet = activeReview?.sheet;
  const activeMeta = activeReview?.meta;
  const selectSheet = (name) => {
    markDraftChanged();
    setActiveSheetName(name);
    setRowSearch('');
    setIssuesOnly(false);
    setRowPage(0);
  };
  const rowIssues = (item, edit = rowEdits[rowKey(item)] || {}) => importRowIssues({
    ...edit, building_type: activeMeta?.buildingType,
    budget: buildBudget(activeMeta?.buildingType, activeMeta?.budgetNumber, edit.grp),
  });
  const filteredItems = (activeSheet?.items || []).filter((item) => {
    const edit = rowEdits[rowKey(item)] || {};
    return (!issuesOnly || (!edit.excluded && rowIssues(item, edit).length > 0))
      && `${edit.name || ''} ${edit.section || ''} ${edit.grp || ''} ${item.row_number}`.toLowerCase().includes(rowSearch.trim().toLowerCase());
  });
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const currentPage = Math.min(rowPage, pageCount - 1);
  const visibleItems = filteredItems.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const handleAnalyze = (e) => {
    e.preventDefault();
    if (!projectSite) return setFeedback({ type: 'warning', message: 'Select a project site first.' });
    if (!siteAvailable) return setFeedback({ type: 'warning', message: 'Choose an active project site.' });
    if (!file) return setFeedback({ type: 'warning', message: 'Choose a .xlsx file.' });
    if (file.size > IMPORT_DRAFT_MAX_FILE_SIZE) return setFeedback({ type: 'warning', message: 'Choose a workbook no larger than 15 MB.' });
    analyzeMutation.mutate({ mappings: {}, staged: true, selectedFile: file, selectedSite: projectSite });
  };

  const layouts = analysis?.layouts || [];
  const mappingsDirty = layouts.some((layout) => mappingChanged(layout, columnMappings[layout.sheet_name]));
  const unresolvedSheets = layouts.filter((layout) => layout.status === 'needs_mapping').length;
  const changeMapping = (sheetName, field, value) => {
    markDraftChanged();
    setReviewConfirmed(false);
    setColumnMappings((prev) => ({ ...prev, [sheetName]: {
      ...prev[sheetName], columns: { ...prev[sheetName].columns, [field]: value === '' ? undefined : Number(value) },
    } }));
  };
  const changeMappingOption = (sheetName, field, value) => {
    markDraftChanged();
    setReviewConfirmed(false);
    setColumnMappings((prev) => ({ ...prev, [sheetName]: { ...prev[sheetName], [field]: value } }));
  };
  const mappingErrors = layouts.flatMap((layout) => {
    const draft = columnMappings[layout.sheet_name];
    if (!draft || draft.skip || (!layout.is_manual && !mappingChanged(layout, draft))) return [];
    return [
      ...importMappingIssues(draft.columns).map((message) => `${layout.sheet_name}: ${message}`),
      ...(!Number.isInteger(Number(draft.header_row)) || Number(draft.header_row) < 0 ? [`${layout.sheet_name}: enter a valid header row.`] : []),
    ];
  });
  const importBlocked = includedRows.length === 0 || incompleteCount > 0 || budgetsNeedingFixes.length > 0
    || mappingsDirty || unresolvedSheets > 0 || includedRows.length > 2000 || previewExpired || !siteAvailable;

  const handleDownloadTemplate = async () => {
    try {
      const blob = await api.bulkUpload.downloadTemplate();
      downloadBlob(blob, 'istrom-import-template.xlsx');
    } catch (err) {
      setFeedback({ type: 'error', message: err?.message || 'Could not download the template.' });
    }
  };

  if (sitesError || constantsError) return <LoadError error={sitesError || constantsError} onRetry={() => { retrySites(); retryConstants(); }} />;
  if (user?.user_type !== 'admin') return <div className="card">Administrator access is required to import inventory.</div>;
  if (!draftReady) return <div className="card" role="status">Loading preview…</div>;

  return (
    <div className="bulk-upload-page">
      {draftError && <div role="status" className="alert bulk-alert bulk-alert-warning">{draftError}</div>}
      {feedback.message && step !== 3 && <div role="status" className={`alert bulk-alert bulk-alert-${feedback.type}`}>{feedback.message}</div>}
      {step === 1 && <div className="card">
        <h1>Import workbook</h1>
          <form className="bulk-upload-form" onSubmit={handleAnalyze}>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="import-project-site">Project site (required)</label>
                <select id="import-project-site" value={projectSite} onChange={(e) => { setProjectSite(e.target.value); persistStagedDraft(e.target.value, file, fileName); }} disabled={analyzeMutation.isPending} required>
                  <option value="">Select project site…</option>
                  {projectSite && !siteAvailable && <option value={projectSite}>{projectSite} (unavailable)</option>}
                  {sites.map((s) => (
                    <option key={s.id} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group form-group-wide">
                <label htmlFor="import-workbook">Excel workbook (.xlsx)</label>
                <input ref={fileInput} id="import-workbook" type="file" accept=".xlsx" disabled={analyzeMutation.isPending}
                  onChange={selectWorkbook} required={!file} />
                {(file?.name || fileName) && <p className="caption">{file?.name || fileName}{file && !draftError ? ` · ${draftSaving ? 'Saving…' : 'Draft saved'}` : ''}</p>}
              </div>
            </div>
            <div className="action-bar">
              <button className="btn btn-primary" type="submit" disabled={analyzeMutation.isPending}>
                {analyzeMutation.isPending ? 'Reading…' : 'Upload & preview'}
              </button>
              <button className="btn btn-secondary" type="button" onClick={handleDownloadTemplate}>
                Download blank template
              </button>
              {(file || fileName) && <button className="btn btn-secondary" type="button" disabled={analyzeMutation.isPending} onClick={discardDraft}>Discard draft</button>}
            </div>
          </form>
      </div>}

      {step === 2 && analysis && (
        <div className="card bulk-preview-card">
          <fieldset className="bulk-review-fields" disabled={analyzeMutation.isPending || commitMutation.isPending}>
            <div className="bulk-preview-heading">
              <div><h1>Budget preview</h1><p className="caption">{analysis.file_name} · {projectSite}{!draftError && ` · ${draftSaving ? 'Saving…' : 'Draft saved'}`}</p></div>
              <div className="bulk-preview-summary"><span>{includedRows.length} items selected</span><strong>{formatNaira(reviewedTotal)}</strong></div>
            </div>
            <p className="caption bulk-edit-hint">Edit cells or uncheck rows to exclude them.</p>
            {(!isGlobalAdmin || !sitesLoading) && !siteAvailable && <div role="status" className="alert bulk-alert-warning">This project site is no longer available. Choose another file and an active project site.</div>}
            {previewExpired && <div role="status" className="alert bulk-alert-warning">
              This preview expired. Refresh it to continue; your table edits will be kept.
              <button type="button" className="btn btn-secondary btn-sm" disabled={!file || !siteAvailable}
                onClick={() => analyzeMutation.mutate({ mappings: importPreviewMappings(analysis),
                  keepEdits: true, previousAnalysis: analysis })}>Refresh preview</button>
            </div>}
            {!file && <div className="form-group">
              <label htmlFor="restore-import-workbook">Reselect original workbook (.xlsx)</label>
              <input id="restore-import-workbook" type="file" accept=".xlsx" disabled={!siteAvailable}
                onChange={recoverWorkbook} />
              <p className="caption">Your table edits will be kept after the file is verified.</p>
            </div>}

            {activeSheet && <>
              <div className="bulk-budget-picker">
                <label htmlFor="preview-budget">Budget
                  <select id="preview-budget" value={activeSheetName} onChange={(e) => selectSheet(e.target.value)}>
                    {reconciliations.map((r, i) => <option key={r.sheet.sheet_name} value={r.sheet.sheet_name}>
                      {i + 1}. {r.sheet.sheet_name}{!r.meta.included ? ' — Excluded' : !r.ready || r.incompleteCount > 0 ? ' — Needs fixes' : ''}
                    </option>)}
                  </select>
                </label>
                <label className="bulk-toggle"><input type="checkbox" checked={activeMeta.included}
                  aria-label={`Include budget ${activeSheet.sheet_name}`}
                  onChange={(e) => setSheetField(activeSheet.sheet_name, 'included', e.target.checked)} />Include this budget</label>
                {budgetsNeedingFixes.length > 0 && <button type="button" className="bulk-fix-link"
                  onClick={() => selectSheet(budgetsNeedingFixes[0].sheet.sheet_name)}>{budgetsNeedingFixes.length} {budgetsNeedingFixes.length === 1 ? 'budget needs' : 'budgets need'} fixes</button>}
              </div>

              <div className="bulk-budget-fields">
                <label>Building type<select aria-label={`Building type for ${activeSheet.sheet_name}`}
                  className={!activeMeta.buildingType && activeMeta.included ? 'bulk-select-warn' : ''} value={activeMeta.buildingType}
                  onChange={(e) => setSheetField(activeSheet.sheet_name, 'buildingType', e.target.value)}>
                  <option value="">Choose…</option>{BUILDING_TYPES.map((b) => <option key={b} value={b}>{b}</option>)}
                </select></label>
                <label>Budget number<select aria-label={`Budget number for ${activeSheet.sheet_name}`}
                  className={!activeMeta.budgetNumber && activeMeta.included ? 'bulk-select-warn' : ''} value={activeMeta.budgetNumber}
                  onChange={(e) => setSheetField(activeSheet.sheet_name, 'budgetNumber', Number(e.target.value) || '')}>
                  <option value="">Choose…</option>{budgetNumbers.map((n) => <option key={n} value={n}>{n}</option>)}
                </select></label>
                <label className="bulk-scope-field">Building scope<input aria-label={`Building scope for ${activeSheet.sheet_name}`}
                  maxLength="255" value={activeMeta.budgetScope} placeholder="Optional"
                  onChange={(e) => setSheetField(activeSheet.sheet_name, 'budgetScope', e.target.value)} /></label>
                <label>Quantity multiplier<input aria-label={`Quantity multiplier for ${activeSheet.sheet_name}`}
                  className={(!numericImportValue(activeMeta.multiplier) || Number(activeMeta.multiplier) > 10000) && activeMeta.included ? 'bulk-select-warn' : ''}
                  type="number" min="0.000001" max="10000" step="any" value={activeMeta.multiplier}
                  onChange={(e) => setSheetField(activeSheet.sheet_name, 'multiplier', e.target.value)} /></label>
              </div>

              <div className="bulk-table-tools">
                <input type="search" aria-label="Search preview rows" placeholder="Search items or sections…" value={rowSearch}
                  onChange={(e) => { setRowSearch(e.target.value); setRowPage(0); }} />
                <label className="bulk-toggle"><input type="checkbox" checked={issuesOnly}
                  onChange={(e) => { setIssuesOnly(e.target.checked); setRowPage(0); }} />Only rows needing fixes</label>
                <details className="bulk-apply-menu"><summary>Apply to all rows</summary><div>
                  <label>Group<select aria-label="Group for all preview rows" value="" onChange={(e) => setSheetAllRows(activeSheet.sheet_name, 'grp', e.target.value)}>
                    <option value="">Choose group…</option>{groupOptions.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select></label>
                  <label>Section<select aria-label="Section for all preview rows" value="" onChange={(e) => setSheetAllRows(activeSheet.sheet_name, 'section', e.target.value)}>
                    <option value="">Choose section…</option>{sectionOptions.map((section) => <option key={section} value={section}>{section}</option>)}
                  </select></label>
                </div></details>
              </div>

              <div className="table-wrap bulk-preview-scroll" tabIndex="0" role="region" aria-label="Editable budget preview">
                <table className="data-table bulk-review-table">
                  <caption className="sr-only">Editable items from {activeSheet.sheet_name}</caption>
                  <thead><tr><th scope="col">Include</th><th scope="col">Item</th><th scope="col">Quantity</th><th scope="col">Unit</th><th scope="col">Unit cost (₦)</th>
                    <th scope="col">Amount (₦)</th><th scope="col">Section</th><th scope="col">Group</th><th scope="col">Category</th></tr></thead>
                  <tbody>{visibleItems.map((it) => {
                    const k = rowKey(it), edit = rowEdits[k] || {};
                    const issues = rowIssues(it, edit);
                    const qty = numericImportValue(edit.qty), cost = numericImportValue(edit.unit_cost), multiplier = numericImportValue(activeMeta.multiplier);
                    const amount = qty != null && cost != null && multiplier > 0 ? decimalProduct(decimalProduct(qty, multiplier), cost) : null;
                    const notes = [...(it.warnings || []), ...(it.errors || [])];
                    const label = `row ${it.row_number} in ${it.sheet_name}`;
                    const highlight = (invalid) => invalid && !edit.excluded && activeMeta.included ? 'bulk-select-warn' : '';
                    return <tr key={k} className={edit.excluded || !activeMeta.included ? 'bulk-row-excluded' : issues.length > 0 ? 'bulk-row-needs-fix' : ''}>
                      <td><input type="checkbox" aria-label={`Include ${label}`} checked={!edit.excluded} onChange={() => toggleRow(k)} /></td>
                      <td><input type="text" maxLength="255" aria-label={`Item name for ${label}`} className={highlight(!edit.name?.trim())}
                        value={edit.name} onChange={(e) => setRowField(k, 'name', e.target.value)} />
                        <small>Excel row {it.row_number}{it.duplicate ? ' · Already imported' : ''}</small>
                        {issues.length > 0 && !edit.excluded && activeMeta.included && <small className="bulk-row-error">{issues.join(' ')}</small>}
                        {notes.length > 0 && <details className="bulk-row-notes"><summary>Source notes ({notes.length})</summary><ul>{notes.map((note, i) => <li key={i}>{note}</li>)}</ul></details>}
                      </td>
                      <td><input type="number" min="0" step="any" aria-label={`Quantity for ${label}`} className={highlight(qty == null)}
                        value={edit.qty} onChange={(e) => setRowField(k, 'qty', e.target.value)} />
                        {multiplier !== 1 && qty != null && multiplier > 0 && <small>Import: {decimalProduct(qty, multiplier)}</small>}</td>
                      <td><input type="text" maxLength="50" aria-label={`Unit for ${label}`} className={highlight(!edit.unit?.trim())}
                        value={edit.unit} onChange={(e) => setRowField(k, 'unit', e.target.value)} /></td>
                      <td><input type="number" min="0" step="any" aria-label={`Unit cost for ${label}`} className={highlight(cost == null)}
                        value={edit.unit_cost} onChange={(e) => setRowField(k, 'unit_cost', e.target.value)} /></td>
                      <td className="bulk-cell-number">{amount == null || !Number.isFinite(amount) ? '—' : formatNaira(amount)}</td>
                      <td><input type="text" maxLength="255" list="preview-section-options" aria-label={`Section for ${label}`}
                        value={edit.section} onChange={(e) => setRowField(k, 'section', e.target.value)} /></td>
                      <td><select aria-label={`Group for ${label}`} className={highlight(!edit.grp)} value={edit.grp} onChange={(e) => setRowField(k, 'grp', e.target.value)}>
                        <option value="">Choose…</option>{groupOptions.map((g) => <option key={g} value={g}>{g}</option>)}
                      </select></td>
                      <td><select aria-label={`Category for ${label}`} className={highlight(!edit.category)} value={edit.category} onChange={(e) => setRowField(k, 'category', e.target.value)}>
                        <option value="">Choose…</option>{categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select></td>
                    </tr>;
                  })}
                    {visibleItems.length === 0 && <tr><td colSpan="9" className="bulk-empty">{issuesOnly ? 'No rows need fixes in this budget.' : 'No matching items.'}</td></tr>}
                  </tbody>
                </table>
              </div>
              <datalist id="preview-section-options">{sectionOptions.map((section) => <option key={section} value={section} />)}</datalist>
              <div className="bulk-table-footer">
                <span>{filteredItems.length ? `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, filteredItems.length)} of ${filteredItems.length} rows` : '0 rows'} · {activeReview.rowCount} selected</span>
                {pageCount > 1 && <div className="bulk-pagination">
                  <button type="button" className="btn btn-secondary btn-sm" disabled={currentPage === 0} onClick={() => setRowPage(currentPage - 1)}>Previous rows</button>
                  <span>Page {currentPage + 1} of {pageCount}</span>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={currentPage === pageCount - 1} onClick={() => setRowPage(currentPage + 1)}>Next rows</button>
                </div>}
              </div>
              <div className={`bulk-budget-totals${activeMeta.included && !activeReview.matches ? ' bulk-total-mismatch' : ''}`} aria-label="Budget totals">
                <span>Excel total<strong>{activeSheet.source_total == null ? 'Not available' : formatNaira(activeSheet.source_total)}</strong></span>
                <span>Selected total<strong>{formatNaira(activeReview.total)}</strong></span>
                <span>{activeReview.matches ? 'Totals match' : 'Difference'}<strong>{activeReview.matches ? '✓' : activeReview.difference == null ? 'Review required' : `${formatNaira(Math.abs(activeReview.difference))} ${activeReview.difference > 0 ? 'over' : 'short'}`}</strong></span>
                {activeSheet.source_total == null && !activeSheet.total_unreadable && <label>Reviewed total (₦)<input aria-label={`Reviewed budget total for ${activeSheet.sheet_name}`}
                  type="number" min="0" step="any" value={activeMeta.reviewedTotal} onChange={(e) => setSheetField(activeSheet.sheet_name, 'reviewedTotal', e.target.value)} /></label>}
              </div>
              {activeMeta.included && !activeReview.matches && <p className="bulk-error-note" role="status">{activeSheet.total_unreadable
                ? 'The Excel total could not be read. Correct it in the workbook and upload again, or exclude this budget.'
                : activeReview.expected == null ? 'This budget has no Excel total. Enter its reviewed total above.'
                : 'The selected rows do not match the Excel total. Check the quantities, costs and multiplier, or exclude this budget.'}</p>}
              {(activeSheet.warnings?.length > 0 || activeSheet.source_total_formula || activeSheet.source_total_label || activeSheet.summary_label) && <details className="bulk-budget-notes">
                <summary>Source details</summary>
                {activeSheet.source_total_label && <p>{activeSheet.source_total_label}</p>}
                {activeSheet.summary_label && activeSheet.summary_label !== activeSheet.source_total_label && <p>{activeSheet.summary_label}</p>}
                {activeSheet.source_total_formula && <p>Excel total {activeSheet.source_total_cell}: <code>{activeSheet.source_total_formula}</code></p>}
                {activeSheet.warnings?.length > 0 && <ul>{activeSheet.warnings.map((note, i) => <li key={i}>{note}</li>)}</ul>}
              </details>}
            </>}
            {!activeSheet && <p className="bulk-empty">No items are ready to preview. Choose the sheet columns below.</p>}

            <details className="bulk-mapping-section" open={unresolvedSheets > 0}>
              <summary>Column settings{unresolvedSheets > 0 ? ` · ${unresolvedSheets} sheets need attention` : mappingsDirty ? ' · Changes pending' : ''}</summary>
              <p className="caption">Applying column settings resets your table edits.</p>
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
                        {chosenHeader && Number(draft.header_row) !== layout.header_row ? `${col.label.split(':')[0]}: ${chosenHeader.cells[col.index] || 'unnamed'}` : col.label}
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
            <button type="button" className="btn btn-secondary" disabled={!file || analyzeMutation.isPending || mappingErrors.length > 0 || commitMutation.isPending}
              onClick={() => analyzeMutation.mutate({ mappings: mappingPayload(layouts, columnMappings) })}>
              {analyzeMutation.isPending ? 'Updating…' : 'Apply column settings'}
            </button>

            </details>

            <details className="bulk-budget-overview"><summary>All budget totals ({reconciliations.length})</summary>
              <div className="table-wrap"><table className="data-table"><thead><tr><th>Include</th><th>Budget</th><th>Selected total</th><th>Review</th></tr></thead>
                <tbody>{reconciliations.map((r) => <tr key={r.sheet.sheet_name}>
                  <td><input type="checkbox" aria-label={`Include in overview ${r.sheet.sheet_name}`} checked={r.meta.included} onChange={(e) => setSheetField(r.sheet.sheet_name, 'included', e.target.checked)} /></td>
                  <td><button type="button" className="bulk-budget-link" onClick={() => selectSheet(r.sheet.sheet_name)}>{r.sheet.sheet_name}</button></td>
                  <td>{formatNaira(r.total)}</td><td className={r.meta.included && (!r.ready || r.incompleteCount > 0) ? 'bulk-error-note' : ''}>{!r.meta.included ? 'Excluded' : r.incompleteCount > 0 ? `${r.incompleteCount} rows need fixes` : r.ready ? 'Totals match' : 'Check total / multiplier'}</td>
                </tr>)}</tbody></table></div>
            </details>

            <div className="bulk-import-footer">
              <label className="bulk-toggle"><input type="checkbox" checked={reviewConfirmed} disabled={importBlocked}
                onChange={(e) => { markDraftChanged(); setReviewConfirmed(e.target.checked); }} />I confirm the selected items, building scopes and totals.</label>
              {analysis.duplicate_count > 0 && <p className="caption">{analysis.duplicate_count} already imported rows will be skipped.</p>}
              {includedRows.length > 2000 && <p className="bulk-error-note">Select up to 2,000 items per import.</p>}
              {(unresolvedSheets > 0 || mappingsDirty) && <p className="bulk-error-note">Apply the column settings before importing.</p>}
              {budgetsNeedingFixes.length > 0 && <p className="bulk-error-note">Fix or exclude the {budgetsNeedingFixes.length} highlighted {budgetsNeedingFixes.length === 1 ? 'budget' : 'budgets'} before importing.</p>}
              <div className="action-bar">
                <button className="btn btn-secondary" type="button" onClick={discardDraft}>Discard preview</button>
                <button className="btn btn-primary" type="button" disabled={importBlocked || !reviewConfirmed}
                  onClick={() => commitMutation.mutate({ rows: includedRows })}>{commitMutation.isPending ? 'Importing…' : `Import ${includedRows.length} items`}</button>
              </div>
            </div>
          </fieldset>
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <h3>Import complete</h3>
          <p className="caption">{feedback.message}</p>
          <button className="btn btn-primary" type="button"
            onClick={discardDraft}>
            Import another file
          </button>
        </div>
      )}
    </div>
  );
}
