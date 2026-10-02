import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyCredit, paymentStatusOf, purchaseLine, purchaseTotals } from '../../src/modules/purchases/purchase.domain';
import { gstExclusive, roundRupee } from '../../src/utils/money';

void test('PLAN §13 invoice: 2,062 − 68 = 1,994 + GST 239.28 → 2,233 with −0.28 round off', () => {
  const dolo = purchaseLine({ quantity: 30, freeQuantity: 2, rate: 2340, discountPercent: 0, gstRate: 12, conv: 15 });
  const amox = purchaseLine({ quantity: 20, freeQuantity: 0, rate: 6800, discountPercent: 5, gstRate: 12, conv: 10 });
  assert.equal(dolo.taxable, 70_200);
  assert.deepEqual([dolo.cgst, dolo.sgst], [4212, 4212]);
  assert.deepEqual([amox.gross, amox.discount, amox.taxable], [136_000, 6800, 129_200]);
  assert.deepEqual([amox.cgst, amox.sgst], [7752, 7752]);
  const t = purchaseTotals([dolo, amox]);
  assert.deepEqual(t, { subtotal: 206_200, discount: 6800, taxable: 199_400, cgst: 11_964, sgst: 11_964, roundOff: -28, grandTotal: 223_300 });
});

void test('PLAN §13 landing cost: 20 STRIP + 2 free at ₹21, 5 % off → ₹18.14 a strip, 121 paise a tablet', () => {
  const l = purchaseLine({ quantity: 20, freeQuantity: 2, rate: 2100, discountPercent: 5, gstRate: 12, conv: 15 });
  assert.equal(l.taxable, 39_900);
  assert.equal(l.landingPerUnit, 1814);
  assert.equal(l.costPerBaseUnit, 121);
  assert.equal(l.baseQty, 330);
  assert.equal(l.freeBase, 30);
});

void test('a box bought in BOX: rate per box, stock in tablets', () => {
  const l = purchaseLine({ quantity: 2, freeQuantity: 0, rate: 22_500, discountPercent: 0, gstRate: 12, conv: 150 });
  assert.equal(l.baseQty, 300);
  assert.equal(l.costPerBaseUnit, 150);
});

void test('fractional discount and GST split rounding', () => {
  const l = purchaseLine({ quantity: 3, freeQuantity: 0, rate: 3333, discountPercent: 7.5, gstRate: 5, conv: 1 });
  assert.equal(l.gross, 9999);
  assert.equal(l.discount, 750);
  assert.equal(l.taxable, 9249);
  assert.equal(l.tax, 462);
  const odd = gstExclusive(101, 18);
  assert.deepEqual([odd.tax, odd.sgst, odd.cgst], [18, 9, 9]);
  const g = gstExclusive(1050, 5);
  assert.deepEqual([g.tax, g.sgst, g.cgst], [53, 26, 27]);
  assert.deepEqual(roundRupee(10_050), { total: 10_100, roundOff: 50 });
  assert.deepEqual(roundRupee(10_049), { total: 10_000, roundOff: -49 });
});

void test('credit goes to the linked invoice first, then the oldest; the rest is advance', () => {
  const d = (s: string) => new Date(s);
  const open = [
    { id: 'b', dueAmount: 500, invoiceDate: d('2026-09-10') },
    { id: 'a', dueAmount: 300, invoiceDate: d('2026-09-01') },
    { id: 'c', dueAmount: 200, invoiceDate: d('2026-09-20') },
  ];
  assert.deepEqual(applyCredit(open, 600), { applied: [{ id: 'a', amount: 300 }, { id: 'b', amount: 300 }], left: 0 });
  assert.deepEqual(applyCredit(open, 250, 'c'), { applied: [{ id: 'c', amount: 200 }, { id: 'a', amount: 50 }], left: 0 });
  assert.deepEqual(applyCredit(open, 1100), { applied: [{ id: 'a', amount: 300 }, { id: 'b', amount: 500 }, { id: 'c', amount: 200 }], left: 100 });
  assert.deepEqual(applyCredit([], 100), { applied: [], left: 100 });
  assert.equal(paymentStatusOf(1000, 0), 'paid');
  assert.equal(paymentStatusOf(1000, 400), 'partial');
  assert.equal(paymentStatusOf(1000, 1000), 'unpaid');
});
