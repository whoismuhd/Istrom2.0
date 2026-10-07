import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApiDate } from './dates.js';

test('Server timestamps without an offset are treated as UTC', () => {
  assert.equal(parseApiDate('2026-10-02T12:30:00').toISOString(), '2026-10-02T12:30:00.000Z');
});
test('Explicit offsets are preserved and invalid dates remain invalid', () => {
  assert.equal(parseApiDate('2026-10-02T12:30:00+01:00').toISOString(), '2026-10-02T11:30:00.000Z');
  assert.equal(parseApiDate('2026-10-02T12:30:00Z').toISOString(), '2026-10-02T12:30:00.000Z');
  assert.ok(Number.isNaN(parseApiDate('invalid').getTime()));
});
