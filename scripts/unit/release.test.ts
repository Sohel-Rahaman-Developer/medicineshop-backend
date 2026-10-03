import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CHANGELOG } from '../../src/modules/release/changelog';

const parts = (v: string) => v.split('.').map(Number);
const newer = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

void test('changelog: the top entry is the package version, newest first, every entry well formed', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  assert.equal(CHANGELOG[0]?.version, pkg.version, 'bump package.json and add a changelog entry together');
  for (const [i, n] of CHANGELOG.entries()) {
    assert.match(n.version, /^\d+\.\d+\.\d+$/);
    assert.match(n.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(n.title.trim() && n.shop.length + n.admin.length + n.api.length > 0, `${n.version} says nothing`);
    const next = CHANGELOG[i + 1];
    if (next) {
      assert.ok(newer(n.version, next.version), `${n.version} must be newer than ${next.version}`);
      assert.ok(n.date >= next.date, `${n.version} dated before ${next.version}`);
    }
  }
});
