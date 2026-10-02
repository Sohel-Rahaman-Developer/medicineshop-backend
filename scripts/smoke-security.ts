// B0 security checks (SECURITY.md §6): cookie flags, CSRF, Origin, CORS, headers, body limits, strict input.
import { spawnSync } from 'node:child_process';
import { ADMIN_ORIGIN, SHOP_ORIGIN, check, crash, finish, section, startHarness } from './lib/harness';

const attrs = (line: string | undefined) => (line ?? '').split(';').map((s) => s.trim().toLowerCase());
const cookieLine = (lines: string[], name: string) => lines.find((l) => l.startsWith(`${name}=`));

function bootWith(env: Record<string, string>, code: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', '-e', code], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

async function main() {
  const h = await startHarness();
  const email = 'security@medicineshop.test';

  section('1. Cookie flags');
  const web = h.client();
  const csrfRes = await web.get('/auth/csrf');
  const csrfCookie = attrs(cookieLine(csrfRes.setCookies, 'ms_csrf'));
  check('CSRF cookie is HttpOnly', csrfCookie.includes('httponly'));
  check('CSRF cookie SameSite=Lax', csrfCookie.includes('samesite=lax'));
  await h.seedOtp(email, '111111');
  const login = await web.post('/auth/otp/verify', { email, otp: '111111' });
  const at = attrs(cookieLine(login.setCookies, 'ms_at'));
  const rt = attrs(cookieLine(login.setCookies, 'ms_rt'));
  check('access cookie HttpOnly', at.includes('httponly'));
  check('access cookie SameSite=Lax', at.includes('samesite=lax'));
  check('access cookie Path=/api/v1', at.includes('path=/api/v1'));
  check('access cookie has no Domain (host-only)', !at.some((a) => a.startsWith('domain=')));
  check('refresh cookie HttpOnly', rt.includes('httponly'));
  check('refresh cookie Path=/api/v1/auth', rt.includes('path=/api/v1/auth'));
  check('refresh cookie has no Domain', !rt.some((a) => a.startsWith('domain=')));

  const secure = bootWith(
    {
      COOKIE_SECURE: 'true',
      MONGODB_URI: 'mongodb://127.0.0.1:1/none',
    },
    `const { createApp } = require('./src/app.ts');
     const s = createApp().listen(0, async () => {
       const r = await fetch('http://127.0.0.1:' + s.address().port + '/api/v1/auth/csrf');
       console.log(JSON.stringify(r.headers.getSetCookie())); s.close();
     });`,
  );
  check('cookies carry Secure when COOKIE_SECURE=true', /;\s*Secure/i.test(secure.stdout), secure.stderr.slice(0, 200));
  const prod = bootWith({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }, `require('./src/config/env.ts')`);
  check('production refuses to boot without Secure cookies', prod.status !== 0);

  section('2. CSRF');
  const noHeader = await web.raw('POST', '/auth/logout', {});
  check('POST without X-CSRF-Token → 403', noHeader.status === 403, String(noHeader.status));
  check('error code CSRF_INVALID', noHeader.json.error?.code === 'CSRF_INVALID', noHeader.json.error?.code ?? '');
  const wrongHeader = await web.raw('POST', '/auth/logout', {}, { 'x-csrf-token': 'not-the-token' });
  check('wrong token → 403', wrongHeader.status === 403, String(wrongHeader.status));
  const forger = h.client({ csrf: false });
  forger.jar.set('ms_csrf', 'attacker.chosen', '/api/v1');
  const forged = await forger.raw('POST', '/auth/otp/request', { email }, { 'x-csrf-token': 'attacker.chosen' });
  check('unsigned token in cookie + header → 403 (cookie tossing)', forged.status === 403, String(forged.status));
  check('still signed in after the rejected POSTs', (await web.get('/auth/me')).status === 200);

  section('3. Origin');
  const noOrigin = h.client({ origin: null });
  const r1 = await noOrigin.post('/auth/otp/request', { email });
  check('POST with no Origin → 403', r1.status === 403, String(r1.status));
  const evil = h.client({ origin: 'https://evil.example' });
  const r2 = await evil.post('/auth/otp/request', { email });
  check('POST from another origin → 403', r2.status === 403, String(r2.status));
  const admin = h.client({ origin: ADMIN_ORIGIN });
  const r3 = await admin.post('/auth/otp/request', { email: 'admin-origin@test.local' });
  check('admin app origin is allowed', r3.status === 200, String(r3.status));

  section('4. CORS');
  const preflight = (origin: string) =>
    fetch(`${h.base}/auth/otp/request`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-csrf-token' },
    });
  const evilPre = await preflight('https://evil.example');
  check('other origin gets no Access-Control-Allow-Origin', evilPre.headers.get('access-control-allow-origin') === null);
  const shopPre = await preflight(SHOP_ORIGIN);
  check('shop origin is echoed back', shopPre.headers.get('access-control-allow-origin') === SHOP_ORIGIN);
  check('credentials allowed for the shop', shopPre.headers.get('access-control-allow-credentials') === 'true');
  check('X-CSRF-Token is an allowed header', /x-csrf-token/i.test(shopPre.headers.get('access-control-allow-headers') ?? ''));
  check('no wildcard origin anywhere', evilPre.headers.get('access-control-allow-origin') !== '*');
  const get = await fetch(`${h.base}/auth/csrf`, { headers: { origin: SHOP_ORIGIN } });
  check('the app can read a download’s file name (Content-Disposition exposed)', /content-disposition/i.test(get.headers.get('access-control-expose-headers') ?? ''));

  section('5. Security headers');
  const me = await web.get('/auth/me');
  const csp = me.headers.get('content-security-policy') ?? '';
  check("CSP default-src 'none'", csp.includes("default-src 'none'"), csp);
  check("CSP frame-ancestors 'none'", csp.includes("frame-ancestors 'none'"));
  check('X-Content-Type-Options nosniff', me.headers.get('x-content-type-options') === 'nosniff');
  check('Cache-Control no-store on API responses', me.headers.get('cache-control') === 'no-store');
  check('no X-Powered-By', me.headers.get('x-powered-by') === null);
  check('Referrer-Policy set', Boolean(me.headers.get('referrer-policy')));

  section('6. Input');
  const big = await web.post('/auth/otp/request', { email, pad: 'x'.repeat(150_000) });
  check('body over 100 KB → 413', big.status === 413, String(big.status));
  check('413 has the standard error shape', big.json.error?.code === 'PAYLOAD_TOO_LARGE');
  const csrfToken = await web.loadCsrf();
  const broken = await web.raw('POST', '/auth/otp/request', '{"email":', { 'x-csrf-token': csrfToken });
  check('malformed JSON → 400, not 500', broken.status === 400, String(broken.status));
  const extra = await web.post('/auth/otp/request', { email, role: 'admin' });
  check('unknown body key → 422 (mass assignment)', extra.status === 422, String(extra.status));
  const nosql = await web.post('/auth/otp/verify', { email: { $ne: null }, otp: '111111' });
  check('operator object instead of a string → 422', nosql.status === 422, String(nosql.status));

  section('7. Tokens');
  const { default: jwt } = await import('jsonwebtoken');
  const realAt = web.jar.get('ms_at') ?? '';
  const payload = jwt.decode(realAt) as { sub: string; sid: string };
  const noneAlg = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;
  const tamper = h.client();
  tamper.jar.set('ms_at', noneAlg, '/api/v1');
  check('alg=none token → 401', (await tamper.get('/auth/me')).status === 401);
  const otherKey = jwt.sign(payload, 'some-other-secret-0123456789abcdef0123');
  tamper.jar.set('ms_at', otherKey, '/api/v1');
  check('token signed with another key → 401', (await tamper.get('/auth/me')).status === 401);
  check('no response body ever contains a token', !/eyJ[A-Za-z0-9_-]{10,}\./.test(login.text + me.text));

  await h.close();
  finish();
}

main().catch(crash);
