/**
 * Auth smoke test — runs the whole email-OTP flow against an in-memory
 * MongoDB. No Atlas or local mongod needed.
 *
 *   npm run smoke:auth
 *
 * This matters more than most tests because refresh-token rotation and reuse
 * detection are hard to exercise by hand, and getting them wrong opens a
 * security hole.
 *
 * We do not read the OTP out of the logs (pino writes from a worker thread,
 * and log scraping makes for a brittle test anyway). Instead we seed a known
 * OTP into the database to test verification, and separately assert that
 * /otp/request really does create a token.
 */
process.env.MONGOMS_LAUNCH_TIMEOUT ??= '120000';

let pass = 0;
let fail = 0;
const out = (s: string) => process.stdout.write(s);

function check(label: string, ok: boolean, extra = '') {
  if (ok) {
    pass++;
    out(`  ✅ ${label}\n`);
  } else {
    fail++;
    out(`  ❌ ${label} ${extra}\n`);
  }
}

async function main() {
  out('\n⏳ Starting in-memory MongoDB…\n');

  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });

  // Must be set BEFORE env.ts is imported — it reads process.env at boot.
  process.env.MONGODB_URI = rs.getUri('medicineshop_smoke');
  process.env.NODE_ENV = 'development';
  process.env.LOG_LEVEL = 'error';

  const { connectDb, disconnectDb, supportsTransactions } = await import('../src/config/db');
  const { createApp } = await import('../src/app');
  const { OtpTokenModel } = await import('../src/modules/auth/models/otp-token.model');
  const { SessionModel } = await import('../src/modules/auth/models/session.model');
  const { hashOtp } = await import('../src/utils/crypto');

  await connectDb();
  out(`\n🔌 DB connected · transactions supported: ${supportsTransactions()}\n\n`);

  const app = createApp();
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/api/v1`;

  type Res = {
    status: number;
    json: {
      data?: Record<string, unknown>;
      message?: string;
      error?: { code: string; message?: string };
    };
  };

  const call = async (method: string, path: string, body?: unknown, token?: string): Promise<Res> => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Res['json'] };
  };
  const post = (p: string, b?: unknown, t?: string) => call('POST', p, b, t);
  const get = (p: string, t?: string) => call('GET', p, undefined, t);

  const email = 'sohel@medicineshop.test';

  /** Seed a known OTP, exactly as /otp/request would, but with a value we know. */
  const seedOtp = async (code: string) => {
    await OtpTokenModel.updateMany({ email, consumedAt: null }, { $set: { consumedAt: new Date() } });
    await OtpTokenModel.create({
      email,
      otpHash: await hashOtp(code),
      purpose: 'login',
      maxAttempts: 5,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
  };

  /* ── 1. Requesting an OTP really creates one ────────────────────── */
  out('1. OTP request\n');
  const reqRes = await post('/auth/otp/request', { email });
  check('returned 200', reqRes.status === 200, String(reqRes.status));
  check('token created in the database', (await OtpTokenModel.countDocuments({ email, consumedAt: null })) === 1);

  const stored = await OtpTokenModel.findOne({ email, consumedAt: null }).lean();
  check('OTP stored hashed, not in plain text', Boolean(stored?.otpHash?.startsWith('$2')));

  // An unknown address gets exactly the same response — no email enumeration.
  const unknown = await post('/auth/otp/request', { email: 'nobody@nowhere.test' });
  check('unknown email gets the same 200 (enumeration safe)', unknown.status === 200);

  /* ── 2. Wrong OTP ───────────────────────────────────────────────── */
  out('\n2. Wrong OTP\n');
  await seedOtp('123456');
  const wrong = await post('/auth/otp/verify', { email, otp: '999999', client: 'native' });
  check('rejected with 401', wrong.status === 401, String(wrong.status));
  const afterWrong = await OtpTokenModel.findOne({ email, consumedAt: null }).lean();
  check('attempts counter incremented', afterWrong?.attempts === 1, String(afterWrong?.attempts));

  /* ── 3. Correct OTP → login ─────────────────────────────────────── */
  out('\n3. Login with the correct OTP\n');
  const login = await post('/auth/otp/verify', { email, otp: '123456', rememberMe: true, client: 'native' });
  const d = login.json.data as { accessToken: string; refreshToken: string; isNewUser: boolean };

  check('returned 200', login.status === 200, String(login.status));
  check('access token issued', Boolean(d?.accessToken));
  check('refresh token issued (native client)', Boolean(d?.refreshToken));
  check('detected as a new user', d?.isNewUser === true);

  const sessionRow = await SessionModel.findOne({}).lean();
  check('refresh token stored hashed, not in plain text', sessionRow?.tokenHash !== d?.refreshToken);

  /* ── 4. OTP replay ──────────────────────────────────────────────── */
  out('\n4. OTP replay\n');
  const replay = await post('/auth/otp/verify', { email, otp: '123456', client: 'native' });
  check('an already consumed OTP is rejected', replay.status === 401, String(replay.status));

  /* ── 5. Protected route ─────────────────────────────────────────── */
  out('\n5. Protected route\n');
  check('/me works with a valid token', (await get('/auth/me', d.accessToken)).status === 200);
  check('401 without a token', (await get('/auth/me')).status === 401);
  check('401 with a bad token', (await get('/auth/me', 'garbage.token.here')).status === 401);

  /* ── 6. Refresh and rotation ────────────────────────────────────── */
  out('\n6. Refresh and rotation\n');
  const r1 = await post('/auth/refresh', { refreshToken: d.refreshToken, client: 'native' });
  const r1d = r1.json.data as { accessToken: string; refreshToken: string };

  check('refresh returned 200', r1.status === 200, String(r1.status));
  check('a new access token was issued', Boolean(r1d?.accessToken));
  check('rotation happened (refresh token changed)', Boolean(r1d?.refreshToken) && r1d.refreshToken !== d.refreshToken);

  /* ── 7. 🚨 Reuse detection ──────────────────────────────────────── */
  out('\n7. Reuse detection (the important one)\n');
  const reuse = await post('/auth/refresh', { refreshToken: d.refreshToken, client: 'native' });
  check('the old refresh token is rejected', reuse.status === 401, String(reuse.status));

  // After reuse the whole family must be dead — even the newly issued token.
  const afterReuse = await post('/auth/refresh', { refreshToken: r1d.refreshToken, client: 'native' });
  check('the entire family was revoked', afterReuse.status === 401, String(afterReuse.status));

  const revoked = await SessionModel.countDocuments({ revokedReason: 'reuse_detected' });
  check('marked as reuse_detected in the database', revoked > 0, String(revoked));

  /* ── 8. Sessions and logout ─────────────────────────────────────── */
  out('\n8. Sessions and logout\n');
  await seedOtp('654321');
  const login2 = await post('/auth/otp/verify', { email, otp: '654321', client: 'native' });
  const d2 = login2.json.data as { accessToken: string; refreshToken: string; isNewUser: boolean };
  check('second login works', login2.status === 200, String(login2.status));
  check('isNewUser is false now', d2?.isNewUser === false);

  const sess = await get('/auth/sessions', d2.accessToken);
  const list = sess.json.data as unknown as { current: boolean }[];
  check('session list returned', sess.status === 200 && Array.isArray(list));
  check('the current device is flagged', list?.some((s) => s.current === true));

  check('logout returned 200', (await post('/auth/logout', { refreshToken: d2.refreshToken })).status === 200);
  const afterLogout = await post('/auth/refresh', { refreshToken: d2.refreshToken, client: 'native' });
  check('refresh is rejected after logout', afterLogout.status === 401, String(afterLogout.status));

  /* ── 9. Validation ──────────────────────────────────────────────── */
  out('\n9. Validation\n');
  const badEmail = await post('/auth/otp/request', { email: 'not-an-email' });
  check('422 for an invalid email', badEmail.status === 422, String(badEmail.status));
  check('error code is correct', badEmail.json.error?.code === 'VALIDATION_ERROR', badEmail.json.error?.code ?? '');

  /* ── 10. Rate limits are per key, never global ──────────────────── */
  out('\n10. Rate limiting isolation\n');

  const victim = 'ratelimit-victim@test.local';
  const bystander = 'ratelimit-bystander@test.local';

  // Deliberately drive `victim` past the limit (RATE_OTP_REQUEST_PER_EMAIL = 3)
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) {
    codes.push((await post('/auth/otp/request', { email: victim })).status);
  }
  check('429 once the limit is hit', codes.includes(429), codes.join(','));

  // ⚠️ The real question: is anybody else locked out now?
  const other = await post('/auth/otp/request', { email: bystander });
  check('a different user still works (the limit is not global)', other.status === 200, String(other.status));

  // And the original user too — their bucket is separate from the victim's.
  const original = await post('/auth/otp/request', { email });
  check('the first user is unaffected', original.status === 200, String(original.status));

  /* ── 11. Every message comes from the backend ───────────────────── */
  out('\n11. Backend-driven messages\n');

  // Every MUTATION must carry its own message so the frontend hardcodes none.
  const okMsg = await post('/auth/otp/request', { email: 'msgtest@test.local' });
  check('success response carries a message', Boolean(okMsg.json.message), JSON.stringify(okMsg.json.message));

  await seedOtp('222222');
  const loginMsg = await post('/auth/otp/verify', { email, otp: '222222', client: 'native' });
  check('login response carries a message', Boolean(loginMsg.json.message), String(loginMsg.json.message));

  // Every FAILURE must carry one too — 401, 422 and 404 alike.
  const errAuth = await post('/auth/otp/verify', { email, otp: '000000', client: 'native' });
  check('401 carries error.message', Boolean(errAuth.json.error?.message), String(errAuth.json.error?.message));

  const errVal = await post('/auth/otp/request', { email: 'bad' });
  check('422 carries error.message', Boolean(errVal.json.error?.message), String(errVal.json.error?.message));

  const err404 = await get('/auth/no-such-route');
  check('404 carries error.message', Boolean(err404.json.error?.message), String(err404.json.error?.message));

  // Errors also carry a machine-readable `code`; the frontend decides what to
  // do from that, and only displays `message`.
  check('errors also carry a code', Boolean(errAuth.json.error?.code), String(errAuth.json.error?.code));

  // Reads must NOT carry a message, or every list load fires a pointless toast.
  const readRes = await get('/auth/me', (loginMsg.json.data as { accessToken: string }).accessToken);
  check('GET response carries no message (avoids toast spam)', readRes.json.message === undefined);

  /* ── done ───────────────────────────────────────────────────────── */
  server.close();
  await disconnectDb();
  await rs.stop();

  out(`\n${'─'.repeat(46)}\n`);
  out(fail === 0 ? `✅ All ${pass} checks passed\n\n` : `❌ ${fail} failed, ${pass} passed\n\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  out(`\n💥 ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
