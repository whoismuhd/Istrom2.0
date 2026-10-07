import assert from 'node:assert/strict';
import test from 'node:test';
import { editFormDraft, formSubmissionKey, MANUAL_ENTRY_DRAFT, manualDraftSelection, REQUEST_DRAFT, requestDraftSelection } from './formDrafts.js';

const items = [
  { id: 1, name: 'Cement', building_type: 'Flats', budget: 'Budget 1 - Flats(General Materials)', qty: 12 },
  { id: 2, name: 'Timber', building_type: 'Terraces', budget: 'Budget 2 - Terraces(Woods)', qty: 4 },
];

test('a request draft resolves fresh item and subtype data after restoration', () => {
  const draft = { ...REQUEST_DRAFT, buildingType: 'Flats', budgetNum: 'Budget 1', budgetLabel: items[0].budget, itemId: '1', buildingSubtype: 'B2', qty: '8', note: 'Site work' };
  const selection = requestDraftSelection(draft, [{ ...items[0], qty: 2 }, items[1]]);
  assert.equal(selection.selectedItem.qty, 2);
  assert.equal(selection.staleItem, false);
  assert.equal(selection.staleBudget, false);
  assert.equal(selection.staleSubtype, false);
  assert.equal(draft.qty, '8');
});

test('removed or moved items cannot resolve as a saved request selection', () => {
  const draft = { ...REQUEST_DRAFT, buildingType: 'Flats', budgetNum: 'Budget 1', budgetLabel: items[0].budget, itemId: '1' };
  assert.equal(requestDraftSelection(draft, [items[1]]).staleItem, true);
  const moved = requestDraftSelection(draft, [{ ...items[0], budget: 'Budget 3 - Flats(General Materials)' }, items[1]]);
  assert.equal(moved.selectedItem, undefined);
  assert.equal(moved.staleBudget, true);
});

test('a saved item cannot bypass its current building and budget filters', () => {
  assert.equal(requestDraftSelection({ ...REQUEST_DRAFT, itemId: '2', buildingType: 'Flats' }, items).selectedItem, undefined);
  assert.equal(requestDraftSelection({ ...REQUEST_DRAFT, itemId: '1', budgetNum: 'Budget 2' }, items).selectedItem, undefined);
});

test('a changed item building rejects a saved subtype even without a building filter', () => {
  const selection = requestDraftSelection({ ...REQUEST_DRAFT, itemId: '1', buildingSubtype: 'B2' }, [{ ...items[0], building_type: 'Terraces' }]);
  assert.equal(selection.staleItem, false);
  assert.equal(selection.staleSubtype, true);
  assert.equal(selection.selectedBuildingType, 'Terraces');
});

test('a restored request cannot select a replacement item that reused its ID and budget', () => {
  const draft = { ...REQUEST_DRAFT, itemId: '1', itemCreatedAt: '2026-10-07T10:00:00', budgetLabel: items[0].budget };
  const replacement = { ...items[0], name: 'Replacement item', created_at: '2026-10-07T11:00:00' };
  const selection = requestDraftSelection(draft, [replacement]);
  assert.equal(selection.staleItem, true);
  assert.equal(selection.selectedItem, undefined);
  const reselected = requestDraftSelection({ ...draft, itemCreatedAt: replacement.created_at }, [replacement]);
  assert.equal(reselected.staleItem, false);
  assert.equal(reselected.selectedItem.name, 'Replacement item');
});

test('an older request draft without saved creation identity requires item reselection', () => {
  const draft = { ...REQUEST_DRAFT, itemId: '1', budgetLabel: items[0].budget };
  const selection = requestDraftSelection(draft, [{ ...items[0], created_at: '2026-10-07T10:00:00' }]);
  assert.equal(selection.staleItem, true);
});

test('custom building requests do not inherit an unrelated saved subtype', () => {
  const selection = requestDraftSelection({ ...REQUEST_DRAFT, itemId: '3', buildingSubtype: 'B2' }, [{ id: 3, building_type: 'Gatehouse', budget: 'Gatehouse' }]);
  assert.equal(selection.staleSubtype, true);
  assert.deepEqual(selection.subtypeOptions, []);
});

test('manual drafts keep their fields while identifying constants removed since saving', () => {
  const draft = { ...MANUAL_ENTRY_DRAFT, buildingType: 'Flats', budgetNum: 'Budget 1', budgetLabel: items[0].budget, section: 'Old section', category: 'Old category', name: 'Cement', qty: '10', unitCost: '50' };
  const selection = manualDraftSelection(draft, { CONSTRUCTION_SECTIONS: ['New section'], CATEGORY_OPTIONS: ['Materials'] });
  assert.equal(selection.staleSection, true);
  assert.equal(selection.staleCategory, true);
  assert.equal(selection.staleBudget, false);
  assert.equal(draft.name, 'Cement');
  assert.equal(draft.qty, '10');
});

test('manual drafts cannot submit a budget label for a different current building', () => {
  const selection = manualDraftSelection({ ...MANUAL_ENTRY_DRAFT, buildingType: 'Terraces', budgetNum: 'Budget 2', budgetLabel: items[0].budget }, {});
  assert.equal(selection.staleBudget, true);
});

test('restored submissions reuse their key while deliberately edited details get a new key', () => {
  const submitted = { ...REQUEST_DRAFT, qty: '2', submissionKey: '7bba3a03-4544-4c7e-a870-9aad45fd4407' };
  const restored = JSON.parse(JSON.stringify(submitted));
  assert.equal(formSubmissionKey(restored), submitted.submissionKey);
  assert.equal(formSubmissionKey(editFormDraft(restored, { qty: '2' })), submitted.submissionKey);
  const edited = editFormDraft(restored, { qty: '3' });
  assert.equal(edited.submissionKey, '');
  assert.notEqual(formSubmissionKey(edited), submitted.submissionKey);
});

test('manual entry retries preserve their key across refresh and discard starts a new operation', () => {
  const submitted = { ...MANUAL_ENTRY_DRAFT, name: 'Cement', qty: '20', submissionKey: formSubmissionKey(MANUAL_ENTRY_DRAFT) };
  assert.equal(formSubmissionKey(JSON.parse(JSON.stringify(submitted))), submitted.submissionKey);
  assert.notEqual(formSubmissionKey(MANUAL_ENTRY_DRAFT), submitted.submissionKey);
  assert.equal(editFormDraft(submitted, { name: 'Timber' }).submissionKey, '');
});
