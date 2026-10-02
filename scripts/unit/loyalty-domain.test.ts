import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RULES, earn, expiryOf, nextTier, redeemCap, shareOf, tierFor } from '../../src/modules/loyalty/loyalty.domain';
import { returnShares } from '../../src/modules/loyalty/loyalty.service';

const on = { ...DEFAULT_RULES, enabled: true, configured: true };

void test('PLAN §16 earn: ₹1,250 Gold (1.25×) → 12 base → 15 points; Silver → 12', () => {
  assert.deepEqual(earn(125_000, 'Gold', on), { amount: 125_000, base: 12, mult: 1.25, points: 15 });
  assert.equal(earn(125_000, 'Silver', on).points, 12);
  assert.equal(earn(125_000, '', on).points, 12, 'no tier yet = the first tier');
});

void test('earn: off, under the minimum bill or zero → nothing; 2-decimal multiplier is exact (20 × 1.15 = 23)', () => {
  assert.equal(earn(125_000, 'Gold', DEFAULT_RULES).points, 0);
  assert.equal(earn(40_000, 'Silver', { ...on, minBillForEarning: 50_000 }).points, 0);
  assert.equal(earn(0, 'Silver', on).points, 0);
  const odd = { ...on, tiers: [{ name: 'X', minLifetimePoints: 0, earnMultiplier: 1.15 }] };
  assert.equal(earn(200_000, 'X', odd).points, 23);
});

void test('PLAN §16 redeem: ₹1,250, 340 points, 20 %, ₹1 a point, multiples of 10 → 250 usable', () => {
  assert.deepEqual(redeemCap(125_000, 340, on), { maxValue: 25_000, maxPoints: 250, balance: 340, usable: 250, eligible: true });
  assert.equal(redeemCap(125_000, 99, on).usable, 0, 'under the 100-point minimum');
  assert.equal(redeemCap(125_000, 247, on).usable, 240, 'rounded down to a multiple of 10');
  assert.equal(redeemCap(3000, 500, on).usable, 0, 'a ₹30 bill allows ₹6 = 6 points → 0 in tens');
  assert.equal(redeemCap(125_000, 340, DEFAULT_RULES).eligible, false, 'points off');
  assert.equal(redeemCap(125_000, 340, { ...on, pointValue: 10 }).usable, 340, '₹0.10 a point: 2500 allowed, 340 held');
});

void test('tiers: highest reached; next tier and the gap', () => {
  assert.equal(tierFor(0, on.tiers)?.name, 'Silver');
  assert.equal(tierFor(1000, on.tiers)?.name, 'Gold');
  assert.equal(tierFor(9999, on.tiers)?.name, 'Platinum');
  assert.equal(nextTier(400, on.tiers)?.name, 'Gold');
  assert.equal(nextTier(5000, on.tiers), null);
});

void test('shareOf: cumulative floor; all back moves exactly everything', () => {
  assert.equal(shareOf(15, 1, 3, false), 5);
  assert.equal(shareOf(10, 1, 3, false) + (shareOf(10, 2, 3, false) - shareOf(10, 1, 3, false)) + (shareOf(10, 3, 3, true) - shareOf(10, 2, 3, false)), 10);
});

void test('expiry: 12 months on; 0 = never', () => {
  assert.equal(expiryOf(new Date('2026-10-02T10:00:00Z'), 12)?.toISOString(), '2027-10-02T10:00:00.000Z');
  assert.equal(expiryOf(new Date(), 0), null);
});

const sale = (o: Record<string, unknown> = {}) => ({
  _id: undefined as never,
  billNumber: 'INV-1',
  customerId: undefined,
  customerName: 'Ratna',
  lines: [
    { quantityInBase: 30, returnedQuantity: 0, totalAmount: 60_000 },
    { quantityInBase: 10, returnedQuantity: 0, totalAmount: 40_000, noPoints: true },
  ],
  loyaltyPointsRedeemed: 200,
  loyaltyDiscountAmount: 20_000,
  loyaltyPointsEarned: 8,
  loyaltyPointsReversed: 0,
  loyaltyPointsRestored: 0,
  ...o,
});

void test('return: earned points follow only earning lines; redeemed ones follow the whole bill, never worth more than the refund', () => {
  // Half the earning line back: 8 × 30000/60000 = 4 earned back; 200 × 30000/100000 = 60 redeemed back (₹60 ≤ ₹300).
  assert.deepEqual(returnShares(sale(), new Map([[0, 15]]), 30_000), { reverse: 4, restore: 60, restoreValue: 6000 });
  // The excluded line back: no earned points move, 80 redeemed come back.
  assert.deepEqual(returnShares(sale(), new Map([[1, 10]]), 40_000), { reverse: 0, restore: 80, restoreValue: 8000 });
  // After the first half, the rest of the bill moves exactly the rest.
  const after = sale({ lines: [{ quantityInBase: 30, returnedQuantity: 15, totalAmount: 60_000 }, { quantityInBase: 10, returnedQuantity: 0, totalAmount: 40_000, noPoints: true }], loyaltyPointsReversed: 4, loyaltyPointsRestored: 60 });
  assert.deepEqual(returnShares(after, new Map([[0, 15], [1, 10]]), 70_000), { reverse: 4, restore: 140, restoreValue: 14_000 });
  // A tiny refund can't carry more points than its own value.
  assert.equal(returnShares(sale({ loyaltyPointsRedeemed: 1000, loyaltyDiscountAmount: 100_000 }), new Map([[0, 1]]), 2000).restore, 20);
  // A bill from before B5b has no points fields.
  assert.deepEqual(returnShares(sale({ loyaltyPointsRedeemed: undefined, loyaltyDiscountAmount: undefined, loyaltyPointsEarned: undefined, loyaltyPointsReversed: undefined, loyaltyPointsRestored: undefined }), new Map([[0, 30]]), 60_000), { reverse: 0, restore: 0, restoreValue: 0 });
});
