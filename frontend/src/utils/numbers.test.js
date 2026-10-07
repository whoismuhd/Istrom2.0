import test from 'node:test';
import assert from 'node:assert/strict';
import { sumDecimals, decimalDifference, decimalProduct, roundMoney } from './numbers.js';

test('Decimal calculations handle repeated quantities, signed balances and scientific notation', () => {
  assert.equal(sumDecimals(Array.from({ length: 100 }, () => 0.01)), 1);
  assert.equal(decimalDifference(0.3, 0.1), 0.2);
  assert.equal(decimalDifference(-0.2, 0.1), -0.3);
  assert.equal(decimalProduct(1e-7, 1e7), 1);
  assert.equal(sumDecimals([1e20, -1e20, 0.01]), 0.01);
  assert.equal(sumDecimals([]), 0);
});

test('Budget rounding preserves a real kobo and rounds like displayed currency', () => {
  assert.equal(roundMoney(10000.005), 10000.01);
  assert.equal(roundMoney(-10000.005), -10000.01);
  assert.equal(roundMoney(0.004), 0);
  assert.equal(roundMoney(1e100), 1e100);
  assert.equal(roundMoney(0), 0);
});
