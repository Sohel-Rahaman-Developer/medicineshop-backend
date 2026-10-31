import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doseOf, perDay, suggestQty } from '../../src/modules/ai/rx-ai';

const strip = { base: 'TABLET', sale: 'STRIP', salePack: 10, allowLooseSale: true };
const sealed = { ...strip, allowLooseSale: false };
const syrup = { base: 'BOTTLE', sale: 'BOTTLE', salePack: 1, allowLooseSale: false };
const none = { freq: '', meal: '', days: '' };

void test('D105: the doctor’s words become the dose box — BD / bid, A.C. / after food, x 5d', () => {
  assert.deepEqual(doseOf({ freq: 'BD', meal: 'PC', days: '5' }), { freq: 'BD', pattern: null, meal: 'PC', days: 5 });
  assert.deepEqual(doseOf({ freq: 'b.i.d', meal: 'A.C.', days: 'x 7d' }), { freq: 'BD', pattern: null, meal: 'AC', days: 7 });
  assert.deepEqual(doseOf({ freq: 'OD HS', meal: 'after food', days: '' }), { freq: 'HS', pattern: null, meal: 'PC', days: null });
  assert.equal(doseOf({ ...none, freq: 'stat' })?.freq, 'STAT');
});

void test('1-0-1 patterns, halves written 1/2 or 0.5; nonsense is dropped, not guessed', () => {
  assert.equal(doseOf({ ...none, freq: '1 - 0 - 1' })?.pattern, '1-0-1');
  assert.equal(doseOf({ ...none, freq: '1/2-0-1/2' })?.pattern, '½-0-½');
  assert.equal(doseOf({ ...none, freq: '0.5-1-1 1/2' })?.pattern, '½-1-1½');
  assert.equal(doseOf({ ...none, freq: 'twice weekly' }), null);
  assert.equal(doseOf({ ...none, days: '400' }), null);
  assert.equal(doseOf(none), null);
});

void test('doses a day: OD 1, BD 2, TDS 3, QDS 4, HS 1, a pattern its sum; SOS and Stat have none', () => {
  assert.deepEqual(['OD', 'BD', 'TDS', 'QDS', 'HS', 'SOS', 'STAT'].map((f) => perDay(doseOf({ ...none, freq: f }))), [1, 2, 3, 4, 1, null, null]);
  assert.equal(perDay(doseOf({ ...none, freq: '1-½-1' })), 2.5);
  assert.equal(perDay(null), null);
});

void test('quantity with its working: BD × 5 days = 10 tablets; sealed strips round up; a syrup is one bottle', () => {
  assert.deepEqual(suggestQty(strip, doseOf({ freq: 'BD', meal: '', days: '5' }), '', 100), { qtyBase: 10, why: 'BD = 2 a day × 5 days = 10 tablets' });
  assert.deepEqual(suggestQty(sealed, doseOf({ freq: 'TDS', meal: '', days: '5' }), '', 100), { qtyBase: 20, why: 'TDS = 3 a day × 5 days = 15 tablets → 2 strips' });
  assert.deepEqual(suggestQty(strip, doseOf({ freq: '1-0-½', meal: '', days: '3' }), '', 100), { qtyBase: 5, why: '1-0-½ = 1.5 a day × 3 days = 5 tablets' });
  assert.deepEqual(suggestQty(syrup, doseOf({ freq: 'TDS', meal: '', days: '5' }), '', 9), { qtyBase: 1, why: '1 bottle' });
});

void test('no days: the written total, else one strip; never more than the shelf has', () => {
  assert.deepEqual(suggestQty(strip, null, '6', 100), { qtyBase: 6, why: '6 tablets written on the prescription' });
  assert.deepEqual(suggestQty(strip, doseOf({ ...none, freq: 'SOS' }), '', 100), { qtyBase: 10, why: '1 strip — no days on the prescription' });
  assert.deepEqual(suggestQty(strip, doseOf({ freq: 'QDS', meal: '', days: '10' }), '', 25), { qtyBase: 25, why: 'QDS = 4 a day × 10 days = 40 tablets · only 25 tablets in stock' });
  assert.deepEqual(suggestQty(sealed, doseOf({ freq: 'QDS', meal: '', days: '10' }), '', 25), { qtyBase: 20, why: 'QDS = 4 a day × 10 days = 40 tablets · only 25 tablets in stock' });
});
