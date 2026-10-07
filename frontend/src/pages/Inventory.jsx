import { Link } from 'react-router-dom';
import EmptyState from '../components/EmptyState';
import './Inventory.css';
import ErrorMessage from '../components/ErrorMessage';
import LoadError from '../components/LoadError';
import { matchesBudget, plannedQuantity, plannedUnitCost, plannedAmount, budgetNumberOptions } from '../utils/budgets';
import { useCallback, useState } from 'react';
import Modal from '../components/Modal';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api, formatNaira } from '../api';
import { formatQuantity } from '../utils/inventory';
import { deleteInventoryItems } from '../utils/deletions';

const PROPERTY_TYPES = ['', 'All', 'Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];

export default function Inventory() {
  const { isAdmin, getEffectiveProjectSite } = useAuth();
  const queryClient = useQueryClient();

  const [buildingType, setBuildingType] = useState('');
  const [budgetNum, setBudgetNum] = useState('');
  const [budgetLabel, setBudgetLabel] = useState('');
  const [section, setSection] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [page, setPage] = useState(0);
  const [editItem, setEditItem] = useState(null);
  const [editPlannedQty, setEditPlannedQty] = useState('');
  const [editPlannedUnitCost, setEditPlannedUnitCost] = useState('');
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const closeEdit = useCallback(() => setEditItem(null), []);
  const closeDelete = useCallback(() => setShowDeleteAll(false), []);

  const params = {};
  const ps = getEffectiveProjectSite();
  if (ps) params.project_site = ps;
  if (buildingType) params.building_type = buildingType;
  if (section) params.section = section;

  const { data: rawItems = [], refetch: refetchItems, isFetching: itemsFetching, error: rawItemsError, isLoading: rawItemsLoading } = useQuery({
    queryKey: ['items', params],
    queryFn: () => api.items.list(params),
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  let items = rawItems.filter((i) => !budgetNum || matchesBudget(i.budget, budgetNum));
  if (budgetLabel) items = items.filter((i) => i.budget === budgetLabel);
  const searchTerm = search.trim().toLowerCase();
  if (searchTerm) items = items.filter((i) => `${i.name} ${i.code} ${i.budget_scope || ''}`.toLowerCase().includes(searchTerm));

  const { data: constants = {}, error: constantsError, isLoading: constantsLoading, refetch: retryConstants } = useQuery({
    queryKey: ['constants'],
    queryFn: () => api.constants.get(),
  });
  const sections = constants.CONSTRUCTION_SECTIONS || [];

  const { refetch: refetchRequests } = useQuery({
    queryKey: ['requests'],
    queryFn: () => api.requests.list(),
  });

  const deleteMutation = useMutation({
    mutationFn: (items) => deleteInventoryItems(items, api.items.delete),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setSelected(new Set(result.failed.map((item) => item.id)));
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => api.items.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setEditItem(null);
    },
  });

  const loadError = rawItemsError || constantsError;
  if (loadError) return <LoadError error={loadError} onRetry={() => { refetchItems(); retryConstants(); }} />;
  if (rawItemsLoading || constantsLoading) return <div className="card" role="status">Loading...</div>;

  const totalValue = items.reduce((s, i) => s + plannedAmount(i), 0);
  const materialsCount = items.filter((i) => (i.category || i.grp || '').toLowerCase() !== 'labour').length;
  const labourCount = items.filter((i) => (i.category || i.grp || '').toLowerCase() === 'labour').length;
  const perPage = 50;
  const lastPage = Math.max(0, Math.ceil(items.length / perPage) - 1);
  const currentPage = Math.min(page, lastPage);
  const paginated = items.slice(currentPage * perPage, (currentPage + 1) * perPage);
  const selectedItems = items.filter((item) => selected.has(item.id));
  const hasFilters = Boolean(buildingType || budgetNum || budgetLabel || section || search);
  const clearFilters = () => { setBuildingType(''); setBudgetNum(''); setBudgetLabel(''); setSection(''); setSearch(''); setPage(0); };

  const toggleSelect = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const deleteSelected = () => {
    if (!confirm(`Delete ${selectedItems.length} selected item(s)?`)) return;
    deleteMutation.mutate(selectedItems);
  };

  const handleUpdate = () => {
    if (!editItem) return;
    updateMutation.mutate({
      id: editItem.id,
      data: {
        planned_qty: editPlannedQty !== '' ? Number(editPlannedQty) : undefined,
        planned_unit_cost: editPlannedUnitCost !== '' ? Number(editPlannedUnitCost) : undefined,
      },
    });
  };

  const handleDeleteAll = () => {
    deleteMutation.mutate(items);
    setShowDeleteAll(false);
  };
  const validPlan = [editPlannedQty, editPlannedUnitCost].every((value) => value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0);
  const deletionErrors = deleteMutation.data?.failed.map((item) => `${item.name} (${item.id}): ${item.message}`).join('; ');

  return (
    <div className="inventory-page">
      <div className="page-heading">
        <div><h1>Inventory</h1><p>Original quantities and costs for {ps || 'all project sites'}. Approved usage is tracked in Actuals.</p></div>
        {isAdmin && <div className="page-heading-actions">
          <Link className="btn btn-secondary" to="/bulk-upload">Import workbook</Link>
          <Link className="btn btn-primary" to="/manual-entry">Add items</Link>
        </div>}
      </div>
      <div className="card">
        <ErrorMessage error={updateMutation.error || deleteMutation.error || deletionErrors} />
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
          <input id="inventory-search" type="search" placeholder="Search by item name or code" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
        </div>
        <div className="form-row inventory-filters">
          <div className="form-group">
            <label htmlFor="inventory-building">Building type</label>
            <select
              id="inventory-building"
              value={buildingType}
              onChange={(e) => {
                setBuildingType(e.target.value);
                setBudgetLabel('');
                setPage(0);
              }}
            >
              <option value="">All</option>
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
                setBudgetNum(e.target.value);
                setBudgetLabel('');
                setPage(0);
              }}
            >
              <option value="">All</option>
              {budgetNumberOptions(rawItems).map((budget) => (
                <option key={budget} value={budget}>{budget}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="inventory-budget">Budget</label>
            <select
              id="inventory-budget"
              value={budgetLabel}
              onChange={(e) => { setBudgetLabel(e.target.value); setPage(0); }}
            >
              <option value="">All</option>
              {[...new Set(rawItems.filter((i) => !budgetNum || matchesBudget(i.budget, budgetNum)).map((i) => i.budget).filter(Boolean))].sort().map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="inventory-section">Section</label>
            <select id="inventory-section" value={section} onChange={(e) => { setSection(e.target.value); setPage(0); }}>
              <option value="">All</option>
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
            <button className="btn btn-secondary btn-sm" onClick={() => { refetchItems(); refetchRequests(); }} disabled={itemsFetching}>
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
                <EmptyState title={hasFilters ? 'No matching items' : 'No inventory yet'} description={hasFilters ? 'Try another search or clear the filters to see more items.' : isAdmin ? 'Add your starting stock or import a workbook to begin tracking materials and costs.' : 'Your administrator will add the budget and inventory for this site.'}>
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
                            setEditItem(item);
                            setEditPlannedQty(plannedQuantity(item));
                            setEditPlannedUnitCost(plannedUnitCost(item));
                            updateMutation.reset();
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          disabled={deleteMutation.isPending}
                          onClick={() => {
                            if (confirm('Delete this item?')) deleteMutation.mutate([item]);
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
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </button>
            <span>
              Page {currentPage + 1} of {Math.ceil(items.length / perPage)}
            </span>
            <button
              className="btn btn-secondary"
              disabled={currentPage >= lastPage}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </button>
          </div>
        )}

        {editItem && (
          <Modal onClose={() => { if (!updateMutation.isPending) closeEdit(); }} labelledBy="edit-inventory-title">
              <h3 id="edit-inventory-title">Edit {editItem.name}</h3>
              <ErrorMessage error={updateMutation.error} />
              <p className="caption">Update the original budget quantities and costs. Remaining availability is managed in Actuals.</p>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="edit-planned">Original quantity</label>
                  <input id="edit-planned" type="number" min={0} step="any" disabled={updateMutation.isPending} value={editPlannedQty} onChange={(e) => setEditPlannedQty(e.target.value)} />
                </div>
                <div className="form-group">
                  <label htmlFor="edit-planned-cost">Original unit cost (₦)</label>
                  <input id="edit-planned-cost" type="number" min={0} step={0.01} disabled={updateMutation.isPending} value={editPlannedUnitCost} onChange={(e) => setEditPlannedUnitCost(e.target.value)} />
                </div>
              </div>
              <div className="modal-actions">
              <button className="btn btn-primary" disabled={!validPlan || updateMutation.isPending} onClick={handleUpdate}>
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
