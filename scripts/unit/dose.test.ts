import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DOSE_PATTERN, doseText } from '../../src/modules/sales/sale.dose';

void test('D106 English: how often · food · days, in the order a doctor writes them', () => {
  assert.equal(doseText({ freq: 'BD', meal: 'PC', days: 5 }, 'en'), 'How to take: Twice a day · After food · for 5 days');
  assert.equal(doseText({ freq: 'SOS' }, 'en'), 'How to take: Only when needed');
  assert.equal(doseText({ days: 1 }, 'en'), 'How to take: for 1 day');
});

void test('1-0-1 names only the times with a dose; ½ stays ½ in English', () => {
  assert.equal(doseText({ pattern: '1-0-1', meal: 'AC' }, 'en'), 'How to take: Morning 1, Night 1 · Before food');
  assert.equal(doseText({ pattern: '½-1½-0' }, 'en'), 'How to take: Morning ½, Afternoon 1½');
  assert.equal(doseText({ pattern: '0-0-0' }, 'en'), '');
});

void test('Hindi and Bengali: the same choices in the customer’s words; ½ is written 1/2 (the fonts have no ½)', () => {
  assert.equal(doseText({ freq: 'TDS', meal: 'PC', days: 7 }, 'hi'), 'कैसे लें: दिन में तीन बार · खाने के बाद · 7 दिन तक');
  assert.equal(doseText({ freq: 'HS' }, 'bn'), 'কীভাবে নেবেন: রাতে শোয়ার আগে একবার');
  assert.equal(doseText({ pattern: '½-0-1½', meal: 'AC' }, 'bn'), 'কীভাবে নেবেন: সকাল 1/2, রাত 1 1/2 · খাবার আগে');
});

void test('nothing chosen prints nothing', () => {
  assert.equal(doseText({}, 'hi'), '');
  assert.equal(doseText({ freq: null, pattern: null, meal: null, days: null }, 'bn'), '');
});

void test('patterns: three times of day, 0 to 3 with halves', () => {
  for (const ok of ['1-0-1', '0-0-1', '½-½-½', '1½-0-3']) assert.ok(DOSE_PATTERN.test(ok), ok);
  for (const bad of ['1-1', '1-0-1-1', '4-0-0', '1/2-0-0', ' 1-0-1', 'a-b-c']) assert.ok(!DOSE_PATTERN.test(bad), bad);
});
