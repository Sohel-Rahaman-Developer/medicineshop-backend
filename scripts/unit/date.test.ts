import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayLabel, monthLabel } from '../../src/utils/date';

void test('message dates read in IST: 18:29Z is still the day, 18:30Z is the next', () => {
  assert.equal(dayLabel(new Date('2026-10-16T18:29:00Z')), '16 Oct 2026');
  assert.equal(dayLabel(new Date('2026-10-16T18:30:00Z')), '17 Oct 2026');
  assert.equal(dayLabel(new Date('2026-12-31T18:30:00Z')), '1 Jan 2027');
  assert.equal(monthLabel(new Date('2026-12-31T18:29:00Z')), 'Dec 2026');
  assert.equal(monthLabel(new Date('9999-12-31T00:00:00Z')), 'no expiry');
});
