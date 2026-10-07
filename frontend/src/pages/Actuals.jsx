import { useCallback, useState } from 'react';
import ErrorMessage from '../components/ErrorMessage';
import EmptyState from '../components/EmptyState';
import Modal from '../components/Modal';
import { formatQuantity, summarizeActuals } from '../utils/inventory.js';
import LoadError from '../components/LoadError';
import { matchesBudget, plannedQuantity, plannedUnitCost, plannedAmount, plannedTotal, budgetPosition, toCSV, budgetNumberOptions } from '../utils/budgets';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api, formatNaira } from '../api';
import './Actuals.css';
import { actualBuildingSubtypes } from '../utils/buildings';
import { decimalDifference, sumDecimals } from '../utils/numbers';
import { downloadBlob } from '../utils/downloads';
import usePersistentState from '../hooks/usePersistentState';
import { ACTUALS_VIEW, AVAILABILITY_DRAFT, isActualsView, isAvailabilityDraft, availabilityDraftFor, resolveRecordDraft, reviewedRecordFor, isReviewCurrent } from '../utils/recordDrafts';

const PROPERTY_TYPES = ['', 'All', 'Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];

const BUILDING_SUBTYPE_LABELS = {
  Flats: 'Block',
  Terraces: 'Terrace cluster',
  'Semi-detached': 'Unit',
  'Fully-detached': 'Plot',
};

export default function Actuals() {
  const { user, isAdmin, getEffectiveProjectSite } = useAuth();
  const queryClient = useQueryClient();
  const ps = getEffectiveProjectSite();
  const actionScope = JSON.stringify([user?.user_id, user?.username, user?.user_type, user?.project_site, user?.is_global_admin, ps]);
  const [review, setReview] = useState({ scope: actionScope, values: null });
  if (review.scope !== actionScope) setReview({ scope: actionScope, values: null });
  const [storedAdjustDraft, setAdjustDraft, clearAdjustDraft, draftStorageError] = usePersistentState('actuals-adjustment', AVAILABILITY_DRAFT, { validate: isAvailabilityDraft });
  const adjustDraft = storedAdjustDraft.itemId > 0 ? storedAdjustDraft : null;
  const adjustQty = adjustDraft?.qty ?? '';
  const adjustOver = adjustDraft?.over ?? false;
  const adjustCost = adjustDraft?.cost ?? '';
  const updateAdjustment = (values) => setAdjustDraft((current) => current ? { ...current, ...values } : current);
  const closeAdjustment = useCallback(() => {
    clearAdjustDraft();
    setReview((current) => current.scope === actionScope ? { ...current, values: null } : current);
  }, [clearAdjustDraft, actionScope]);
  const adjustment = useMutation({
    mutationFn: ({ id, data }) => api.items.update(id, data),
    onError: () => {
      for (const key of ['items', 'requests', 'actuals', 'dashboard']) queryClient.invalidateQueries({ queryKey: [key] });
    },
    onSuccess: (_result, variables) => {
      for (const key of ['items', 'requests', 'actuals', 'dashboard']) queryClient.invalidateQueries({ queryKey: [key] });
      variables.clearDraft();
    },
  });

  const [view, setView, , viewStorageError] = usePersistentState('actuals-view', ACTUALS_VIEW, { validate: isActualsView });
  const { budgetNum, buildingType, buildingSubtype } = view;
  const updateView = (values) => setView((current) => ({ ...current, ...values }));
  const params = {};
  if (ps) params.project_site = ps;

  const { data: items = [], error: itemsError, isLoading: itemsLoading, isFetching: itemsFetching, isFetchedAfterMount: itemsFresh, refetch: retryItems } = useQuery({
    queryKey: ['items', params],
    queryFn: () => api.items.list(params),
    refetchOnMount: 'always',
    staleTime: 0,
  });

  const { data: actuals = [], error: actualsError, isLoading: actualsLoading, refetch: retryActuals } = useQuery({
    queryKey: ['actuals', params],
    queryFn: () => api.actuals.list(params),
  });

  const loadError = itemsError || actualsError;
  if (loadError) return <LoadError error={loadError} onRetry={() => { retryItems(); retryActuals(); }} />;
  if (itemsLoading || actualsLoading || !itemsFresh) return <div className="card" role="status">Loading...</div>;

  const { item: adjustItem, changed: adjustmentChanged } = resolveRecordDraft('availability', adjustDraft, items, isAdmin);
  const adjustmentNeedsReview = adjustmentChanged && !isReviewCurrent('availability', adjustDraft, adjustItem, review.scope === actionScope ? review.values : null);

  let filteredItems = items;
  if (budgetNum) filteredItems = filteredItems.filter((i) => matchesBudget(i.budget, budgetNum));
  if (buildingType) filteredItems = filteredItems.filter((i) => i.building_type === buildingType);

  const actualsByItem = {};
  for (const a of actuals) {
    if (buildingSubtype && a.building_subtype !== buildingSubtype) continue;
    if (!actualsByItem[a.item_id]) actualsByItem[a.item_id] = [];
    actualsByItem[a.item_id].push(a);
  }

  const subtypeOptions = actualBuildingSubtypes(buildingType, items, actuals);
  const needsSubtype = buildingType && subtypeOptions.length > 0;

  // Group items by category (grp or category). Normalize "Materials" → "General Materials"
  const byCategory = {};
  for (const item of filteredItems) {
    let cat = item.grp || item.category || 'General Materials';
    if (cat === 'Materials') cat = 'General Materials';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(item);
  }

  const totals = {planned:plannedTotal(filteredItems),
    actual:sumDecimals(filteredItems.map((item) => summarizeActuals(item, actualsByItem[item.id] || []).cost))};
  const totalBudget = budgetPosition(totals.planned, totals.actual);
  const rowsFor = (item) => summarizeActuals(item, actualsByItem[item.id] || []);
  const exportCSV = () => {
    const rows = [['Item', 'Code', 'Unit', 'Original quantity', 'Recorded usage' + (buildingSubtype ? ` (${buildingSubtype})` : ''), 'Available quantity (site-wide)', 'Over quantity (site-wide)', 'Planned unit cost', 'Average actual unit cost', 'Planned value', 'Actual cost', 'Remaining budget', 'Over budget', 'Project site']];
    for (const item of filteredItems) {
      const record = rowsFor(item);
      const position = budgetPosition(plannedAmount(item), record.cost);
      rows.push([item.name, item.code, item.unit, plannedQuantity(item), record.used, Math.max(0, record.remaining), Math.max(0, -record.remaining), plannedUnitCost(item), record.averageUnitCost, plannedAmount(item), record.cost, position.remainingBudget, position.overBudget, item.project_site]);
    }
    downloadBlob(new Blob(['\uFEFF', toCSV(rows)], { type: 'text/csv;charset=utf-8' }), 'istrom-actuals.csv');
  };
  const adjustmentValid = adjustQty !== '' && adjustCost !== '' && Number.isFinite(Number(adjustQty)) && Number(adjustQty) >= 0 && Number.isFinite(Number(adjustCost)) && Number(adjustCost) >= 0;
  const budgets = budgetNumberOptions(items);
  const saveAdjustment = () => {
    if (!isAdmin || !adjustItem || !adjustmentValid || adjustmentNeedsReview || itemsFetching) return;
    adjustment.mutate({ id: adjustItem.id, clearDraft: clearAdjustDraft, data: { qty: Number(adjustQty) * (adjustOver ? -1 : 1), unit_cost: Number(adjustCost), expected_qty: Number(adjustItem.qty), expected_unit_cost: Number(adjustItem.unit_cost), expected_created_at: adjustItem.created_at } });
  };

  return <div className="actuals-page">
    <div className="page-heading">
      <div><h1>Actuals</h1></div>
      <button className="btn btn-secondary" onClick={exportCSV} disabled={!filteredItems.length}>Export CSV</button>
    </div>
    <div className="card">
      <ErrorMessage error={adjustment.error} />
      <ErrorMessage error={viewStorageError || draftStorageError} />
      {isAdmin && adjustDraft && !adjustItem && <div className="alert alert-warning" role="status">The item in your saved adjustment is no longer available. <button className="btn btn-secondary btn-sm" onClick={closeAdjustment}>Discard adjustment</button></div>}
      <div className="actuals-filters">
        <div className="form-group"><label htmlFor="actuals-budget">Budget number</label>
          <select id="actuals-budget" value={budgetNum} onChange={(e) => updateView({ budgetNum: e.target.value })}><option value="">All budgets</option>{budgetNum && !budgets.includes(budgetNum) && <option value={budgetNum}>{budgetNum} (unavailable)</option>}{budgets.map((budget) => <option key={budget} value={budget}>{budget}</option>)}</select>
        </div>
        <div className="form-group"><label htmlFor="actuals-building">Building type</label>
          <select id="actuals-building" value={buildingType} onChange={(e) => updateView({ buildingType: e.target.value, buildingSubtype: '' })}><option value="">All building types</option>{buildingType && !PROPERTY_TYPES.includes(buildingType) && <option value={buildingType}>{buildingType} (unavailable)</option>}{PROPERTY_TYPES.filter((t) => t && t !== 'All').map((t) => <option key={t} value={t}>{t}</option>)}</select>
        </div>
        {(needsSubtype || buildingSubtype) && <div className="form-group"><label htmlFor="actuals-block">{BUILDING_SUBTYPE_LABELS[buildingType] || 'Building'}</label>
          <select id="actuals-block" value={buildingSubtype} onChange={(e) => updateView({ buildingSubtype: e.target.value })}><option value="">All</option>{buildingSubtype && !subtypeOptions.includes(buildingSubtype) && <option value={buildingSubtype}>{buildingSubtype} (unavailable)</option>}{subtypeOptions.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        </div>}
      </div>
      <div className="metrics-row actuals-summary">
        <div className="metric"><span className="metric-value">{formatNaira(totals.planned)}</span><span className="metric-label">Planned value</span></div>
        <div className="metric"><span className="metric-value">{formatNaira(totals.actual)}</span><span className="metric-label">Recorded actual cost</span></div>
        {totalBudget.overBudget > 0 && <div className="metric"><span className="metric-value actuals-negative">{formatNaira(totalBudget.overBudget)}</span><span className="metric-label">Over budget</span></div>}
      </div>
      {buildingSubtype && <p className="actuals-help">Usage and costs are filtered to {buildingSubtype}. Remaining quantity covers the whole site.</p>}
      {!filteredItems.length && <EmptyState title="No items to compare" description={isAdmin ? 'Add inventory or change the filters.' : 'No inventory matches these filters.'} />}
      {Object.entries(byCategory).map(([category, categoryItems]) => <section key={category} className="actuals-comparison-section">
        <h2>{category}</h2>
        <div className="table-wrap" role="region" aria-label={`${category} usage and costs`} tabIndex={0}>
          <table className="data-table actuals-table">
            <thead><tr><th>Item</th><th className="numeric">Original quantity</th><th className="numeric">Recorded usage</th><th className="numeric">Remaining quantity</th><th className="numeric">Planned value</th><th className="numeric">Actual cost</th><th className="numeric">Budget position</th>{isAdmin && <th>Availability</th>}</tr></thead>
            <tbody>{categoryItems.map((item) => {
              const record = rowsFor(item);
              const usedAboveOriginal = Math.max(0, decimalDifference(record.used, plannedQuantity(item)));
              return <tr key={item.id}>
                <td className="actuals-item"><strong>{item.name}</strong><small>{item.code} · {item.unit}{!ps && item.project_site ? ` · ${item.project_site}` : ''}</small>{item.budget_scope && <small>{item.budget_scope}</small>}</td>
                <td className="numeric">{formatQuantity(plannedQuantity(item))}</td>
                <td className={`numeric${usedAboveOriginal > 0 ? ' actuals-negative' : ''}`}>{formatQuantity(record.used)}{usedAboveOriginal > 0 && <small>{formatQuantity(usedAboveOriginal)} over original quantity</small>}</td>
                <td className={`numeric${record.remaining <= 0 ? ' actuals-negative' : ''}`}><strong>{formatQuantity(Math.max(0, record.remaining))}</strong>{record.remaining < 0 ? <small>Over quantity: {formatQuantity(-record.remaining)} {item.unit}</small> : record.remaining === 0 && <small>None available</small>}</td>
                <td className="numeric">{formatNaira(plannedAmount(item))}<small>{formatNaira(plannedUnitCost(item))} / {item.unit}</small></td>
                <td className="numeric">{formatNaira(record.cost)}<small>{formatNaira(record.averageUnitCost)} / {item.unit} average</small></td>
                <td className={`numeric${record.balance < 0 ? ' actuals-negative' : ''}`}>{record.balance === 0 ? 'On budget' : <>{formatNaira(Math.abs(record.balance))}<small>{record.balance < 0 ? 'Over budget' : 'Remaining budget'}</small></>}</td>
                {isAdmin && <td><button className="btn btn-secondary btn-sm" aria-label={`Adjust availability for ${item.name}`} onClick={() => { adjustment.reset(); setReview({ scope: actionScope, values: null }); setAdjustDraft(availabilityDraftFor(item)); }}>Adjust</button></td>}
              </tr>;
            })}</tbody>
          </table>
        </div>
      </section>)}
    </div>
    {adjustItem && <Modal onClose={() => { if (!adjustment.isPending) closeAdjustment(); }} labelledBy="adjust-availability-title">
      <h3 id="adjust-availability-title">Adjust {adjustItem.name}</h3>
      <p className="caption">Enter the current available quantity or the outstanding shortfall.</p>
      <ErrorMessage error={adjustment.error} />
      <ErrorMessage error={draftStorageError} />
      {adjustmentNeedsReview && <div className="alert alert-warning" role="status">Availability changed while this adjustment was open. Current {adjustItem.qty < 0 ? 'over quantity' : 'available quantity'}: {formatQuantity(Math.abs(adjustItem.qty))} {adjustItem.unit}; unit cost: {formatNaira(adjustItem.unit_cost)}. <button className="btn btn-secondary btn-sm" disabled={itemsFetching} onClick={() => setReview({ scope: actionScope, values: reviewedRecordFor('availability', adjustDraft, adjustItem) })}>I have reviewed these values</button></div>}
      <div className="form-row">
        <div className="form-group"><label htmlFor="adjust-position">Quantity position</label><select id="adjust-position" disabled={adjustment.isPending} value={adjustOver ? 'over' : 'available'} onChange={(e) => updateAdjustment({ over: e.target.value === 'over' })}><option value="available">Available quantity</option><option value="over">Over quantity</option></select></div>
        <div className="form-group"><label htmlFor="adjust-qty">{adjustOver ? 'Over quantity' : 'Available quantity'} ({adjustItem.unit})</label><input id="adjust-qty" type="number" min={0} step="any" disabled={adjustment.isPending} value={adjustQty} onChange={(e) => updateAdjustment({ qty: e.target.value })} /></div>
        <div className="form-group"><label htmlFor="adjust-cost">Current unit cost (₦)</label><input id="adjust-cost" type="number" min={0} step="0.01" disabled={adjustment.isPending} value={adjustCost} onChange={(e) => updateAdjustment({ cost: e.target.value })} /></div>
      </div>
      <div className="modal-actions"><button className="btn btn-primary" disabled={!adjustmentValid || adjustmentNeedsReview || itemsFetching || adjustment.isPending} onClick={saveAdjustment}>{adjustment.isPending ? 'Saving…' : 'Save availability'}</button><button className="btn btn-secondary" disabled={adjustment.isPending} onClick={closeAdjustment}>Cancel</button></div>
    </Modal>}
  </div>;
}
