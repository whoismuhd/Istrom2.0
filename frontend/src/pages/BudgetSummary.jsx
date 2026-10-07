import LoadError from '../components/LoadError';
import { matchesBudget, plannedAmount, toCSV, scopeTotals, budgetNumberOptions } from '../utils/budgets';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api, formatNaira } from '../api';
import './BudgetSummary.css';

const BUILDING_TYPES = ['Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];

function AccordionSection({ title, total, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`budget-accordion-section${open ? ' open' : ''}`}>
      <button
        type="button"
        className={`budget-accordion-header${open ? ' open' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true" className={`budget-accordion-chevron${open ? ' open' : ''}`}>{'>'}</span>
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

  const { data: items = [], error: itemsError, isLoading: itemsLoading, refetch: retryItems } = useQuery({
    queryKey: ['items', { project_site: getEffectiveProjectSite() }],
    queryFn: () => api.items.list({ project_site: getEffectiveProjectSite() }),
  });

  const loadError = itemsError;
  if (loadError) return <LoadError error={loadError} onRetry={() => { retryItems(); }} />;
  if (itemsLoading) return <div className="card" role="status">Loading...</div>;

  const budgetItems = activeBudget === 'All'
    ? items
    : items.filter((i) => matchesBudget(i.budget, activeBudget));

  const byType = {};
  for (const bt of BUILDING_TYPES) {
    byType[bt] = budgetItems
      .filter((i) => i.building_type === bt)
      .reduce((s, i) => s + plannedAmount(i), 0);
  }

  const totalAmount = budgetItems.reduce((s, i) => s + plannedAmount(i), 0);

  const downloadCSV = () => {
    const rows = [
      ['Building Type', 'Building scope', 'Project site', 'Planned amount'],
      ...BUILDING_TYPES.flatMap((bt) => scopeTotals(budgetItems.filter((i) => i.building_type === bt)).map((s) => [bt, s.scope, s.projectSite, s.total])),
      ['Total', '', '', totalAmount],
    ];
    const csv = toCSV(rows);
    const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
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
            <h1>Budget summary</h1>
            <p className="budget-summary-caption">Planned costs by budget and building type.</p>
          </div>
          <button className="btn btn-secondary" onClick={downloadCSV}>
            Export CSV
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
            {budgetNumberOptions(items).map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>

        <div className="budget-detail-section">
          <h3 className="budget-detail-title">{activeBudget === 'All' ? 'All Budgets' : activeBudget} Summary</h3>
          <div className="budget-total-amount">
            <span className="budget-total-label">
              Total Amount for {activeBudget === 'All' ? 'All Budgets' : activeBudget}
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
              const scopes = scopeTotals(budgetItems.filter((i) => i.building_type === buildingType));
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
                          <th>Building scope</th>
                          <th>Project site</th>
                          <th>Planned</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scopes.map((scope) => (
                          <tr key={`${scope.projectSite}::${scope.scope}`}>
                            <td>{scope.scope}</td>
                            <td>{scope.projectSite}</td>
                            <td>{formatNaira(scope.total)}</td>
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
            Planned amounts cover each budget's recorded building scope.
          </p>
        </div>
      </div>
    </div>
  );
}
