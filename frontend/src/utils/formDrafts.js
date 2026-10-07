import { matchesBudget } from './budgets.js';
import { BUILDING_SUBTYPE_OPTIONS, requestBuildingType } from './buildings.js';

export const REQUEST_DRAFT = {
  submissionKey: '',
  budgetNum: '',
  buildingType: '',
  budgetLabel: '',
  buildingSubtype: '',
  itemId: '',
  itemCreatedAt: '',
  qty: '1',
  currentPrice: '',
  note: '',
};

export const MANUAL_ENTRY_DRAFT = {
  submissionKey: '',
  buildingType: '',
  budgetNum: '',
  section: '',
  budgetLabel: '',
  name: '',
  qty: '',
  unit: 'pcs',
  unitCost: '',
  category: 'Materials',
};

export function draftChanged(draft, initial) {
  return Object.keys(initial).some((field) => field !== 'submissionKey' && draft[field] !== initial[field]);
}

export function editFormDraft(previous, changes) {
  if (!Object.entries(changes).some(([field, value]) => previous[field] !== value)) return previous;
  return { ...previous, ...changes, submissionKey: '' };
}

export function formSubmissionKey(draft) {
  return draft.submissionKey || crypto.randomUUID();
}

export function requestDraftSelection(draft, items) {
  const filteredItems = items.filter((item) =>
    (!draft.buildingType || item.building_type === draft.buildingType)
    && (!draft.budgetNum || matchesBudget(item.budget, draft.budgetNum))
    && (!draft.budgetLabel || item.budget === draft.budgetLabel));
  const selectedItem = filteredItems.find((item) => String(item.id) === draft.itemId
    && String(item.created_at || '') === draft.itemCreatedAt);
  const buildingType = requestBuildingType(selectedItem, draft.buildingType);
  const subtypeOptions = BUILDING_SUBTYPE_OPTIONS[buildingType] || [];
  const budgetLabels = [...new Set(items
    .filter((item) => !draft.budgetNum || matchesBudget(item.budget, draft.budgetNum))
    .map((item) => item.budget).filter(Boolean))].sort();

  return {
    filteredItems,
    selectedItem,
    selectedBuildingType: buildingType,
    subtypeOptions,
    budgetLabels,
    staleBudget: Boolean(draft.budgetLabel) && !budgetLabels.includes(draft.budgetLabel),
    staleItem: Boolean(draft.itemId) && !selectedItem,
    staleSubtype: Boolean(draft.buildingSubtype) && !subtypeOptions.includes(draft.buildingSubtype),
  };
}

export function manualDraftSelection(draft, constants) {
  const categories = constants.CATEGORY_OPTIONS || ['Materials', 'Labour', 'Material/Labour'];
  const sections = constants.CONSTRUCTION_SECTIONS || [];
  const budgetCategories = constants.BUDGET_CATEGORIES || ['General Materials', 'Woods', 'Plumbings', 'Irons', 'Labour', 'Electrical', 'Mechanical'];
  const buildingType = draft.buildingType && draft.buildingType !== 'All' ? draft.buildingType : 'Flats';
  const budgetNum = draft.budgetNum && draft.budgetNum !== 'All' ? draft.budgetNum : 'Budget 1';
  const budgetLabels = budgetCategories.map((category) => `${budgetNum} - ${buildingType}(${category})`);

  return {
    sections,
    categories,
    budgetLabels,
    staleSection: Boolean(draft.section) && !sections.includes(draft.section),
    staleCategory: Boolean(draft.category) && !categories.includes(draft.category),
    staleBudget: Boolean(draft.budgetLabel) && !budgetLabels.includes(draft.budgetLabel),
  };
}
