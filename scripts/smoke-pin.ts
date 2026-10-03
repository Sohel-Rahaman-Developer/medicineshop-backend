// D60 checks: a PIN set in the account, the lock is idle time on the server (never "app in the background"), 5 wrong = email code.
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller names the shape
const data = <T>(r: Res) => r.json.data as T;
const code = (r: Res) => `${r.status} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;
const MIN = 60_000;

async function main() {
  const h = await startHarness();
  const { SessionModel } = await import('../src/modules/auth/models/session.model.js');
  const { UserModel } = await import('../src/modules/user/user.model.js');

  const u = await h.signIn('sunita@pin1.test');
  const me = async () => data<{ user: { hasPin: boolean; lockMinutes: number } }>(await u.get('/auth/me')).user;
  const user = await UserModel.findOne({ email: 'sunita@pin1.test' }).lean();
  /** Pretend the last refresh on this device was this long ago. */
  const idle = async (minutes: number) => SessionModel.updateMany({ userId: user?._id, revokedAt: null }, { $set: { lastUsedAt: new Date(Date.now() - minutes * MIN) } });

  section('1. Setting a PIN');
  check('no PIN to start', !(await me()).hasPin);
  const bad = await Promise.all([{ pin: '12', lockMinutes: 30 }, { pin: '1234567', lockMinutes: 30 }, { pin: 'abcd', lockMinutes: 30 }, { pin: '2580', lockMinutes: 5 }].map((b) => u.put('/auth/pin', b)));
  check('too short / too long / letters / a 5-minute lock → 422', bad.every((r) => r.status === 422), bad.map((r) => r.status).join(','));
  const set = await u.put('/auth/pin', { pin: '2580', lockMinutes: 30 });
  check('PIN 2580, lock after 30 idle minutes', set.status === 200 && (await me()).hasPin && (await me()).lockMinutes === 30, code(set));
  check('stored hashed, never plain', Boolean((await UserModel.findById(user?._id).lean())?.pinHash) && (await UserModel.findById(user?._id).lean())?.pinHash !== '2580');

  section('2. Busy is not locked; idle is');
  await idle(20);
  check('20 minutes since the last refresh (a coffee, the app in the background) → refresh works', (await u.post('/auth/refresh', {})).status === 200);
  await idle(40);
  const lk = await u.post('/auth/refresh', {});
  check('40 idle minutes → 423 LOCKED', lk.status === 423 && lk.json.error?.code === 'LOCKED', code(lk));
  check('the cookies stay, so the PIN can open it', !lk.setCookies.some((c) => /^ms_rt=;/.test(c)));
  const w1 = await u.post('/auth/unlock', { pin: '1111' });
  check('wrong PIN → 422 with tries left', w1.status === 422 && /4 tries left/.test(w1.json.error?.message ?? ''), code(w1));
  const ok = await u.post('/auth/unlock', { pin: '2580' });
  check('right PIN → unlocked, the app works again', ok.status === 200 && (await u.get('/auth/me')).status === 200, code(ok));

  section('3. Five wrong PINs end the session');
  await idle(45);
  for (let i = 0; i < 4; i++) await u.post('/auth/unlock', { pin: '0000' });
  const last = await u.post('/auth/unlock', { pin: '0000' });
  check('5th wrong → 401, back to the email code', last.status === 401 && /email code/.test(last.json.error?.message ?? ''), code(last));
  // In the database, not just the cookie: the browser could keep a copy of the token.
  check('the session is revoked on the server (not just the cookie cleared)', (await SessionModel.countDocuments({ userId: user?._id, revokedAt: null })) === 0);
  check('the session is gone: refresh → 401', (await u.post('/auth/refresh', {})).status === 401);
  check('even the right PIN can’t bring it back', (await u.post('/auth/unlock', { pin: '2580' })).status === 401);

  section('4. Without a PIN nothing changes');
  const v = await h.signIn('vikram@pin1.test');
  const vu = await UserModel.findOne({ email: 'vikram@pin1.test' }).lean();
  await SessionModel.updateMany({ userId: vu?._id, revokedAt: null }, { $set: { lastUsedAt: new Date(Date.now() - 2 * 24 * 60 * MIN) } });
  check('2 days idle, no PIN → refresh works as before', (await v.post('/auth/refresh', {})).status === 200);
  check('unlock without a PIN set → 401', (await v.post('/auth/unlock', { pin: '1234' })).status === 401);

  section('5. Removing it');
  const u2 = await h.signIn('sunita@pin1.test');
  check('remove → no PIN, no lock', (await u2.del('/auth/pin')).status === 200 && !data<{ user: { hasPin: boolean } }>(await u2.get('/auth/me')).user.hasPin);
  check('unlock with no cookie → 401', (await h.client().post('/auth/unlock', { pin: '2580' })).status === 401);

  await h.close();
  finish();
}

main().catch(crash);
