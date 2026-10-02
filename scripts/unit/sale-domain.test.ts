import assert from 'node:assert/strict';
import { test } from 'node:test';
import { floorOf, hsnSummary, packLabel, priceSale, returnShare, splitLine, type Part } from '../../src/modules/sales/sale.domain';
import { distribute, gstInclusive } from '../../src/utils/money';

const part = (o: Partial<Part>): Part => ({ mrp: 3000, qtyBase: 15, salePack: 15, gstRate: 12, sell: null, discount: null, ...o });
const opts = { roundOff: true, igst: false };

void test('PLAN §14 bill: Dolo 2 × 30 + Augmentin 92 → taxable 135.71, CGST 8.15, SGST 8.14, total 152', () => {
  const p = priceSale([part({ qtyBase: 30 }), part({ mrp: 9200, qtyBase: 10, salePack: 10 })], null, opts);
  assert.deepEqual(p.lines.map((l) => [l.amount, l.taxable, l.tax, l.cgst, l.sgst]), [[6000, 5357, 643, 322, 321], [9200, 8214, 986, 493, 493]]);
  assert.deepEqual([p.taxable, p.totalTax, p.cgst, p.sgst, p.grandTotal, p.roundOff], [13_571, 1629, 815, 814, 15_200, 0]);
});

void test('gstInclusive: the leftover paisa goes to CGST; 0 % has no tax', () => {
  assert.deepEqual(gstInclusive(3000, 12), { amount: 3000, rate: 12, taxable: 2679, tax: 321, sgst: 160, cgst: 161 });
  assert.equal(gstInclusive(5000, 0).tax, 0);
});

void test('loose sale: 4 tablets of a ₹30 strip of 15 → ₹8', () => {
  assert.equal(priceSale([part({ qtyBase: 4 })], null, opts).lines[0]?.gross, 800);
});

void test('bill discount is spread over lines exactly and never above the bill', () => {
  const p = priceSale([part({ qtyBase: 30 }), part({ mrp: 9200, qtyBase: 10, salePack: 10 })], { type: 'flat', value: 1000 }, opts);
  assert.equal(p.lines.reduce((s, l) => s + l.billShare, 0), 1000);
  assert.equal(p.totalDiscount, 1000);
  const all = priceSale([part({})], { type: 'pct', value: 150 }, opts);
  assert.equal(all.grandTotal, 0);
});

void test('line % discount and flat discount capped at the line', () => {
  const p = priceSale([part({ discount: { type: 'pct', value: 10 } }), part({ discount: { type: 'flat', value: 99_999 } })], null, opts);
  assert.deepEqual(p.lines.map((l) => l.lineDiscount), [300, 3000]);
  assert.equal(p.discountPercent, 55);
});

void test('D56 typed price: under MRP is a discount, over MRP is the above-MRP amount', () => {
  const under = priceSale([part({ sell: 2500 })], null, opts);
  assert.deepEqual([under.lineDiscount, under.aboveMrp, under.grandTotal], [500, 0, 2500]);
  const over = priceSale([part({ sell: 3550 })], null, opts);
  assert.deepEqual([over.lineDiscount, over.aboveMrp, over.preRound, over.grandTotal, over.roundOff], [0, 550, 3550, 3600, 50]);
  assert.equal(over.lines[0]?.taxable, 3170);
});

void test('splitLine: a typed price splits by MRP value; a flat discount by gross; a % on each part', () => {
  const parts = [{ mrp: 3000, qtyBase: 330 }, { mrp: 3350, qtyBase: 120 }];
  const typed = splitLine(parts, 15, 90_000, null);
  assert.equal(typed.reduce((s, x) => s + (x.sell ?? 0), 0), 90_000);
  assert.ok(typed.every((x) => x.discount === null));
  const flat = splitLine(parts, 15, null, { type: 'flat', value: 1000 });
  assert.equal(flat.reduce((s, x) => s + (x.discount?.value ?? 0), 0), 1000);
  const pct = splitLine(parts, 15, null, { type: 'pct', value: 5 });
  assert.deepEqual(pct.map((x) => x.discount), [{ type: 'pct', value: 5 }, { type: 'pct', value: 5 }]);
});

void test('IGST sale puts all tax in IGST', () => {
  const p = priceSale([part({})], null, { roundOff: false, igst: true });
  assert.deepEqual([p.cgst, p.sgst, p.igst], [0, 0, 321]);
});

void test('no round off keeps paise', () => {
  const p = priceSale([part({ sell: 2555 })], null, { roundOff: false, igst: false });
  assert.deepEqual([p.grandTotal, p.roundOff], [2555, 0]);
});

void test('distribute always adds up; hsnSummary sums lines; floorOf per sale unit', () => {
  assert.deepEqual(distribute(10, [1, 1, 1]), [4, 3, 3]);
  assert.deepEqual(distribute(0, [5, 5]), [0, 0]);
  const s = hsnSummary([
    { hsn: '3004', gstRate: 12, taxableAmount: 100, cgst: 6, sgst: 6, igst: 0 },
    { hsn: '3004', gstRate: 12, taxableAmount: 50, cgst: 3, sgst: 3, igst: 0 },
  ]);
  assert.deepEqual(s, [{ hsn: '3004', rate: 12, taxable: 150, cgst: 9, sgst: 9, igst: 0 }]);
  assert.equal(floorOf(2500, 30, 15), 5000);
  assert.equal(floorOf(null, 30, 15), null);
});

void test('returnShare: one by one adds up to the line exactly, tax included (PLAN §15)', () => {
  const l = { quantityInBase: 5, totalAmount: 1117, cgst: 60, sgst: 59, igst: 0 };
  const parts = [0, 1, 2, 3, 4].map((done) => returnShare(l, done, 1));
  assert.deepEqual(parts.map((p) => p.amount), [223, 224, 223, 224, 223]);
  assert.equal(parts.reduce((s, p) => s + p.amount, 0), 1117);
  assert.equal(parts.reduce((s, p) => s + p.cgst, 0), 60);
  assert.equal(parts.reduce((s, p) => s + p.taxable, 0), 1117 - 119);
  assert.deepEqual(returnShare(l, 0, 5), { amount: 1117, cgst: 60, sgst: 59, igst: 0, tax: 119, taxable: 998 });
  assert.equal(packLabel(23, 15, 'STRIP', 'TABLET'), '1 STRIP + 8 TABLET');
  assert.equal(packLabel(3, 1, 'PIECE', 'PIECE'), '3 PIECE');
});
