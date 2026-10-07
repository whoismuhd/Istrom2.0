import ErrorMessage from '../components/ErrorMessage';
import LoadError from '../components/LoadError';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api } from '../api';
import { formatNaira } from '../api';
import { decimalProduct } from '../utils/numbers';

const PROPERTY_TYPES = ['', 'Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];

export default function ManualEntry() {
  const { isAdmin, getEffectiveProjectSite } = useAuth();
  const queryClient = useQueryClient();

  const [buildingType, setBuildingType] = useState('');
  const [budgetNum, setBudgetNum] = useState('');
  const [section, setSection] = useState('');
  const [budgetLabel, setBudgetLabel] = useState('');
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('pcs');
  const [unitCost, setUnitCost] = useState('');
  const [category, setCategory] = useState('Materials');
  const [formError, setFormError] = useState('');

  const { data: constants = {}, error: constantsError, isLoading: constantsLoading, refetch: retryConstants } = useQuery({
    queryKey: ['constants'],
    queryFn: () => api.constants.get(),
  });

  const sections = constants.CONSTRUCTION_SECTIONS || [];
  const categories = constants.CATEGORY_OPTIONS || ['Materials', 'Labour', 'Material/Labour'];
  const budgetLabels = buildBudgetLabels(buildingType, budgetNum, constants);

  const createMutation = useMutation({
    mutationFn: (data) => api.items.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setFormError('');
      setName('');
      setQty('');
      setUnitCost('');
    },
  });

  const loadError = constantsError;
  if (loadError) return <LoadError error={loadError} onRetry={() => { retryConstants(); }} />;
  if (constantsLoading) return <div className="card" role="status">Loading...</div>;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!getEffectiveProjectSite()) {
      setFormError('Select a project site in the header before adding an item.');
      return;
    }
    setFormError('');
    createMutation.reset();
    if (!isAdmin) return;
    if (!name.trim() || !buildingType || !budgetNum || !section || !budgetLabels.includes(budgetLabel)) {
      setFormError('Enter an item name and select a building type, budget number, section, and budget label.');
      return;
    }

    const qtyNum = qty === '' ? 0 : parseFloat(qty) || 0;
    const unitCostNum = unitCost === '' ? 0 : parseFloat(unitCost) || 0;
    createMutation.mutate({
      name: name.trim(),
      qty: qtyNum,
      unit,
      unit_cost: unitCostNum,
      category,
      budget: budgetLabel,
      section,
      building_type: buildingType,
      project_site: getEffectiveProjectSite(),
    });
  };

  const qtyNum = qty === '' ? 0 : parseFloat(qty) || 0;
  const unitCostNum = unitCost === '' ? 0 : parseFloat(unitCost) || 0;
  const lineAmount = decimalProduct(qtyNum, unitCostNum);

  return (
    <div className="card">
      <h1>Add items</h1>
      <ErrorMessage error={createMutation.error || formError} />
      {createMutation.isSuccess && <p className="request-confirmation" role="status">{createMutation.data.name} added to inventory.</p>}
      {isAdmin && !getEffectiveProjectSite() && <div className="alert alert-warning">Select a project site in the header before adding an item.</div>}

      {!isAdmin && (
        <div className="alert alert-warning">
          Read-only mode. You do not have permission to add items.
        </div>
      )}

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="manualentry-field-1">Building type</label>
          <select id="manualentry-field-1" value={buildingType} onChange={(e) => { setBuildingType(e.target.value); setBudgetLabel(''); }}>
            {PROPERTY_TYPES.map((t) => (
              <option key={t || 'all'} value={t}>
                {t || 'All'}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="manualentry-field-2">Budget number</label>
          <select id="manualentry-field-2" value={budgetNum} onChange={(e) => { setBudgetNum(e.target.value); setBudgetLabel(''); }}>
            <option value="">All</option>
            {Array.from({ length: 20 }, (_, i) => (
              <option key={i} value={`Budget ${i + 1}`}>
                Budget {i + 1}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="manualentry-field-3">Section</label>
          <select id="manualentry-field-3" value={section} onChange={(e) => setSection(e.target.value)}>
            <option value="">All</option>
            {sections.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="manualentry-field-4">Budget</label>
          <select id="manualentry-field-4" value={budgetLabel} onChange={(e) => setBudgetLabel(e.target.value)}>
            <option value="">All</option>
            {budgetLabels.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isAdmin && (
        <form onSubmit={handleSubmit} className="add-item-form">
          <div className="form-row">
            <div className="form-group form-group-wide">
              <label htmlFor="manualentry-field-5">Item name</label>
              <input id="manualentry-field-5"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Item name"
                maxLength={255}
                disabled={createMutation.isPending}
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="manualentry-field-6">Quantity</label>
              <input id="manualentry-field-6"
                type="number"
                required
                disabled={createMutation.isPending}
                min={0}
                step="any"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="form-group">
              <label htmlFor="manualentry-field-7">Unit</label>
              <input id="manualentry-field-7"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="pcs, trips, bags"
                required
                maxLength={50}
                disabled={createMutation.isPending}
              />
            </div>
            <div className="form-group">
              <label htmlFor="manualentry-field-8">Unit cost (₦)</label>
              <input id="manualentry-field-8"
                type="number"
                required
                disabled={createMutation.isPending}
                min={0}
                step={0.01}
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="form-group">
              <label htmlFor="manualentry-field-9">Category</label>
              <select id="manualentry-field-9" disabled={createMutation.isPending} value={category} onChange={(e) => setCategory(e.target.value)}>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="line-amount">Line amount: {formatNaira(lineAmount)}</p>
          <button type="submit" className="btn btn-primary" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Adding…' : 'Add item'}
          </button>
        </form>
      )}
    </div>
  );
}

function buildBudgetLabels(buildingType, budgetNum, constants) {
  const cats = constants.BUDGET_CATEGORIES || ['General Materials', 'Woods', 'Plumbings', 'Irons', 'Labour', 'Electrical', 'Mechanical'];
  const bt = buildingType && buildingType !== 'All' ? buildingType : 'Flats';
  const bn = budgetNum && budgetNum !== 'All' ? budgetNum : 'Budget 1';
  const labels = [];
  for (const c of cats) {
    labels.push(`${bn} - ${bt}(${c})`);
  }
  return labels;
}
