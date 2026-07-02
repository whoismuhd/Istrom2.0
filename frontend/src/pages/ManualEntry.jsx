import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api } from '../api';
import { formatNaira } from '../api';

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

  const { data: constants = {} } = useQuery({
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
      setName('');
      setQty('');
      setUnitCost('');
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!isAdmin) return;
    if (!name.trim()) return;
    if (buildingType === 'All' || buildingType === '') return;
    if (budgetNum === 'All' || budgetNum === '') return;
    if (section === 'All' || section === '') return;
    if (budgetLabel === 'All' || !budgetLabel) return;

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
  const lineAmount = qtyNum * unitCostNum;

  return (
    <div className="card">
      <h2>Manual Entry - Budget Builder</h2>
      <p className="caption">Add items with proper categorization and context</p>

      {!isAdmin && (
        <div className="alert alert-warning">
          Read-only mode. You do not have permission to add items.
        </div>
      )}

      <div className="form-row">
        <div className="form-group">
          <label>Building Type</label>
          <select value={buildingType} onChange={(e) => setBuildingType(e.target.value)}>
            {PROPERTY_TYPES.map((t) => (
              <option key={t || 'all'} value={t}>
                {t || 'All'}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Budget Number</label>
          <select value={budgetNum} onChange={(e) => setBudgetNum(e.target.value)}>
            <option value="">All</option>
            {Array.from({ length: 20 }, (_, i) => (
              <option key={i} value={`Budget ${i + 1}`}>
                Budget {i + 1}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Section</label>
          <select value={section} onChange={(e) => setSection(e.target.value)}>
            <option value="">All</option>
            {sections.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Budget Label</label>
          <select value={budgetLabel} onChange={(e) => setBudgetLabel(e.target.value)}>
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
              <label>Item Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Item name"
                required
              />
            </div>
            <div className="form-group">
              <label>Quantity</label>
              <input
                type="number"
                min={0}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="form-group">
              <label>Unit</label>
              <input
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="pcs, trips, bags"
              />
            </div>
            <div className="form-group">
              <label>Unit Cost (₦)</label>
              <input
                type="number"
                min={0}
                step={0.01}
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="form-group">
              <label>Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="line-amount">Line Amount: {formatNaira(lineAmount)}</p>
          <button type="submit" className="btn btn-primary" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Adding...' : 'Add Item'}
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
