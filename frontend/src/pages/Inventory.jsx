import { Link } from 'react-router-dom';
import EmptyState from '../components/EmptyState';
import './Inventory.css';
import ErrorMessage from '../components/ErrorMessage';
import LoadError from '../components/LoadError';
import { matchesBudget, plannedQuantity, plannedUnitCost, plannedAmount, plannedTotal, budgetNumberOptions } from '../utils/budgets';
import { useCallback, useState } from 'react';
import Modal from '../components/Modal';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api, formatNaira } from '../api';
import { formatQuantity, inventorySectionOptions } from '../utils/inventory';
import { deleteInventoryItems } from '../utils/deletions';
import usePersistentState from '../hooks/usePersistentState';
import { INVENTORY_VIEW, INVENTORY_DRAFT, isInventoryView, isInventoryDraft, inventoryDraftFor, resolveRecordDraft, reviewedRecordFor, isReviewCurrent } from '../utils/recordDrafts';

const PROPERTY_TYPES = ['', 'All', 'Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];

export default function Inventory() {
  const { user, isAdmin, getEffectiveProjectSite } = useAuth();
  const queryClient = useQueryClient();
  const ps = getEffectiveProjectSite();
  const actionScope = JSON.stringify([user?.user_id, user?.username, user?.user_type, user?.project_site, user?.is_global_admin, ps]);

  const [view, setView, clearView, viewStorageError] = usePersistentState('inventory-view', INVENTORY_VIEW, { validate: isInventoryView });
  const { buildingType, budgetNum, budgetLabel, section, search, page } = view;
  const updateView = (values) => setView((current) => ({ ...current, ...values }));
  const [actions, setActions] = useState(() => ({ scope: actionScope, generation: 0, selected: new Set(), showDeleteAll: false, reviewed: null }));
  if (actions.scope !== actionScope) {
    setActions({ scope: actionScope, generation: actions.generation + 1, selected: new Set(), showDeleteAll: false, reviewed: null });
  }
  const selected = actions.scope === actionScope ? actions.selected : new Set();
  const showDeleteAll = actions.scope === actionScope && actions.showDeleteAll;
  const updateActions = (changes) => setActions((current) => current.scope === actionScope ? { ...current, ...changes } : current);
  const setSelected = (selection) => updateActions({ selected: selection });
  const setShowDeleteAll = (show) => updateActions({ showDeleteAll: show });
  const [storedEditDraft, setEditDraft, clearEditDraft, draftStorageError] = usePersistentState('inventory-edit', INVENTORY_DRAFT, { validate: isInventoryDraft });
  const editDraft = storedEditDraft.itemId > 0 ? storedEditDraft : null;
  const editPlannedQty = editDraft?.qty ?? '';
  const editPlannedUnitCost = editDraft?.cost ?? '';
  const updateEdit = (values) => setEditDraft((current) => current ? { ...current, ...values } : current);
  const closeEdit = useCallback(() => {
    clearEditDraft();
    setActions((current) => current.scope === actionScope ? { ...current, reviewed: null } : current);
  }, [clearEditDraft, actionScope]);
  const closeDelete = useCallback(() => setActions((current) => current.scope === actionScope ? { ...current, showDeleteAll: false } : current), [actionScope]);

  const params = {};
  if (ps) params.project_site = ps;

  const { data: rawItems = [], refetch: refetchItems, isFetching: itemsFetching, isFetchedAfterMount: itemsFresh, error: rawItemsError, isLoading: rawItemsLoading } = useQuery({
    queryKey: ['items', params],
    queryFn: () => api.items.list(params),
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
    staleTime: 0,
  });

  const buildingItems = rawItems.filter((item) => !buildingType || item.building_type === buildingType);
  let items = buildingItems.filter((item) => (!section || item.section === section) && (!budgetNum || matchesBudget(item.budget, budgetNum)));
  if (budgetLabel) items = items.filter((i) => i.budget === budgetLabel);
  const searchTerm = search.trim().toLowerCase();
  if (searchTerm) items = items.filter((i) => `${i.name} ${i.code} ${i.budget_scope || ''}`.toLowerCase().includes(searchTerm));

  const { data: constants = {}, error: constantsError, isLoading: constantsLoading, refetch: retryConstants } = useQuery({
    queryKey: ['constants'],
    queryFn: () => api.constants.get(),
  });
  const sections = inventorySectionOptions(rawItems, constants.CONSTRUCTION_SECTIONS || []);

  const deleteMutation = useMutation({
    mutationFn: ({ items }) => deleteInventoryItems(items, api.items.delete),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setActions((current) => current.scope === variables.scope && current.generation === variables.generation ? { ...current, selected: new Set(result.failed.map((item) => item.id)) } : current);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => api.items.update(id, data),
    onError: () => queryClient.invalidateQueries({ queryKey: ['items'] }),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      variables.clearDraft();
    },
  });

  const loadError = rawItemsError || constantsError;
  if (loadError) return <LoadError error={loadError} onRetry={() => { refetchItems(); retryConstants(); }} />;
  if (rawItemsLoading || constantsLoading || !itemsFresh) return <div className="card" role="status">Loading...</div>;

  const { item: editItem, changed: editChanged } = resolveRecordDraft('inventory', editDraft, rawItems, isAdmin);
  const editNeedsReview = editChanged && !isReviewCurrent('inventory', editDraft, editItem, actions.scope === actionScope ? actions.reviewed : null);

  const totalValue = plannedTotal(items);
  const materialsCount = items.filter((i) => (i.category || i.grp || '').toLowerCase() !== 'labour').length;
  const labourCount = items.filter((i) => (i.category || i.grp || '').toLowerCase() === 'labour').length;
  const perPage = 50;
  const lastPage = Math.max(0, Math.ceil(items.length / perPage) - 1);
  const currentPage = Math.min(page, lastPage);
  const paginated = items.slice(currentPage * perPage, (currentPage + 1) * perPage);
  const selectedItems = items.filter((item) => selected.has(item.id));
  const hasFilters = Boolean(buildingType || budgetNum || budgetLabel || section || search);
  const clearFilters = () => clearView();
  const budgets = budgetNumberOptions(rawItems);
  const budgetLabels = [...new Set(buildingItems.filter((i) => !budgetNum || matchesBudget(i.budget, budgetNum)).map((i) => i.budget).filter(Boolean))].sort();

  const toggleSelect = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const deleteSelected = () => {
    if (!confirm(`Delete ${selectedItems.length} selected item(s)?`)) return;
    deleteMutation.mutate({ items: selectedItems, scope: actionScope, generation: actions.generation });
  };

  const handleUpdate = () => {
    if (!isAdmin || !editItem || editNeedsReview || itemsFetching || !validPlan) return;
    updateMutation.mutate({
      id: editItem.id,
      clearDraft: clearEditDraft,
      data: {
        planned_qty: editPlannedQty !== '' ? Number(editPlannedQty) : undefined,
        planned_unit_cost: editPlannedUnitCost !== '' ? Number(editPlannedUnitCost) : undefined,
        expected_created_at: editItem.created_at,
        expected_planned_qty: Number(plannedQuantity(editItem)),
        expected_planned_unit_cost: Number(plannedUnitCost(editItem)),
      },
    });
  };

  const handleDeleteAll = () => {
    deleteMutation.mutate({ items, scope: actionScope, generation: actions.generation });
    setShowDeleteAll(false);
  };
  const validPlan = [editPlannedQty, editPlannedUnitCost].every((value) => value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0);
  const deletionErrors = deleteMutation.data?.failed.map((item) => `${item.name} (${item.id}): ${item.message}`).join('; ');

  return (
    <div className="inventory-page">
      <div className="page-heading">
        <div><h1>Inventory</h1><p>Original budget quantities and costs.</p></div>
        {isAdmin && <div className="page-heading-actions">
          <Link className="btn btn-secondary" to="/bulk-upload">Import workbook</Link>
          <Link className="btn btn-primary" to="/manual-entry">Add items</Link>
        </div>}
      </div>
      <div className="card">
        <ErrorMessage error={updateMutation.error || deleteMutation.error || deletionErrors} />
        <ErrorMessage error={viewStorageError || draftStorageError} />
        {isAdmin && editDraft && !editItem && <div className="alert alert-warning" role="status">The item in your saved edit is no longer available. <button className="btn btn-secondary btn-sm" onClick={closeEdit}>Discard edit</button></div>}
        {deleteMutation.isPending && <p role="status" className="caption">Deleting selected items…</p>}
        {deleteMutation.isSuccess && <p role="status" className="caption">Deleted {deleteMutation.data.deleted.length} item(s). {deleteMutation.data.failed.length > 0 ? `${deleteMutation.data.failed.length} item(s) kept and selected for review.` : ''}</p>}

        <div className="metrics-row">
          <div className="metric">
            <span className="metric-value">{items.length}</span>
            <span className="metric-label">Items</span>
          </div>
          <div className="metric">
            <span className="metric-value">{formatNaira(totalValue)}</span>
            <span className="metric-label">Original inventory value</span>
          </div>
          <div className="metric">
            <span className="metric-value">{materialsCount}</span>
            <span className="metric-label">Materials</span>
          </div>
          <div className="metric">
            <span className="metric-value">{labourCount}</span>
            <span className="metric-label">Labour</span>
          </div>
        </div>

        <div className="form-group inventory-search">
          <label htmlFor="inventory-search">Search inventory</label>
          <input id="inventory-search" type="search" placeholder="Search by item name or code" value={search} onChange={(e) => updateView({ search: e.target.value, page: 0 })} />
        </div>
        <div className="form-row inventory-filters">
          <div className="form-group">
            <label htmlFor="inventory-building">Building type</label>
            <select
              id="inventory-building"
              value={buildingType}
              onChange={(e) => {
                updateView({ buildingType: e.target.value, budgetLabel: '', page: 0 });
              }}
            >
              <option value="">All</option>
              {buildingType && !PROPERTY_TYPES.includes(buildingType) && <option value={buildingType}>{buildingType} (unavailable)</option>}
              {PROPERTY_TYPES.filter((t) => t && t !== 'All').map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="inventory-budget-number">Budget number</label>
            <select
              id="inventory-budget-number"
              value={budgetNum}
              onChange={(e) => {
                updateView({ budgetNum: e.target.value, budgetLabel: '', page: 0 });
              }}
            >
              <option value="">All</option>
              {budgetNum && !budgets.includes(budgetNum) && <option value={budgetNum}>{budgetNum} (unavailable)</option>}
              {budgets.map((budget) => (
                <option key={budget} value={budget}>{budget}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="inventory-budget">Budget</label>
            <select
              id="inventory-budget"
              value={budgetLabel}
              onChange={(e) => updateView({ budgetLabel: e.target.value, page: 0 })}
            >
              <option value="">All</option>
              {budgetLabel && !budgetLabels.includes(budgetLabel) && <option value={budgetLabel}>{budgetLabel} (unavailable)</option>}
              {budgetLabels.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="inventory-section">Section</label>
            <select id="inventory-section" value={section} onChange={(e) => updateView({ section: e.target.value, page: 0 })}>
              <option value="">All</option>
              {section && !sections.includes(section) && <option value={section}>{section} (unavailable)</option>}
              {sections.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="inventory-toolbar">
          <span className="caption">{items.length} {items.length === 1 ? 'item' : 'items'}{hasFilters ? ' matching filters' : ''}{selectedItems.length > 0 ? ` · ${selectedItems.length} selected` : ''}</span>
          <div className="action-bar">
            {hasFilters && <button className="btn btn-secondary btn-sm" onClick={clearFilters}>Clear filters</button>}
            {isAdmin && selectedItems.length > 0 && <>
              <button className="btn btn-danger btn-sm" disabled={deleteMutation.isPending} onClick={deleteSelected}>Delete selected</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setSelected(new Set())}>Clear selection</button>
            </>}
            <button className="btn btn-secondary btn-sm" onClick={() => refetchItems()} disabled={itemsFetching}>
              {itemsFetching ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        <div className="table-wrap" role="region" aria-label="Inventory items" tabIndex={0}>
          <table className="data-table">
            <thead>
              <tr>
                {isAdmin && <th className="inventory-select"><span className="sr-only">Select</span></th>}
                <th>Item</th>
                <th>Category</th>
                <th className="numeric">Original quantity</th>
                <th className="numeric">Original unit cost</th>
                <th className="numeric">Original value</th>
                <th>Budget / location</th>
                {isAdmin && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && <tr className="table-empty-row"><td colSpan={isAdmin ? 8 : 6}>
                <EmptyState title={hasFilters ? 'No matching items' : 'No inventory yet'} description={hasFilters ? 'Change or clear the filters.' : isAdmin ? 'Add items or import a workbook.' : 'No inventory has been added for this site.'}>
                  {hasFilters ? <button className="btn btn-secondary" onClick={clearFilters}>Clear filters</button> : isAdmin && <Link className="btn btn-primary" to="/manual-entry">Add your first item</Link>}
                </EmptyState>
              </td></tr>}
              {paginated.map((item) => (
                <tr key={item.id}>
                  {isAdmin && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${item.name}`}
                        checked={selected.has(item.id)}
                        disabled={deleteMutation.isPending}
                        onChange={() => toggleSelect(item.id)}
                      />
                    </td>
                  )}
                  <td className="inventory-item"><strong>{item.name}</strong><span>{item.code}</span>{item.budget_scope && <span>{item.budget_scope}</span>}</td>
                  <td>{item.category || item.grp || '—'}</td>
                  <td className="numeric">{formatQuantity(plannedQuantity(item))} <span className="inventory-unit">{item.unit}</span></td>
                  <td className="numeric">{formatNaira(plannedUnitCost(item))}</td>
                  <td className="numeric">{formatNaira(plannedAmount(item))}</td>
                  <td className="inventory-location"><span>{item.budget || '—'}</span><small>{[item.building_type, item.section, !ps && item.project_site].filter(Boolean).join(' · ')}</small></td>
                  {isAdmin && (
                    <td>
                      <div className="table-actions">
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setEditDraft(inventoryDraftFor(item));
                            updateActions({ reviewed: null });
                            updateMutation.reset();
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          disabled={deleteMutation.isPending}
                          onClick={() => {
                            if (confirm('Delete this item?')) deleteMutation.mutate({ items: [item], scope: actionScope, generation: actions.generation });
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {items.length > perPage && (
          <div className="pagination">
            <button
              className="btn btn-secondary"
              disabled={currentPage === 0}
              onClick={() => updateView({ page: currentPage - 1 })}
            >
              Previous
            </button>
            <span>
              Page {currentPage + 1} of {Math.ceil(items.length / perPage)}
            </span>
            <button
              className="btn btn-secondary"
              disabled={currentPage >= lastPage}
              onClick={() => updateView({ page: currentPage + 1 })}
            >
              Next
            </button>
          </div>
        )}

        {editItem && (
          <Modal onClose={() => { if (!updateMutation.isPending) closeEdit(); }} labelledBy="edit-inventory-title">
              <h3 id="edit-inventory-title">Edit {editItem.name}</h3>
              <ErrorMessage error={updateMutation.error} />
              <ErrorMessage error={draftStorageError} />
              <p className="caption">Changes update the original budget. Adjust availability in Actuals.</p>
              {editNeedsReview && <div className="alert alert-warning" role="status">The original budget changed while this edit was open. Current quantity: {formatQuantity(plannedQuantity(editItem))} {editItem.unit}; unit cost: {formatNaira(plannedUnitCost(editItem))}. <button className="btn btn-secondary btn-sm" disabled={itemsFetching} onClick={() => updateActions({ reviewed: reviewedRecordFor('inventory', editDraft, editItem) })}>I have reviewed these values</button></div>}
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="edit-planned">Original quantity</label>
                  <input id="edit-planned" type="number" min={0} step="any" disabled={updateMutation.isPending} value={editPlannedQty} onChange={(e) => updateEdit({ qty: e.target.value })} />
                </div>
                <div className="form-group">
                  <label htmlFor="edit-planned-cost">Original unit cost (₦)</label>
                  <input id="edit-planned-cost" type="number" min={0} step={0.01} disabled={updateMutation.isPending} value={editPlannedUnitCost} onChange={(e) => updateEdit({ cost: e.target.value })} />
                </div>
              </div>
              <div className="modal-actions">
              <button className="btn btn-primary" disabled={!validPlan || editNeedsReview || itemsFetching || updateMutation.isPending} onClick={handleUpdate}>
                {updateMutation.isPending ? 'Updating...' : 'Update'}
              </button>
              <button className="btn btn-secondary" disabled={updateMutation.isPending} onClick={closeEdit}>
                Cancel
              </button>
              </div>
          </Modal>
        )}

        {isAdmin && items.length > 0 && (
          <div className="danger-zone">
            <button
              className="btn btn-danger"
              disabled={deleteMutation.isPending}
              onClick={() => setShowDeleteAll(true)}
            >
              Delete displayed inventory
            </button>
          </div>
        )}

        {showDeleteAll && (
          <Modal onClose={closeDelete} labelledBy="delete-inventory-title">
              <h3 id="delete-inventory-title">Delete displayed inventory</h3>
              <p>Permanently delete {items.length} items matching the current filters? Items linked to requests or actuals will be kept.</p>
              <div className="modal-actions">
                <button className="btn btn-danger" onClick={handleDeleteAll}>
                  Delete {items.length} items
                </button>
                <button className="btn btn-secondary" onClick={() => setShowDeleteAll(false)}>
                  Cancel
                </button>
              </div>
          </Modal>
        )}
      </div>
    </div>
  );
}
