import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api, formatNaira } from '../api';
import './Actuals.css';

const PROPERTY_TYPES = ['', 'All', 'Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];

const BUILDING_SUBTYPE_OPTIONS = {
  Flats: ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'B13'],
  Terraces: [
    'A (T1-T6)', 'B (T7-T12)', 'C (T13-T18)', 'D (T19-T24)', 'E (T25-T30)', 'F (T31-T36)',
    'G (T37-T42)', 'H (T43-T48)', 'I (T49-T53)', 'J (T54-T58)', 'K (T59-T64)', 'L (T65-T70)',
    'M (T71-T76)', 'N (T77-T82)', 'O (T83-T88)', 'P (T89-T94)', 'Q (T95-T100)', 'R (T101-T106)',
    'S (T107-T112)', 'T (T113-T118)', 'U (T119-T124)', 'V (T125-T130)', 'W (T131-T136)', 'X (T137-T142)',
  ],
  'Semi-detached': Array.from({ length: 29 }, (_, i) => `SD ${i + 1}`),
  'Fully-detached': Array.from({ length: 52 }, (_, i) => `D${i + 1}`),
};

const BUILDING_SUBTYPE_LABELS = {
  Flats: 'Select Block',
  Terraces: 'Select Terrace Cluster',
  'Semi-detached': 'Select Semi-detached Unit',
  'Fully-detached': 'Select Fully-detached Plot',
};

export default function Actuals() {
  const { getEffectiveProjectSite } = useAuth();

  const [budgetNum, setBudgetNum] = useState('');
  const [buildingType, setBuildingType] = useState('');
  const [buildingSubtype, setBuildingSubtype] = useState('');
  const params = {};
  const ps = getEffectiveProjectSite();
  if (ps) params.project_site = ps;

  const { data: items = [] } = useQuery({
    queryKey: ['items', params],
    queryFn: () => api.items.list(params),
  });

  const { data: actuals = [] } = useQuery({
    queryKey: ['actuals', params],
    queryFn: () => api.actuals.list(params),
  });

  let filteredItems = items;
  if (budgetNum) filteredItems = filteredItems.filter((i) => (i.budget || '').includes(budgetNum));
  if (buildingType) filteredItems = filteredItems.filter((i) => i.building_type === buildingType);

  const actualsByItem = {};
  for (const a of actuals) {
    if (buildingSubtype && a.building_subtype !== buildingSubtype) continue;
    if (!actualsByItem[a.item_id]) actualsByItem[a.item_id] = [];
    actualsByItem[a.item_id].push(a);
  }

  const needsSubtype = buildingType && BUILDING_SUBTYPE_OPTIONS[buildingType];
  const subtypeOptions = needsSubtype ? BUILDING_SUBTYPE_OPTIONS[buildingType] : [];

  // Group items by category (grp or category). Normalize "Materials" → "General Materials"
  const byCategory = {};
  for (const item of filteredItems) {
    let cat = item.grp || item.category || 'General Materials';
    if (cat === 'Materials') cat = 'General Materials';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(item);
  }

  return (
    <div className="actuals-page">
      <div className="card">
        <h2 className="actuals-filters-title">Filters</h2>
        <div className="actuals-filters">
          <div className="form-group">
            <label>
              Budget Number
            </label>
            <select value={budgetNum} onChange={(e) => setBudgetNum(e.target.value)}>
              <option value="">All</option>
              {Array.from({ length: 20 }, (_, i) => (
                <option key={i} value={`Budget ${i + 1}`}>Budget {i + 1}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Building Type</label>
            <select
              value={buildingType}
              onChange={(e) => {
                setBuildingType(e.target.value);
                setBuildingSubtype('');
              }}
            >
              <option value="">All</option>
              {PROPERTY_TYPES.filter((t) => t && t !== 'All').map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          {needsSubtype && (
            <div className="form-group">
              <label>{BUILDING_SUBTYPE_LABELS[buildingType]}</label>
              <select value={buildingSubtype} onChange={(e) => setBuildingSubtype(e.target.value)}>
                <option value="">All</option>
                {subtypeOptions.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="actuals-heading">
          <h3>All Budgets</h3>
          <span className="actuals-comparison-label">BUDGET vs ACTUAL COMPARISON</span>
        </div>

        {Object.entries(byCategory).map(([category, categoryItems]) => (
          <div key={category} className="actuals-comparison-section">
            <div className="actuals-comparison-header">
              <span className="actuals-category-label">{category.toUpperCase()}</span>
            </div>
            <div className="actuals-tables-row">
              <div className="actuals-planned-column">
                <h4 className="actuals-column-title">PLANNED BUDGET</h4>
                <div className="table-wrap">
                  <table className="actuals-table">
                    <thead>
                      <tr>
                        <th>S/N</th>
                        <th>Item</th>
                        <th>Qty</th>
                        <th>Unit</th>
                        <th>Unit Cost</th>
                        <th>Total Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {categoryItems.map((item, idx) => (
                        <tr key={item.id}>
                          <td>{idx + 1}</td>
                          <td>{item.name}</td>
                          <td>{item.qty}</td>
                          <td>{item.unit}</td>
                          <td>{formatNaira(item.unit_cost)}</td>
                          <td>{formatNaira(item.qty * item.unit_cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="actuals-actual-column">
                <h4 className="actuals-column-title">
                  ACTUALS
                </h4>
                <div className="table-wrap">
                  <table className="actuals-table">
                    <thead>
                      <tr>
                        <th>S/N</th>
                        <th>Item</th>
                        <th>Qty</th>
                        <th>Unit</th>
                        <th>Unit Cost</th>
                        <th>Total Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {categoryItems.map((item, idx) => {
                        const acts = actualsByItem[item.id] || [];
                        const totalQty = acts.reduce((s, a) => s + a.actual_qty, 0);
                        const totalCost = acts.reduce((s, a) => s + a.actual_cost, 0);
                        const avgUnitCost = totalQty > 0 ? totalCost / totalQty : 0;
                        return (
                          <tr key={item.id}>
                            <td>{idx + 1}</td>
                            <td>{item.name}</td>
                            <td>{totalQty}</td>
                            <td>{item.unit}</td>
                            <td>{formatNaira(avgUnitCost)}</td>
                            <td>{formatNaira(totalCost)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        ))}

        {filteredItems.length === 0 && (
          <p className="actuals-empty">No items match the selected filters.</p>
        )}
      </div>
    </div>
  );
}
