import { plannedQuantity, plannedUnitCost } from './budgets.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length <= 2000;
const isAmount = (value) => typeof value === 'number' && Number.isFinite(value);
const hasOnlyKeys = (value, keys) => isObject(value) && Object.keys(value).every((key) => keys.includes(key));

export const INVENTORY_VIEW = { buildingType: '', budgetNum: '', budgetLabel: '', section: '', search: '', page: 0 };
export const ACTUALS_VIEW = { budgetNum: '', buildingType: '', buildingSubtype: '' };
export const INVENTORY_DRAFT = { itemId: 0, qty: '', cost: '', baseQty: 0, baseCost: 0, baseCreatedAt: '' };
export const AVAILABILITY_DRAFT = { itemId: 0, qty: '', cost: '', over: false, baseQty: 0, baseCost: 0, baseCreatedAt: '' };

const isEmptyDraft = (value, initial) => Object.keys(initial).every((key) => value[key] === initial[key]);

export function isInventoryView(value) {
  return hasOnlyKeys(value, Object.keys(INVENTORY_VIEW))
    && ['buildingType', 'budgetNum', 'budgetLabel', 'section', 'search'].every((key) => isText(value[key]))
    && Number.isSafeInteger(value.page) && value.page >= 0;
}

export function isActualsView(value) {
  return hasOnlyKeys(value, Object.keys(ACTUALS_VIEW))
    && Object.keys(ACTUALS_VIEW).every((key) => isText(value[key]));
}

export function isInventoryDraft(value) {
  return value === null || (hasOnlyKeys(value, Object.keys(INVENTORY_DRAFT))
    && Number.isSafeInteger(value.itemId) && value.itemId >= 0
    && (value.itemId > 0 || isEmptyDraft(value, INVENTORY_DRAFT))
    && isText(value.qty) && isText(value.cost) && isText(value.baseCreatedAt)
    && isAmount(value.baseQty) && value.baseQty >= 0
    && isAmount(value.baseCost) && value.baseCost >= 0);
}

export function isAvailabilityDraft(value) {
  return value === null || (hasOnlyKeys(value, Object.keys(AVAILABILITY_DRAFT))
    && Number.isSafeInteger(value.itemId) && value.itemId >= 0
    && (value.itemId > 0 || isEmptyDraft(value, AVAILABILITY_DRAFT))
    && isText(value.qty) && isText(value.cost) && isText(value.baseCreatedAt) && typeof value.over === 'boolean'
    && isAmount(value.baseQty) && isAmount(value.baseCost) && value.baseCost >= 0);
}

export function inventoryDraftFor(item) {
  const baseQty = Number(plannedQuantity(item));
  const baseCost = Number(plannedUnitCost(item));
  return { itemId: item.id, qty: String(baseQty), cost: String(baseCost), baseQty, baseCost, baseCreatedAt: String(item.created_at || '') };
}

export function availabilityDraftFor(item) {
  const baseQty = Number(item.qty);
  const baseCost = Number(item.unit_cost);
  return { itemId: item.id, qty: String(Math.abs(baseQty)), cost: String(baseCost), over: baseQty < 0, baseQty, baseCost, baseCreatedAt: String(item.created_at || '') };
}

export function resolveRecordDraft(kind, draft, items, canEdit) {
  const valid = kind === 'inventory' ? isInventoryDraft(draft) : isAvailabilityDraft(draft);
  const item = valid && draft && canEdit ? items.find((record) => record.id === draft.itemId
    && String(record.created_at || '') === draft.baseCreatedAt) : null;
  if (!item) return { item: null, changed: false };
  const qty = Number(kind === 'inventory' ? plannedQuantity(item) : item.qty);
  const cost = Number(kind === 'inventory' ? plannedUnitCost(item) : item.unit_cost);
  return { item, changed: qty !== draft.baseQty || cost !== draft.baseCost };
}

export function reviewedRecordFor(kind, draft, item) {
  return {
    itemId: item.id,
    baseQty: draft.baseQty,
    baseCost: draft.baseCost,
    qty: Number(kind === 'inventory' ? plannedQuantity(item) : item.qty),
    cost: Number(kind === 'inventory' ? plannedUnitCost(item) : item.unit_cost),
  };
}

export function isReviewCurrent(kind, draft, item, review) {
  if (!draft || !item || !review) return false;
  const current = reviewedRecordFor(kind, draft, item);
  return Object.keys(current).every((key) => current[key] === review[key]);
}
