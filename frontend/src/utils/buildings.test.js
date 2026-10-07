import test from 'node:test';
import assert from 'node:assert/strict';
import { actualBuildingSubtypes, requestBuildingType, BUILDING_SUBTYPE_OPTIONS } from './buildings.js';

test('An All-buildings request still requires the selected item building subtype', () => {
  const type = requestBuildingType({ building_type: 'Flats' }, '');
  assert.equal(type, 'Flats');
  assert.ok(BUILDING_SUBTYPE_OPTIONS[type].includes('B1'));
  assert.equal(requestBuildingType({ building_type: 'Terraces' }, 'Flats'), 'Terraces');
});

test('Actuals includes recorded custom building labels only for matching inventory', () => {
  const options = actualBuildingSubtypes('Flats', [{ id: 1, building_type: 'Flats' }, { id: 2, building_type: 'Terraces' }], [
    { item_id: 1, building_subtype: '1F' }, { item_id: 1, building_subtype: '1F' },
    { item_id: 2, building_subtype: 'Custom terrace' }, { item_id: 3, building_subtype: 'Other site' },
  ]);
  assert.ok(options.includes('1F'));
  assert.equal(options.filter((label) => label === '1F').length, 1);
  assert.ok(!options.includes('Custom terrace') && !options.includes('Other site'));
});
