import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepUntil } from '../../src/modules/retention/retention';

const ist = (d: Date) => new Date(d.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 19);

void test('PLAN §36.3 legal minimum: FY 2019-20 → annual return due 31 Dec 2020 + 72 months → kept to the end of 31 Dec 2026', () => {
  assert.equal(ist(keepUntil('2019-20', 'legal')), '2026-12-31T23:59:59');
  assert.equal(ist(keepUntil('2026-27', 'legal')), '2033-12-31T23:59:59');
});

void test('10-year tier: FY 2019-20 ends 31 Mar 2020 → kept to 31 Mar 2030', () => {
  assert.equal(ist(keepUntil('2019-20', 'y10')), '2030-03-31T23:59:59');
});
