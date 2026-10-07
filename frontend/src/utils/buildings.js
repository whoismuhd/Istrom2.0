export const BUILDING_SUBTYPE_OPTIONS = {
  Flats: Array.from({ length: 13 }, (_, i) => `B${i + 1}`),
  Terraces: ['A (T1-T6)', 'B (T7-T12)', 'C (T13-T18)', 'D (T19-T24)', 'E (T25-T30)', 'F (T31-T36)', 'G (T37-T42)', 'H (T43-T48)', 'I (T49-T53)', 'J (T54-T58)', 'K (T59-T64)', 'L (T65-T70)', 'M (T71-T76)', 'N (T77-T82)', 'O (T83-T88)', 'P (T89-T94)', 'Q (T95-T100)', 'R (T101-T106)', 'S (T107-T112)', 'T (T113-T118)', 'U (T119-T124)', 'V (T125-T130)', 'W (T131-T136)', 'X (T137-T142)'],
  'Semi-detached': Array.from({ length: 29 }, (_, i) => `SD ${i + 1}`),
  'Fully-detached': Array.from({ length: 52 }, (_, i) => `D${i + 1}`),
};

export function requestBuildingType(item, filter) {
  return item?.building_type || filter;
}

export function actualBuildingSubtypes(buildingType, items, actuals) {
  const itemIds = new Set(items.filter((item) => item.building_type === buildingType).map((item) => item.id));
  return [...new Set([
    ...(BUILDING_SUBTYPE_OPTIONS[buildingType] || []),
    ...actuals.filter((record) => itemIds.has(record.item_id)).map((record) => record.building_subtype).filter(Boolean),
  ])];
}
