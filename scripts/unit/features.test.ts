import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reportList } from '../../src/modules/reports/catalog';
import { FEATURES, OPEN_REPORTS, REPORTS, featureOfReport, isFeature } from '../../src/modules/subscription/features';

void test('D113: every report-centre report is either lockable on its own, open by law, or P&L', () => {
  const keys = reportList().map((r) => r.key);
  const known = new Set<string>([...REPORTS, ...OPEN_REPORTS, 'pnl', 'daybook']);
  assert.deepEqual(keys.filter((k) => !known.has(k)), [], 'a report with no lock of its own would fall behind P&L');
  assert.deepEqual([...REPORTS, ...OPEN_REPORTS].filter((k) => !keys.includes(k)), [], 'a lock for a report that no longer exists');
});

void test('D113: GST, H1 and X never lock; P&L and the day book follow pnl; the rest lock one by one', () => {
  // The law's list, written out so that dropping one from the code fails here.
  for (const k of ['gst-sales', 'gst-purchase', 'h1', 'x']) assert.equal(featureOfReport(k), null, k);
  assert.equal(featureOfReport('pnl'), 'pnl');
  assert.equal(featureOfReport('daybook'), 'pnl');
  assert.equal(featureOfReport('sales-register'), 'report:sales-register');
  assert.equal(featureOfReport('a-report-nobody-listed'), 'pnl', 'unknown reports fail closed');
});

void test('D113: the feature list has no repeats and knows only its own keys', () => {
  assert.equal(new Set(FEATURES).size, FEATURES.length);
  assert.ok(isFeature('report:expiry') && isFeature('registers') && !isFeature('reports') && !isFeature('report:h1'));
});
