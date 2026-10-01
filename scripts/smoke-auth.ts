// Auth smoke test: the whole email-OTP flow through cookies + CSRF, on an in-memory replica set.
import { check, crash, finish, section, startHarness } from './lib/harness';

async function main() {
  const h = await startHarness();
  const { OtpTokenModel } = await import('../src/modules/auth/models/otp-token.model.js');
  const { SessionModel } = await import('../src/modules/auth/models/session.model.js');
  const { UserModel } = await import('../src/modules/user/user.model.js');

  const email = 'sohel@medicineshop.test';
  const web = h.client();

  section('1. OTP request');
  const reqRes = await web.post('/auth/otp/request', { email });
  check('returned 200', reqRes.status === 200, String(reqRes.status));
  check('token created in the database', (await OtpTokenModel.countDocuments({ email, consumedAt: null })) === 1);
  const stored = await OtpTokenModel.findOne({ email, consumedAt: null }).lean();
  check('OTP stored hashed, not in plain text', Boolean(stored?.otpHash.startsWith('$2')));
  const unknown = await web.post('/auth/otp/request', { email: 'nobody@nowhere.test' });
  check('unknown email gets the same 200 (enumeration safe)', unknown.status === 200);

  section('2. Wrong OTP');
  await h.seedOtp(email, '123456');
  const wrong = await web.post('/auth/otp/verify', { email, otp: '999999' });
  check('rejected with 401', wrong.status === 401, String(wrong.status));
  const afterWrong = await OtpTokenModel.findOne({ email, consumedAt: null }).lean();
  check('attempts counter incremented', afterWrong?.attempts === 1, String(afterWrong?.attempts));
  check('no auth cookie set on failure', web.jar.get('ms_at') === undefined);

  section('3. Login with the correct OTP');
  const login = await web.post('/auth/otp/verify', { email, otp: '123456', rememberMe: true });
  const d = login.json.data as { isNewUser?: boolean } | undefined;
  check('returned 200', login.status === 200, String(login.status));
  check('access cookie set', Boolean(web.jar.get('ms_at')));
  check('refresh cookie set', Boolean(web.jar.get('ms_rt')));
  check('no token in the response body', !/accessToken|refreshToken/.test(login.text));
  check('detected as a new user', d?.isNewUser === true);
  const user = await UserModel.findOne({ email }).lean();
  check('emailVerifiedAt recorded on first login', Boolean(user?.emailVerifiedAt));
  const sessionRow = await SessionModel.findOne({}).lean();
  check('refresh token stored hashed', sessionRow?.tokenHash !== web.jar.get('ms_rt'));

  section('4. OTP replay');
  const replay = await h.client().post('/auth/otp/verify', { email, otp: '123456' });
  check('an already consumed OTP is rejected', replay.status === 401, String(replay.status));

  section('5. Protected route');
  check('/me works with the cookie', (await web.get('/auth/me')).status === 200);
  check('401 without a cookie', (await h.client().get('/auth/me')).status === 401);
  const forged = h.client();
  forged.jar.set('ms_at', 'garbage.token.here', '/api/v1');
  check('401 with a bad token', (await forged.get('/auth/me')).status === 401);

  section('6. Refresh and rotation');
  const rt0 = web.jar.get('ms_rt') ?? '';
  const at0 = web.jar.get('ms_at') ?? '';
  const r1 = await web.post('/auth/refresh');
  check('refresh returned 200', r1.status === 200, String(r1.status));
  check('a new access cookie was issued', Boolean(web.jar.get('ms_at')) && web.jar.get('ms_at') !== at0);
  check('rotation happened (refresh cookie changed)', Boolean(web.jar.get('ms_rt')) && web.jar.get('ms_rt') !== rt0);

  section('7. Reuse detection (the important one)');
  const thief = h.client();
  thief.jar.set('ms_rt', rt0, '/api/v1/auth');
  const reuse = await thief.post('/auth/refresh');
  check('the old refresh token is rejected', reuse.status === 401, String(reuse.status));
  check('the dead refresh cookie is cleared', thief.jar.get('ms_rt') === undefined);
  const afterReuse = await web.post('/auth/refresh');
  check('the entire family was revoked', afterReuse.status === 401, String(afterReuse.status));
  const revoked = await SessionModel.countDocuments({ revokedReason: 'reuse_detected' });
  check('marked as reuse_detected in the database', revoked > 0, String(revoked));

  section('8. Sessions and logout');
  const web2 = h.client();
  await h.seedOtp(email, '654321');
  const login2 = await web2.post('/auth/otp/verify', { email, otp: '654321' });
  check('second login works', login2.status === 200, String(login2.status));
  check('isNewUser is false now', (login2.json.data as { isNewUser?: boolean } | undefined)?.isNewUser === false);
  const sess = await web2.get('/auth/sessions');
  const list = sess.json.data as { current: boolean }[] | undefined;
  check('session list returned', sess.status === 200 && Array.isArray(list));
  check('the current device is flagged', Boolean(list?.some((s) => s.current)));
  const rtBeforeLogout = web2.jar.get('ms_rt') ?? '';
  const atBeforeLogout = web2.jar.get('ms_at') ?? '';
  check('logout returned 200', (await web2.post('/auth/logout')).status === 200);
  check('logout clears both cookies', !web2.jar.get('ms_at') && !web2.jar.get('ms_rt'));
  const replayAccess = h.client();
  replayAccess.jar.set('ms_at', atBeforeLogout, '/api/v1');
  check('an access token stops working the moment its session is signed out', (await replayAccess.get('/auth/me')).status === 401);
  const replayLogout = h.client();
  replayLogout.jar.set('ms_rt', rtBeforeLogout, '/api/v1/auth');
  const afterLogout = await replayLogout.post('/auth/refresh');
  check('refresh is rejected after logout', afterLogout.status === 401, String(afterLogout.status));

  section('9. Validation');
  const badEmail = await web.post('/auth/otp/request', { email: 'not-an-email' });
  check('422 for an invalid email', badEmail.status === 422, String(badEmail.status));
  check('error code is correct', badEmail.json.error?.code === 'VALIDATION_ERROR', badEmail.json.error?.code ?? '');

  section('10. Rate limiting isolation');
  const victim = 'ratelimit-victim@test.local';
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await web.post('/auth/otp/request', { email: victim })).status);
  check('429 once the limit is hit', codes.includes(429), codes.join(','));
  const other = await web.post('/auth/otp/request', { email: 'ratelimit-bystander@test.local' });
  check('a different user still works (the limit is not global)', other.status === 200, String(other.status));
  const original = await web.post('/auth/otp/request', { email });
  check('the first user is unaffected', original.status === 200, String(original.status));

  section('11. Backend-driven messages');
  const okMsg = await web.post('/auth/otp/request', { email: 'msgtest@test.local' });
  check('success response carries a message', Boolean(okMsg.json.message));
  const web3 = h.client();
  await h.seedOtp(email, '222222');
  const loginMsg = await web3.post('/auth/otp/verify', { email, otp: '222222' });
  check('login response carries a message', Boolean(loginMsg.json.message));
  const errAuth = await web3.post('/auth/otp/verify', { email, otp: '000000' });
  check('401 carries error.message', Boolean(errAuth.json.error?.message));
  check('errors also carry a code', Boolean(errAuth.json.error?.code));
  const errVal = await web3.post('/auth/otp/request', { email: 'bad' });
  check('422 carries error.message', Boolean(errVal.json.error?.message));
  const err404 = await web3.get('/auth/no-such-route');
  check('404 carries error.message', Boolean(err404.json.error?.message));
  const readRes = await web3.get('/auth/me');
  check('GET response carries no message (avoids toast spam)', readRes.status === 200 && readRes.json.message === undefined);

  section('12. Disabled user');
  await UserModel.updateOne({ email }, { $set: { status: 'disabled' } });
  const refreshDisabled = await web3.post('/auth/refresh');
  check('a disabled user cannot refresh', refreshDisabled.status === 401, String(refreshDisabled.status));
  await h.seedOtp(email, '333333');
  const loginDisabled = await h.client().post('/auth/otp/verify', { email, otp: '333333' });
  check('a disabled user cannot sign in', loginDisabled.status === 401, String(loginDisabled.status));
  await UserModel.updateOne({ email }, { $set: { status: 'active' } });

  await h.close();
  finish();
}

main().catch(crash);
