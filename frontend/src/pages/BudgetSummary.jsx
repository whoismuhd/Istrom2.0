import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api, formatNaira } from '../api';
import './BudgetSummary.css';

const BUILDING_TYPES = ['Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];
const BUDGET_NUMBERS = Array.from({ length: 20 }, (_, i) => `Budget ${i + 1}`);

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

function AccordionSection({ title, total, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`budget-accordion-section${open ? ' open' : ''}`}>
      <button
        type="button"
        className={`budget-accordion-header${open ? ' open' : ''}`}
        onClick={() => setOpen(!open)}
      >
        <span className={`budget-accordion-chevron${open ? ' open' : ''}`}>{'>'}</span>
        <span className="budget-accordion-title">{title}</span>
        <span className="budget-accordion-total">{total}</span>
      </button>
      {open && <div className="budget-accordion-body">{children}</div>}
    </div>
  );
}

export default function BudgetSummary() {
  const { getEffectiveProjectSite } = useAuth();
  const [activeBudget, setActiveBudget] = useState('All');

  const { data: items = [] } = useQuery({
    queryKey: ['items', { project_site: getEffectiveProjectSite() }],
    queryFn: () => api.items.list({ project_site: getEffectiveProjectSite() }),
  });

  const budgetItems = activeBudget === 'All'
    ? items
    : items.filter((i) => (i.budget || '').includes(activeBudget));

  const byType = {};
  for (const bt of BUILDING_TYPES) {
    byType[bt] = budgetItems
      .filter((i) => i.building_type === bt)
      .reduce((s, i) => s + i.qty * i.unit_cost, 0);
  }

  const totalAmount = budgetItems.reduce((s, i) => s + i.qty * i.unit_cost, 0);

  const downloadCSV = () => {
    const rows = [
      ['Building Type', 'Total Amount'],
      ...BUILDING_TYPES.map((bt) => [bt, formatNaira(byType[bt] || 0)]),
      ['Total', formatNaira(totalAmount)],
    ];
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `budget-summary-${activeBudget.replace(/\s/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="budget-summary-page">
      <div className="card">
        <div className="budget-summary-header">
          <div>
            <h2>Manual Budget Summary</h2>
            <p className="budget-summary-caption">Add custom budget summary information for each budget number</p>
          </div>
          <button className="btn btn-secondary" onClick={downloadCSV}>
            Download Summary CSV
          </button>
        </div>

        <div className="budget-available-row">
          <label className="budget-available-title" htmlFor="budget-select">Available Budgets</label>
          <select
            id="budget-select"
            className="budget-dropdown"
            value={activeBudget}
            onChange={(e) => setActiveBudget(e.target.value)}
          >
            <option value="All">All</option>
            {BUDGET_NUMBERS.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>

        <div className="budget-detail-section">
          <h3 className="budget-detail-title">{activeBudget === 'All' ? 'All Budgets' : activeBudget} Summary</h3>
          <div className="budget-total-amount">
            <span className="budget-total-label">
              Total Amount for {activeBudget === 'All' ? 'All Budgets' : activeBudget}
              <span className="budget-info-icon" title="Budget summary for 1 unit">ⓘ</span>
            </span>
            <span className="budget-total-value">{formatNaira(totalAmount)}</span>
          </div>
          <div className="budget-kpi-grid">
            {BUILDING_TYPES.map((buildingType) => (
              <div key={buildingType} className="budget-kpi-card">
                <span className="budget-kpi-label">{buildingType}</span>
                <span className="budget-kpi-value">{formatNaira(byType[buildingType] || 0)}</span>
              </div>
            ))}
          </div>
          <h4 className="budget-breakdown-title">Breakdown by Building Type</h4>
          <div className="budget-accordion">
            {BUILDING_TYPES.map((buildingType) => {
              const total = byType[buildingType] || 0;
              const blocks = BUILDING_SUBTYPE_OPTIONS[buildingType] || [];
              return (
                <AccordionSection
                  key={buildingType}
                  title={buildingType}
                  total={formatNaira(total)}
                >
                  <div className="table-wrap">
                    <table className="budget-blocks-table">
                      <thead>
                        <tr>
                          <th>Block/Unit</th>
                          <th>Planned</th>
                        </tr>
                      </thead>
                      <tbody>
                        {blocks.map((block) => (
                          <tr key={block}>
                            <td>{block}</td>
                            <td>{formatNaira(total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="budget-section-footer">
                    {buildingType} Total - Planned: {formatNaira(total)}
                  </p>
                </AccordionSection>
              );
            })}
          </div>
          <p className="budget-note">
            Note: All amounts shown below are for 1 unit only
          </p>
        </div>
      </div>
    </div>
  );
}
