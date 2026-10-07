import test from 'node:test';
import assert from 'node:assert/strict';
import { readRecoveryToken } from './recovery.js';

test('Reset links accept a complete token in the URL fragment', () => {
  const token = 'Abcd_123-'.repeat(4) + 'Abcd123';
  assert.equal(token.length, 43);
  assert.equal(readRecoveryToken(`#token=${token}`), token);
});

test('Missing, incomplete and malformed reset links cannot submit a token', () => {
  for (const hash of ['', '#other=value', '#token=short', '#token=' + '!'.repeat(43), '#token=' + 'a'.repeat(44)]) {
    assert.equal(readRecoveryToken(hash), null);
  }
});
