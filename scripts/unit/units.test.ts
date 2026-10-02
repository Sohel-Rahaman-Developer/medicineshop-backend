import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amountFor, inr, rhu } from '../../src/utils/money';
import { fromBase, saleUnits, toBase, toUnits, unitsProblem, type UnitsInput } from '../../src/utils/units';

const dolo: UnitsInput = { type: 'COUNT', base: 'TABLET', sale: 'STRIP', salePack: 15, purchase: 'BOX', purchasePack: 10, allowLooseSale: true };

void test('PLAN §10: Dolo strip of 15, box of 10 strips', () => {
  const u = toUnits(dolo);
  assert.deepEqual(u.conversions, { TABLET: 1, STRIP: 15, BOX: 150 });
  assert.equal(toBase(2, 'STRIP', u) + 3, 33);
  assert.equal(fromBase(326, u), '21 STRIP + 11 TABLET');
  assert.equal(fromBase(330, u), '22 STRIP');
  assert.equal(fromBase(4, u), '4 TABLET');
  assert.equal(fromBase(0, u), '0 STRIP');
  assert.equal(fromBase(-16, u), '−1 STRIP + 1 TABLET');
  assert.equal(saleUnits(326, u), 21);
});

void test('sealed syrup sold as whole bottles', () => {
  const u = toUnits({ type: 'COUNT', base: 'BOTTLE', sale: 'BOTTLE', salePack: 1, purchase: 'BOX', purchasePack: 24, allowLooseSale: false });
  assert.deepEqual(u.conversions, { BOTTLE: 1, BOX: 24 });
  assert.equal(fromBase(30, u), '30 BOTTLE');
});

void test('unit setups that make no sense are refused', () => {
  assert.equal(unitsProblem(dolo), null);
  assert.match(unitsProblem({ ...dolo, base: 'ML' }) ?? '', /count units only/);
  assert.match(unitsProblem({ ...dolo, salePack: 1 }) ?? '', /at least 2/);
  assert.match(unitsProblem({ ...dolo, sale: 'TABLET', salePack: 15 }) ?? '', /same unit/);
  assert.match(unitsProblem({ ...dolo, purchase: 'TABLET' }) ?? '', /smaller than the sale unit/);
  assert.match(unitsProblem({ ...dolo, purchase: 'STRIP', purchasePack: 10 }) ?? '', /same unit/);
  assert.equal(unitsProblem({ type: 'WEIGHT', base: 'GM', sale: 'GM', salePack: 1, purchase: 'KG', purchasePack: 1000, allowLooseSale: true }), null);
});

void test('paise rounding is half up and integer only', () => {
  assert.equal(rhu(5, 2), 3);
  assert.equal(rhu(-5, 2), -3);
  assert.equal(rhu(7, 3), 2);
  assert.equal(amountFor(3000, 4, 15), 800);
  assert.equal(amountFor(3350, 1, 15), 223);
  assert.equal(amountFor(3350, 450, 15), 100500);
  assert.equal(inr(15200050), '₹1,52,000.50');
});
