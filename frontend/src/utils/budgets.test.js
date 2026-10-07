import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesBudget, plannedAmount, plannedTotal, budgetPosition, toCSV, scopeTotals, budgetNumberOptions, buildingTypeLabel, budgetBuildingTypes } from './budgets.js';

test('Imported budget numbers above 20 remain available without prefix collisions', () => {
  const items = [{ budget: 'Budget 21 - Flats(Labour)' }, { budget: 'Budget 101 - Flats(Woods)' }, { budget: 'Budget 21 - Flats(Irons)' }];
  assert.ok(budgetNumberOptions(items).includes('Budget 21'));
  assert.equal(budgetNumberOptions(items).at(-1), 'Budget 101');
  assert.equal(budgetNumberOptions(items).filter((label) => label === 'Budget 21').length, 1);
  assert.equal(matchesBudget(items[1].budget, 'Budget 1'), false);
});

test('Scope totals preserve separate building scopes and sites without repeating the site total', () => {
  const items = [
    { project_site: 'Site A', budget_scope: 'SD 22-25', planned_qty: 1936, planned_unit_cost: 11400 },
    { project_site: 'Site A', budget_scope: 'SD 22-25', planned_qty: 4, planned_unit_cost: 1000 },
    { project_site: 'Site A', budget_scope: 'SD 26-29', planned_qty: 2, planned_unit_cost: 1000 },
    { project_site: 'Site B', budget_scope: 'SD 22-25', planned_qty: 1, planned_unit_cost: 1000 },
  ];
  const scopes = scopeTotals(items);
  assert.equal(scopes.length, 3);
  assert.equal(scopes[0].total, 22074400);
  assert.equal(scopes.reduce((sum, scope) => sum + scope.total, 0), items.reduce((sum, item) => sum + plannedAmount(item), 0));
});

test('Report scope totals and CSV preserve exact fractional prices', () => {
  const items = Array.from({length:100}, () => ({project_site:'Site A', planned_qty:1, planned_unit_cost:0.01}));
  const scopes = scopeTotals(items);
  assert.equal(plannedTotal(items), 1);
  assert.equal(scopes[0].total, 1);
  assert.equal(toCSV(scopes.map((scope) => [scope.projectSite, scope.total])), 'Site A,1');
});

test('Report building groups include custom and unassigned records in their breakdown and export', () => {
  const items = [{building_type:'Flats',qty:1,unit_cost:10}, {building_type:'Gatehouse',qty:2,unit_cost:10},
    {building_type:null,qty:3,unit_cost:10}];
  const types = budgetBuildingTypes(items, ['Flats','Terraces']);
  assert.deepEqual(types, ['Flats','Terraces','Gatehouse','Unassigned building']);
  const rows = types.map((type) => [type, plannedTotal(items.filter((item) => buildingTypeLabel(item) === type))]);
  assert.equal(rows.reduce((sum, [,amount]) => sum + amount, 0), plannedTotal(items));
  assert.ok(toCSV(rows).includes('Gatehouse,20\r\nUnassigned building,30'));
});

test('Budget 1 excludes budgets 10 through 19', () => {
  for (let n = 10; n < 20; n++) assert.equal(matchesBudget(`Budget ${n} - Flats(Woods)`, 'Budget 1'), false);
  assert.equal(matchesBudget('Budget 1 - Flats(Woods)', 'Budget 1'), true);
  assert.equal(matchesBudget('Budget 1', 'Budget 1'), true);
  assert.equal(matchesBudget(null, 'Budget 1'), false);
  assert.equal(matchesBudget('Budget 20 - Terraces(Labour)', 'Budget 20'), true);
  assert.equal(matchesBudget('Budget 1 - Flats(Woods)', 'All'), true);
});

test('Budget calculation uses planned values and preserves zero', () => {
  assert.equal(plannedAmount({ qty: 6, unit_cost: 1200, planned_qty: 10, planned_unit_cost: 1000 }), 10000);
  assert.equal(plannedAmount({ qty: 6, unit_cost: 1200, planned_qty: 0, planned_unit_cost: 0 }), 0);
  assert.equal(plannedAmount({ qty: 10, unit_cost: 1000 }), 10000);
});

test('CSV escapes formatted money, commas, quotes, and newlines', () => {
  assert.equal(toCSV([['Building Type', 'Total Amount'], ['Flats', '₦10,000.00']]), 'Building Type,Total Amount\r\nFlats,"₦10,000.00"');
  assert.equal(toCSV([['A "quoted", label', 'two\nlines']]), '"A ""quoted"", label","two\nlines"');
});

test('Overspending is a positive over-budget amount and remaining budget is zero', () => {
  assert.deepEqual(budgetPosition(10000, 20000), { remainingBudget: 0, overBudget: 10000 });
  assert.deepEqual(budgetPosition(10000, 6000), { remainingBudget: 4000, overBudget: 0 });
  assert.deepEqual(budgetPosition(10000, 10000), { remainingBudget: 0, overBudget: 0 });
  assert.deepEqual(budgetPosition(0, 125), { remainingBudget: 0, overBudget: 125 });
});

test('Fractional prices cannot produce a zero-value over-budget warning', () => {
  assert.deepEqual(budgetPosition(0.3, 0.1 + 0.2), { remainingBudget: 0, overBudget: 0 });
  assert.deepEqual(budgetPosition(10000, 10000.001), { remainingBudget: 0, overBudget: 0 });
  assert.deepEqual(budgetPosition(10000, 10000.01), { remainingBudget: 0, overBudget: 0.01 });
  assert.deepEqual(budgetPosition(10000, 10000.005), { remainingBudget: 0, overBudget: 0.01 });
  assert.equal(plannedAmount({ planned_qty: 0.1, planned_unit_cost: 0.2 }), 0.02);
});

test('CSV prevents formulas in text fields while preserving numeric values', () => {
  for (const value of ['=1+1', '+SUM(A1:A2)', '-10+20', '@SUM(A1)', '  =1+1', '\t=1+1', '\r=1+1', '\n=1+1']) {
    assert.ok(toCSV([[value]]).replaceAll('"', '').startsWith("'"));
  }
  assert.equal(toCSV([[-20, 120, 'Cement']]), '-20,120,Cement');
});
