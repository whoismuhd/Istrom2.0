import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api, formatNaira } from '../api';

const PROPERTY_TYPES = ['', 'All', 'Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];

export default function Inventory() {
  const { isAdmin, getEffectiveProjectSite } = useAuth();
  const queryClient = useQueryClient();

  const [buildingType, setBuildingType] = useState('');
  const [budgetNum, setBudgetNum] = useState('');
  const [budgetLabel, setBudgetLabel] = useState('');
  const [section, setSection] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [page, setPage] = useState(0);
  const [editItem, setEditItem] = useState(null);
  const [editQty, setEditQty] = useState('');
  const [editUnitCost, setEditUnitCost] = useState('');
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const params = {};
  const ps = getEffectiveProjectSite();
  if (ps) params.project_site = ps;
  if (buildingType) params.building_type = buildingType;
  if (section) params.section = section;

  const { data: rawItems = [], refetch: refetchItems, isFetching: itemsFetching } = useQuery({
    queryKey: ['items', params],
    queryFn: () => api.items.list(params),
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  let items = rawItems.filter((i) => !budgetNum || (i.budget || '').includes(budgetNum));
  if (budgetLabel) items = items.filter((i) => i.budget === budgetLabel);

  const { data: constants = {} } = useQuery({
    queryKey: ['constants'],
    queryFn: () => api.constants.get(),
  });
  const sections = constants.CONSTRUCTION_SECTIONS || [];

  const { refetch: refetchRequests } = useQuery({
    queryKey: ['requests'],
    queryFn: () => api.requests.list(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => api.items.delete(id),
    onSuccess: () => {
      setDeleteError('');
      queryClient.invalidateQueries(['items']);
    },
    onError: (error) => {
      setDeleteError(error.message || 'Could not delete item.');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => api.items.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries(['items']);
      setEditItem(null);
    },
  });

  const totalValue = items.reduce((s, i) => s + i.qty * i.unit_cost, 0);
  const materialsCount = items.filter((i) => (i.category || i.grp || '').toLowerCase() !== 'labour').length;
  const labourCount = items.filter((i) => (i.category || i.grp || '').toLowerCase() === 'labour').length;
  const perPage = 50;
  const paginated = items.slice(page * perPage, (page + 1) * perPage);

  const toggleSelect = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const deleteSelected = () => {
    if (!confirm(`Delete ${selected.size} item(s)?`)) return;
    selected.forEach((id) => deleteMutation.mutate(id));
    setSelected(new Set());
  };

  const handleUpdate = () => {
    if (!editItem) return;
    updateMutation.mutate({
      id: editItem.id,
      data: {
        qty: editQty !== '' ? parseFloat(editQty) : undefined,
        unit_cost: editUnitCost !== '' ? parseFloat(editUnitCost) : undefined,
      },
    });
  };

  const handleDeleteAll = () => {
    items.forEach((i) => deleteMutation.mutate(i.id));
    setShowDeleteAll(false);
  };

  return (
    <div>
      <div className="card">
        <h2>Current Inventory</h2>
        <p className="caption">View, edit, and manage all inventory items</p>

        <div className="metrics-row">
          <div className="metric">
            <span className="metric-value">{items.length}</span>
            <span className="metric-label">Total Items</span>
          </div>
          <div className="metric">
            <span className="metric-value">{formatNaira(totalValue)}</span>
            <span className="metric-label">Total Value</span>
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

        <div className="form-row">
          <div className="form-group">
            <label>Building Type</label>
            <select
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
            <label>Budget Number</label>
            <select
              value={budgetNum}
              onChange={(e) => {
                setBudgetNum(e.target.value);
                setBudgetLabel('');
                setPage(0);
              }}
            >
              <option value="">All</option>
              {Array.from({ length: 20 }, (_, i) => (
                <option key={i} value={`Budget ${i + 1}`}>Budget {i + 1}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Budget</label>
            <select
              value={budgetLabel}
              onChange={(e) => { setBudgetLabel(e.target.value); setPage(0); }}
            >
              <option value="">All</option>
              {[...new Set(rawItems.filter((i) => !budgetNum || (i.budget || '').includes(budgetNum)).map((i) => i.budget).filter(Boolean))].sort().map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Section</label>
            <select value={section} onChange={(e) => { setSection(e.target.value); setPage(0); }}>
              <option value="">All</option>
              {sections.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="action-bar">
          <button
            className="btn btn-secondary"
            onClick={() => { refetchItems(); refetchRequests(); }}
            title="Refresh inventory data"
            disabled={itemsFetching}
          >
            {itemsFetching ? '...' : 'Refresh'}
          </button>
        {isAdmin && (
          <>
            <button
              className="btn btn-secondary"
              onClick={deleteSelected}
              disabled={selected.size === 0}
            >
              Delete Selected ({selected.size})
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setSelected(new Set())}
            >
              Clear Selection
            </button>
          </>
        )}
        </div>

        {deleteError && (
          <div className="alert alert-warning" role="alert">
            {deleteError}
          </div>
        )}

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {isAdmin && <th></th>}
                <th>Code</th>
                <th>Name</th>
                <th>Category</th>
                <th>Unit</th>
                <th>Qty</th>
                <th>Unit Cost</th>
                <th>Amount</th>
                <th>Budget</th>
                <th>Section</th>
                <th>Building Type</th>
                {isAdmin && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {paginated.map((item) => (
                <tr key={item.id}>
                  {isAdmin && (
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={() => toggleSelect(item.id)}
                      />
                    </td>
                  )}
                  <td>{item.code}</td>
                  <td>{item.name}</td>
                  <td>{item.category}</td>
                  <td>{item.unit}</td>
                  <td>{item.qty}</td>
                  <td>{formatNaira(item.unit_cost)}</td>
                  <td>{formatNaira(item.qty * item.unit_cost)}</td>
                  <td>{item.budget}</td>
                  <td>{item.section}</td>
                  <td>{item.building_type}</td>
                  {isAdmin && (
                    <td>
                      <div className="table-actions">
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setEditItem(item);
                            setEditQty(item.qty);
                            setEditUnitCost(item.unit_cost);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => {
                            if (confirm('Delete this item?')) deleteMutation.mutate(item.id);
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
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <span>
              Page {page + 1} of {Math.ceil(items.length / perPage)}
            </span>
            <button
              className="btn btn-secondary"
              disabled={page >= Math.ceil(items.length / perPage) - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        )}

        {editItem && (
          <div className="modal-overlay" onClick={() => setEditItem(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>Edit Item</h3>
              <div className="form-row">
                <div className="form-group">
                  <label>Quantity</label>
                  <input
                    type="number"
                    value={editQty}
                    onChange={(e) => setEditQty(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Unit Cost</label>
                  <input
                    type="number"
                    step={0.01}
                    value={editUnitCost}
                    onChange={(e) => setEditUnitCost(e.target.value)}
                  />
                </div>
              </div>
              <button className="btn btn-primary" onClick={handleUpdate}>
                Update
              </button>
              <button className="btn btn-secondary" onClick={() => setEditItem(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {isAdmin && (
          <div className="danger-zone">
            <button
              className="btn btn-danger"
              onClick={() => setShowDeleteAll(true)}
            >
              Delete ALL inventory
            </button>
          </div>
        )}

        {showDeleteAll && (
          <div className="modal-overlay" onClick={() => setShowDeleteAll(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>Delete All Inventory</h3>
              <p>This will permanently delete all inventory items. Requests will not be affected. This cannot be undone. Are you sure?</p>
              <div className="modal-actions">
                <button className="btn btn-danger" onClick={handleDeleteAll}>
                  Yes, Delete All
                </button>
                <button className="btn btn-secondary" onClick={() => setShowDeleteAll(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
