import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allocate, bucketOf, expiryBucketOf, fefo, mergedCost, NO_EXPIRY, rollup, suggestReorder, type BatchLike } from '../../src/modules/stock/stock.domain';
import { monthEndIST } from '../../src/utils/date';
import { fyOf } from '../../src/utils/fy';

const now = new Date('2026-10-02T06:30:00.000Z');
let n = 0;
const batch = (over: Partial<BatchLike> & { id?: string }): BatchLike => ({
  _id: over.id ?? `b${String(++n)}`,
  quantity: 100,
  status: 'active',
  expiryDate: monthEndIST(2027, 6),
  receivedAt: new Date('2026-01-01T00:00:00Z'),
  costPerBaseUnit: 100,
  mrp: 1500,
  ...over,
});
const ids = (list: BatchLike[]) => list.map((b) => b._id.toString());

void test('expiry is the last second of the month in IST (PLAN §26)', () => {
  assert.equal(monthEndIST(2026, 12).toISOString(), '2026-12-31T18:29:59.000Z');
  assert.equal(monthEndIST(2027, 2).toISOString(), '2027-02-28T18:29:59.000Z');
  assert.equal(fyOf(new Date('2026-03-31T18:29:59Z')), '2025-26');
  assert.equal(fyOf(new Date('2026-03-31T18:30:00Z')), '2026-27');
});

void test('buckets: blocked > expired > sellable, empty and returned count nowhere', () => {
  assert.equal(bucketOf(batch({}), now), 'sellable');
  assert.equal(bucketOf(batch({ expiryDate: monthEndIST(2026, 9) }), now), 'expired');
  assert.equal(bucketOf(batch({ expiryDate: monthEndIST(2026, 9), status: 'blocked' }), now), 'blocked');
  assert.equal(bucketOf(batch({ quantity: 0 }), now), null);
  assert.equal(bucketOf(batch({ status: 'returned' }), now), null);
  assert.equal(bucketOf(batch({ expiryDate: monthEndIST(2026, 10) }), now), 'sellable');
});

void test('PLAN §9 worked example: DL2401 + DL2409 → 52 STRIP, DL2401 sells first', () => {
  const dl2401 = batch({ id: 'DL2401', quantity: 330, expiryDate: monthEndIST(2026, 12), mrp: 3000, costPerBaseUnit: 127, receivedAt: new Date('2026-01-10T00:00:00Z') });
  const dl2409 = batch({ id: 'DL2409', quantity: 450, expiryDate: monthEndIST(2027, 8), mrp: 3350, costPerBaseUnit: 156, receivedAt: new Date('2026-09-10T00:00:00Z') });
  const r = rollup([dl2409, dl2401], { reorderLevel: 300, salePack: 15 }, now);
  assert.equal(r.sellable, 780);
  assert.equal(r.sellable / 15, 52);
  assert.equal(r.mrpValue, 66000 + 100500);
  assert.equal(r.value, 330 * 127 + 450 * 156);
  assert.equal(r.status, 'ok');
  assert.equal(r.nextExpiry?.toISOString(), monthEndIST(2026, 12).toISOString());
  assert.equal(r.validUntil.toISOString(), monthEndIST(2026, 12).toISOString());
  assert.deepEqual(ids(fefo([dl2409, dl2401], now)), ['DL2401', 'DL2409']);

  const one = allocate([dl2409, dl2401], 15, now);
  assert.deepEqual(one.parts.map((p) => [p.batch._id, p.qty]), [['DL2401', 15]]);
  const split = allocate([dl2409, dl2401], 400, now);
  assert.deepEqual(split.parts.map((p) => [p.batch._id, p.qty]), [['DL2401', 330], ['DL2409', 70]]);
  assert.equal(split.short, 0);
  const picked = allocate([dl2409, dl2401], 15, now, 'DL2409');
  assert.deepEqual(picked.parts.map((p) => p.batch._id), ['DL2409']);
  assert.equal(allocate([dl2401], 400, now).short, 70);
});

void test('same expiry: the batch that came in first sells first', () => {
  const late = batch({ id: 'late', receivedAt: new Date('2026-05-01T00:00:00Z') });
  const early = batch({ id: 'early', receivedAt: new Date('2026-02-01T00:00:00Z') });
  assert.deepEqual(ids(fefo([late, early], now)), ['early', 'late']);
});

void test('rollup keeps expired and blocked out of sellable, and status follows reorder level', () => {
  const r = rollup(
    [batch({ quantity: 10 }), batch({ quantity: 40, expiryDate: monthEndIST(2026, 8) }), batch({ quantity: 5, status: 'blocked' })],
    { reorderLevel: 10, salePack: 1 },
    now,
  );
  assert.deepEqual([r.sellable, r.expired, r.blocked, r.onHand, r.batches], [10, 40, 5, 55, 3]);
  assert.equal(r.status, 'low');
  const out = rollup([batch({ quantity: 40, expiryDate: monthEndIST(2026, 8) })], { reorderLevel: 10, salePack: 1 }, now);
  assert.equal(out.status, 'out');
  assert.equal(out.nextExpiry, null);
  assert.equal(out.validUntil.getTime(), NO_EXPIRY.getTime());
});

void test('expiry centre buckets by days left', () => {
  const at = (days: number) => new Date(now.getTime() + days * 86_400_000);
  assert.equal(expiryBucketOf(batch({ expiryDate: at(-1) }), now), 'expired');
  assert.equal(expiryBucketOf(batch({ expiryDate: at(30) }), now), 'd30');
  assert.equal(expiryBucketOf(batch({ expiryDate: at(30.5) }), now), 'd60');
  assert.equal(expiryBucketOf(batch({ expiryDate: at(90) }), now), 'd90');
  assert.equal(expiryBucketOf(batch({ expiryDate: at(91) }), now), 'later');
  assert.equal(expiryBucketOf(batch({ expiryDate: at(-1), status: 'blocked' }), now), null);
});

void test('reorder suggestion and merged landing cost', () => {
  assert.deepEqual(suggestReorder({ reorderQuantity: 450, salePack: 15 }, 100, 0, 30), { need: 350, saleUnits: 24, target: 450, basis: 'reorderQty' });
  assert.deepEqual(suggestReorder({ reorderQuantity: 0, salePack: 15 }, 100, 0, 30), { need: 0, saleUnits: 0, target: 0, basis: 'none' });
  assert.deepEqual(suggestReorder({ reorderQuantity: 0, salePack: 10 }, 50, 7.5, 30), { need: 175, saleUnits: 18, target: 225, basis: 'sales' });
  assert.equal(mergedCost(100, 120, 100, 130), 125);
  assert.equal(mergedCost(0, 0, 50, 140), 140);
});
