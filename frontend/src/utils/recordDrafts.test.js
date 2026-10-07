import test from 'node:test';
import assert from 'node:assert/strict';
import { INVENTORY_VIEW, ACTUALS_VIEW, INVENTORY_DRAFT, AVAILABILITY_DRAFT, isInventoryView, isActualsView, isInventoryDraft, isAvailabilityDraft, inventoryDraftFor, availabilityDraftFor, resolveRecordDraft, reviewedRecordFor, isReviewCurrent } from './recordDrafts.js';
import { workspaceStateKey, writeWorkspaceState, readWorkspaceState, removeWorkspaceState } from './workspaceState.js';

const item = { id: 41, name: 'Cement', project_site: 'Site A', planned_qty: 10.5, planned_unit_cost: 100.01, qty: -2.5, unit_cost: 120, created_at: '2026-10-07T09:00:00' };

const admin = { user_id: 1, username: 'Istrom_Admin', user_type: 'admin', project_site: null, is_global_admin: true };

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test('saved views keep filters and a valid page without deletion targets', () => {
  assert.equal(isInventoryView({ ...INVENTORY_VIEW, search: 'Cement', page: 3 }), true);
  assert.equal(isInventoryView({ ...INVENTORY_VIEW, selected: [41] }), false);
  assert.equal(isInventoryView({ ...INVENTORY_VIEW, page: -1 }), false);
  assert.equal(isInventoryView({ ...INVENTORY_VIEW, page: '3' }), false);
  assert.equal(isInventoryView({ ...INVENTORY_VIEW, buildingType: null }), false);
  assert.equal(isActualsView({ ...ACTUALS_VIEW, budgetNum: 'Budget 21', buildingSubtype: 'Block A' }), true);
  assert.equal(isActualsView({ ...ACTUALS_VIEW, adjustItem: item }), false);
});

test('saved edit payload stores an ID, typed fields and scalar baseline only', () => {
  const draft = inventoryDraftFor(item);
  assert.deepEqual(draft, { itemId: 41, qty: '10.5', cost: '100.01', baseQty: 10.5, baseCost: 100.01, baseCreatedAt: item.created_at });
  assert.equal(isInventoryDraft(JSON.parse(JSON.stringify(draft))), true);
  assert.equal(isInventoryDraft({ ...draft, item }), false);
  assert.equal(isInventoryDraft({ ...draft, itemId: '41' }), false);
  assert.equal(isInventoryDraft({ ...draft, baseCost: Infinity }), false);
  assert.equal(isInventoryDraft({ ...draft, baseQty: -1 }), false);
  assert.equal(isInventoryDraft(null), true);
});

test('availability draft retains a shortfall and its original concurrency baseline', () => {
  const draft = availabilityDraftFor(item);
  assert.deepEqual(draft, { itemId: 41, qty: '2.5', cost: '120', over: true, baseQty: -2.5, baseCost: 120, baseCreatedAt: item.created_at });
  assert.equal(isAvailabilityDraft(JSON.parse(JSON.stringify(draft))), true);
  assert.equal(isAvailabilityDraft({ ...draft, over: 'true' }), false);
  assert.equal(isAvailabilityDraft({ ...draft, baseQty: NaN }), false);
  assert.equal(isAvailabilityDraft({ ...draft, baseCost: -1 }), false);
  assert.equal(isAvailabilityDraft(null), true);
});

test('empty typed fields remain drafts and never become stored server data', () => {
  assert.equal(isInventoryDraft({ ...inventoryDraftFor(item), qty: '', cost: '' }), true);
  assert.equal(isAvailabilityDraft({ ...availabilityDraftFor(item), qty: '' }), true);
});

test('restored edit resolves against the current item and current permission', () => {
  const draft = { ...inventoryDraftFor(item), qty: '23', cost: '145' };
  const fresh = { ...item, name: 'Cement bags' };
  assert.deepEqual(resolveRecordDraft('inventory', draft, [fresh], true), { item: fresh, changed: false });
  assert.deepEqual(resolveRecordDraft('inventory', draft, [fresh], false), { item: null, changed: false });
  assert.deepEqual(resolveRecordDraft('inventory', draft, [], true), { item: null, changed: false });
  assert.equal(draft.qty, '23');
});

test('a deleted item ID reused by a new record cannot receive the old draft', () => {
  const replacement = { ...item, created_at: '2026-10-07T10:00:00' };
  for (const [kind, createDraft] of [['inventory', inventoryDraftFor], ['availability', availabilityDraftFor]]) {
    assert.deepEqual(resolveRecordDraft(kind, createDraft(item), [replacement], true), { item: null, changed: false });
  }
});

test('planned values changed during refresh require review while typed edits stay intact', () => {
  const draft = { ...inventoryDraftFor(item), qty: '23' };
  for (const fresh of [{ ...item, planned_qty: 11 }, { ...item, planned_unit_cost: 101 }]) {
    assert.equal(resolveRecordDraft('inventory', draft, [fresh], true).changed, true);
  }
  assert.equal(draft.qty, '23');
  assert.equal(resolveRecordDraft('inventory', draft, [{ ...item, qty: 1 }], true).changed, false);
});

test('availability or current cost changes during refresh require review', () => {
  const draft = { ...availabilityDraftFor(item), qty: '9', over: false };
  for (const fresh of [{ ...item, qty: -3 }, { ...item, unit_cost: 130 }]) {
    assert.equal(resolveRecordDraft('availability', draft, [fresh], true).changed, true);
  }
  assert.equal(draft.baseQty, -2.5);
  assert.equal(draft.qty, '9');
  assert.equal(resolveRecordDraft('availability', draft, [{ ...item, planned_qty: 20 }], true).changed, false);
});

test('malformed restored drafts cannot select any fresh item', () => {
  for (const draft of [undefined, {}, { itemId: 41 }, [], { ...availabilityDraftFor(item), item }]) {
    assert.deepEqual(resolveRecordDraft('availability', draft, [item], true), { item: null, changed: false });
  }
});

test('server decimal strings normalize to the same scalar baseline', () => {
  const fresh = { ...item, planned_qty: '10.5', planned_unit_cost: '100.01', qty: '-2.5', unit_cost: '120' };
  assert.equal(isInventoryDraft(inventoryDraftFor(fresh)), true);
  assert.equal(isAvailabilityDraft(availabilityDraftFor(fresh)), true);
  assert.equal(resolveRecordDraft('inventory', inventoryDraftFor(fresh), [item], true).changed, false);
  assert.equal(resolveRecordDraft('availability', availabilityDraftFor(fresh), [item], true).changed, false);
});

test('a changed record needs a fresh review after refresh or another server change', () => {
  for (const kind of ['inventory', 'availability']) {
    const draft = kind === 'inventory' ? inventoryDraftFor(item) : availabilityDraftFor(item);
    const changed = kind === 'inventory' ? { ...item, planned_qty: 12 } : { ...item, qty: 7 };
    const reviewed = reviewedRecordFor(kind, draft, changed);
    assert.equal(isReviewCurrent(kind, draft, changed, null), false);
    assert.equal(isReviewCurrent(kind, draft, changed, reviewed), true);
    const changedAgain = kind === 'inventory' ? { ...changed, planned_unit_cost: 125 } : { ...changed, unit_cost: 130 };
    assert.equal(isReviewCurrent(kind, draft, changedAgain, reviewed), false);
    assert.equal(isReviewCurrent(kind, draft, { ...changed, id: 42 }, reviewed), false);
  }
});

test('reviewing fresh values keeps the persisted baseline and typed fields unchanged', () => {
  const draft = { ...availabilityDraftFor(item), qty: '18', cost: '145' };
  const before = JSON.stringify(draft);
  reviewedRecordFor('availability', draft, { ...item, qty: 9 });
  assert.equal(JSON.stringify(draft), before);
  assert.equal(draft.baseQty, -2.5);
  assert.equal(draft.qty, '18');
  assert.equal(isAvailabilityDraft({ ...draft, reviewed: true }), false);
});

for (const [kind, initial, validate, createDraft, name] of [
  ['inventory', INVENTORY_DRAFT, isInventoryDraft, inventoryDraftFor, 'inventory-edit'],
  ['availability', AVAILABILITY_DRAFT, isAvailabilityDraft, availabilityDraftFor, 'actuals-adjustment'],
]) {
  test(`${kind} draft survives the shared storage serializer and resolves a fresh record`, () => {
    const store = storage();
    const key = workspaceStateKey(admin, 'Site A', name);
    const draft = { ...createDraft(item), qty: '28', cost: '150' };
    assert.equal(writeWorkspaceState(key, draft, initial, validate, store), '');
    const restored = readWorkspaceState(key, initial, validate, store);
    assert.equal(restored.error, '');
    assert.deepEqual(restored.value, draft);
    assert.equal(resolveRecordDraft(kind, restored.value, [item], true).item.id, item.id);
    assert.equal(restored.value.qty, '28');
    assert.deepEqual(removeWorkspaceState(key, restored.value, initial, validate, store), { cleared: true, error: '' });
    const cleared = readWorkspaceState(key, initial, validate, store);
    assert.deepEqual(cleared.value, initial);
    assert.equal(resolveRecordDraft(kind, cleared.value, [item], true).item, null);
  });

  test(`${kind} storage keeps the fixed scalar schema and does not restore an empty modal`, () => {
    const store = storage();
    const key = workspaceStateKey(admin, 'Site A', name);
    assert.equal(validate(initial), true);
    assert.equal(validate({ ...initial, qty: '5' }), false);
    assert.equal(writeWorkspaceState(key, initial, initial, validate, store), '');
    const empty = readWorkspaceState(key, initial, validate, store);
    assert.equal(empty.error, '');
    assert.equal(empty.value.itemId, 0);
    assert.equal(resolveRecordDraft(kind, empty.value, [item], true).item, null);
    assert.equal(writeWorkspaceState(key, { ...createDraft(item), item, password: 'must-not-be-stored' }, initial, validate, store), '');
    const saved = JSON.parse(store.getItem(key)).value;
    assert.deepEqual(Object.keys(saved), Object.keys(initial));
    assert.equal('item' in saved, false);
    assert.equal('password' in saved, false);
  });
}
