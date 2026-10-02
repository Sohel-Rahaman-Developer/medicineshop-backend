import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gstExclusive, gstInclusive, rhu } from '../../src/utils/money';

void test('D62: whole rates give exactly the old results (amount × 100 ÷ (100 + rate))', () => {
  for (const rate of [0, 5, 12, 18, 28, 40]) {
    for (let amount = 1; amount < 50_000; amount += 37) {
      const old = rate ? rhu(amount * 100, 100 + rate) : amount;
      assert.equal(gstInclusive(amount, rate).taxable, old, `${String(amount)} @ ${String(rate)}`);
      assert.equal(gstExclusive(amount, rate).tax, rhu(amount * rate, 100), `${String(amount)} @ ${String(rate)}`);
    }
  }
});

void test('D62: decimal rates stay exact — ₹100 at 2.5% → 97.56 + 2.44; ₹1,000 before 7.5% → 75.00', () => {
  assert.deepEqual(gstInclusive(10_000, 2.5), { amount: 10_000, rate: 2.5, taxable: 9756, tax: 244, sgst: 122, cgst: 122 });
  assert.equal(gstExclusive(100_000, 7.5).tax, 7500);
  assert.equal(gstInclusive(10_000, 0.25).taxable, 9975);
  assert.equal(gstExclusive(100_000, 0.1).tax, 100);
});
