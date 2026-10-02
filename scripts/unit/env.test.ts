import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Loads src/config/env in a fresh process with these variables on top of .env; returns how it went.
function boot(vars: Record<string, string>) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/config/env.ts').then(() => process.stdout.write('BOOTED'))"], {
    env: { ...process.env, ...vars },
    encoding: 'utf8',
  });
  return { booted: r.stdout.includes('BOOTED'), err: r.stderr };
}

void test('DEV_STATIC_OTP: refused in production and test, wrong length refused, fine in development', () => {
  const prod = boot({ NODE_ENV: 'production', COOKIE_SECURE: 'true', DEV_STATIC_OTP: '123456' });
  assert.equal(prod.booted, false);
  assert.match(prod.err, /DEV_STATIC_OTP: is allowed only with NODE_ENV=development/);
  assert.equal(boot({ NODE_ENV: 'test', DEV_STATIC_OTP: '123456' }).booted, false);
  assert.match(boot({ NODE_ENV: 'development', OTP_LENGTH: '6', DEV_STATIC_OTP: '1234' }).err, /DEV_STATIC_OTP: must be OTP_LENGTH digits/);
  assert.equal(boot({ NODE_ENV: 'development', OTP_LENGTH: '6', DEV_STATIC_OTP: '123456' }).booted, true);
  assert.equal(boot({ NODE_ENV: 'production', COOKIE_SECURE: 'true', DEV_STATIC_OTP: '' }).err.includes('DEV_STATIC_OTP'), false);
});
