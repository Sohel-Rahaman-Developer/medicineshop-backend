import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Types } from 'mongoose';
import { sayNotes, translate } from '../../src/core/lang';
import hi from '../../src/content/words/hi.json';

void test('API messages: exact, filled-in, nested pieces; English and unknown text pass through', () => {
  assert.equal(translate('hi', 'Product not found'), 'Product नहीं मिला');
  assert.equal(translate('bn', 'Product not found'), 'Product পাওয়া যায়নি');
  assert.equal(translate('en', 'Product not found'), 'Product not found');
  assert.equal(translate('hi', 'Rack A-2-1 added'), 'Rack A-2-1 जुड़ गया');
  assert.equal(translate('hi', 'Category “Ayurveda” added'), 'Category “Ayurveda” जुड़ गई');
  assert.equal(translate('hi', 'Line 3: Calpol 500 is deactivated'), 'लाइन 3: Calpol 500 बंद किया हुआ है');
  assert.equal(translate('hi', 'Could not read the bill: the AI is busy, try again in a minute. Your 3 tokens are back'), 'बिल नहीं पढ़ा जा सका: AI अभी व्यस्त है, एक मिनट में फिर कोशिश कीजिए। आपके 3 tokens वापस आ गए हैं');
  assert.equal(translate('hi', 'Line 2: Calpol — Expiry is required'), 'लाइन 2: Calpol — Expiry ज़रूरी है');
  assert.equal(translate('hi', 'Paid Ram'), 'Ram को चुका दिया');
  assert.equal(translate('hi', 'Ram Paid saved'), 'Ram Paid सेव हो गए');
  assert.equal(translate('hi', 'constructor'), 'constructor');
  assert.equal(translate('hi', 'Something nobody wrote'), 'Something nobody wrote');
});

void test('every Hindi entry keeps its {placeholders}', () => {
  const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [k, v] of Object.entries(hi)) assert.equal(holes(v), holes(k), k);
});

void test('preview notes translate; ids, dates and other strings stay as they are', () => {
  const id = new Types.ObjectId();
  const at = new Date('2026-10-25T00:00:00Z');
  const out = sayNotes('hi', { rows: [{ id, at, name: 'Product not found', errors: ['Product name is missing'], warnings: [] }], notes: 'Product not found' });
  const [row] = out.rows;
  assert.ok(row);
  assert.equal(row.id, id);
  assert.equal(row.at, at);
  assert.equal(row.name, 'Product not found');
  assert.deepEqual(row.errors, ['Product का नाम नहीं है']);
  assert.equal(out.notes, 'Product not found');
  assert.equal(sayNotes('en', out), out);
});
