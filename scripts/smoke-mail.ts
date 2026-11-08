// A mail server that refuses our login (Hostinger's 535 on 4 Nov 2026): sign-in says so plainly, alerts at once, /health shows it, and limits stay fair.
import { createServer, type Socket } from 'node:net';
import { check, crash, finish, section, startHarness, type Res } from './lib/harness';

const MIN = 60_000;
const err = (r: Res) => `${String(r.status)} ${r.json.error?.code ?? ''} ${r.json.error?.message ?? ''}`;

/** Just enough SMTP for nodemailer: `refuse` answers every login with 535, like a changed or blocked mailbox. */
function fakeSmtp() {
  const state = { refuse: false, logins: 0, delivered: 0 };
  const server = createServer((sock: Socket) => {
    let data = false;
    let buf = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') {
            data = false;
            state.delivered += 1;
            sock.write('250 queued\r\n');
          }
          continue;
        }
        const verb = line.split(' ')[0]?.toUpperCase() ?? '';
        if (verb === 'EHLO' || verb === 'HELO') sock.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (verb === 'AUTH') {
          state.logins += 1;
          sock.write(state.refuse ? '535 5.7.8 Error: authentication failed: (reason unavailable)\r\n' : '235 2.7.0 Authentication successful\r\n');
        } else if (verb === 'MAIL' || verb === 'RCPT' || verb === 'RSET' || verb === 'NOOP') sock.write('250 ok\r\n');
        else if (verb === 'DATA') {
          data = true;
          sock.write('354 go on\r\n');
        } else if (verb === 'QUIT') sock.end('221 bye\r\n');
        else sock.write('502 not here\r\n');
      }
    });
    sock.on('error', () => undefined);
  });
  return { state, server };
}

async function main() {
  const smtp = fakeSmtp();
  await new Promise<void>((resolve) => smtp.server.listen(0, '127.0.0.1', resolve));
  const addr = smtp.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const h = await startHarness({ env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false', SMTP_USER: 'no-reply@mail.test', SMTP_PASS: 'smoke-mail-pass', MAIL_FROM_EMAIL: 'no-reply@mail.test', RATE_OTP_REQUEST_PER_IP: '12' } });
  const { SignalModel, signal } = await import('../src/services/monitor.js');
  const { checkAlerts, tick } = await import('../src/modules/notifications/jobs.js');
  const { EmailJobModel } = await import('../src/services/mail-queue.js');
  const { MailHealthModel, recheckMail } = await import('../src/services/mail-health.js');
  const { verifyMailer, CODE_MAIL_DOWN } = await import('../src/services/mailer.js');
  const { health } = await import('../src/modules/admin/admin.service.js');
  const { AdminUserModel } = await import('../src/modules/admin/admin.model.js');
  const { RateHitModel } = await import('../src/core/rate-store.js');
  const signals = async (kind: string) => (await SignalModel.aggregate<{ n: number }>([{ $match: { kind } }, { $group: { _id: null, n: { $sum: '$n' } } }]))[0]?.n ?? 0;
  const mailOf = async () => (await h.client().get('/health')).json.data as { mail?: string } | undefined;
  await AdminUserModel.create({ email: 'root@mail.test', name: 'Root', role: 'super' });
  const web = h.client();

  section('1. Mail server takes our login');
  const ok = await web.post('/auth/otp/request', { email: 'asha@mail.test' });
  check('a code is asked for → 200, and the fake server got the email', ok.status === 200 && smtp.state.delivered === 1, `${err(ok)} delivered=${String(smtp.state.delivered)}`);
  check('/health says "mail":"ok"', (await mailOf())?.mail === 'ok', JSON.stringify(await mailOf()));

  section('2. Mail server refuses the login (535)');
  smtp.state.refuse = true;
  const down = await web.post('/auth/otp/request', { email: 'asha@mail.test' });
  check('shop sign-in → 503 SERVICE_UNAVAILABLE, not 500', down.status === 503 && down.json.error?.code === 'SERVICE_UNAVAILABLE', err(down));
  check('…and says the email could not be sent, not "Something went wrong"', down.json.error?.message === CODE_MAIL_DOWN, err(down));
  web.lang = 'hi';
  const hi = await web.post('/auth/otp/request', { email: 'asha@mail.test' });
  check('in Hindi when the app is in Hindi', hi.status === 503 && /email नहीं भेज पाए/.test(hi.json.error?.message ?? ''), err(hi));
  web.lang = undefined;
  const admin = h.client({ origin: 'http://localhost:3001' });
  const adminDown = await admin.post('/admin/auth/code', { email: 'root@mail.test' });
  check('admin sign-in → the same 503 and message', adminDown.status === 503 && adminDown.json.error?.message === CODE_MAIL_DOWN, err(adminDown));
  const field = await h.client().post('/field/auth/code', { email: 'nobody@mail.test' });
  check('a partner address nobody owns → still the same 200 (no email tried, nothing leaks)', field.status === 200, err(field));
  check('every refused code counts as a "code_mail_fail" signal (3)', (await signals('code_mail_fail')) === 3, String(await signals('code_mail_fail')));
  await EmailJobModel.deleteMany({ kind: 'monitor_alert' });
  const fired = await checkAlerts(new Date());
  const alert = await EmailJobModel.findOne({ kind: 'monitor_alert' }).lean();
  check('the alert check fires at the first one (limit 1) and emails the super admin', fired.includes('code_mail_fail') && alert?.to === 'root@mail.test' && /nobody can sign in by email/.test(alert.text), `${fired.join()} ${alert?.to ?? '-'}`);
  check('/health says "mail":"failing" — an outside uptime check sees it even though our mailbox cannot send the alert', (await mailOf())?.mail === 'failing', JSON.stringify(await mailOf()));
  const adm = await health();
  check('admin Messaging & health: mail server failing, with the 535 reason', adm.mail.server.state === 'failing' && /535/.test(adm.mail.server.lastError), JSON.stringify(adm.mail.server));
  check('the server error the person saw is counted too', (await signals('server_error')) >= 3, String(await signals('server_error')));

  section('3. Refused codes do not use up the email’s tries');
  for (let i = 0; i < 2; i++) await web.post('/auth/otp/request', { email: 'asha@mail.test' });
  smtp.state.refuse = false;
  const back = await web.post('/auth/otp/request', { email: 'asha@mail.test' });
  check('after 5 refused requests (limit 3), the mailbox is fixed → the 6th still gets a code', back.status === 200, err(back));
  check('a sent email clears "failing" at once', (await mailOf())?.mail === 'ok' && (await health()).mail.server.state === 'ok', JSON.stringify(await mailOf()));

  section('4. Fixed with nobody signing in: the 15-minute recheck clears it');
  smtp.state.refuse = true;
  await web.post('/auth/otp/request', { email: 'bina@mail.test' });
  const since = (await MailHealthModel.findById('mail').lean())?.since;
  await web.post('/auth/otp/request', { email: 'bina@mail.test' });
  check('a second refusal keeps the first "since" time', (await MailHealthModel.findById('mail').lean())?.since.getTime() === since?.getTime());
  smtp.state.refuse = false;
  const t0 = new Date();
  const logins = smtp.state.logins;
  check('right after a failure: no recheck yet (no extra login at the mail server)', (await recheckMail(verifyMailer, t0)) === null && smtp.state.logins === logins);
  check('15 minutes later: one login check, mail ok again', (await recheckMail(verifyMailer, new Date(t0.getTime() + 15 * MIN))) === true && (await mailOf())?.mail === 'ok' && smtp.state.logins === logins + 1);
  smtp.state.refuse = true;
  await web.post('/auth/otp/request', { email: 'chand@mail.test' });
  const t1 = new Date();
  check('still refused 15 minutes later: stays failing', (await recheckMail(verifyMailer, new Date(t1.getTime() + 15 * MIN))) === false && (await mailOf())?.mail === 'failing');
  check('and the next recheck waits another 15 minutes', (await recheckMail(verifyMailer, new Date(t1.getTime() + 20 * MIN))) === null);
  smtp.state.refuse = false;
  // An empty queue, so only the recheck can clear it (a queued email going out would clear it too).
  await EmailJobModel.deleteMany({});
  const before = { logins: smtp.state.logins, delivered: smtp.state.delivered };
  await tick(new Date(t1.getTime() + 31 * MIN));
  check('the minute job runs the recheck: one login check, no email, ok again', (await mailOf())?.mail === 'ok' && smtp.state.logins === before.logins + 1 && smtp.state.delivered === before.delivered, JSON.stringify({ ...smtp.state, before }));
  await RateHitModel.deleteMany({});

  section('5. Too many codes: when it opens again, and an alert for a flood');
  const asks: Res[] = [];
  for (let i = 0; i < 4; i++) asks.push(await web.post('/auth/otp/request', { email: 'dev@mail.test' }));
  const limited = asks[3];
  check('3 codes, then 429 for the 4th', asks.slice(0, 3).every((r) => r.status === 200) && limited?.status === 429, asks.map((r) => r.status).join(','));
  const mins = Number(/Try again in (\d+) min\./.exec(limited?.json.error?.message ?? '')?.[1] ?? 0);
  check('…saying how long: "Try again in 15 min."', mins === 15, limited ? err(limited) : '-');
  web.lang = 'bn';
  const bn = await web.post('/auth/otp/request', { email: 'dev@mail.test' });
  check('in Bengali, with the minutes', bn.status === 429 && /15 মিনিট পরে/.test(bn.json.error?.message ?? ''), err(bn));
  web.lang = undefined;
  const adminAsks: number[] = [];
  for (let i = 0; i < 4; i++) adminAsks.push((await admin.post('/admin/auth/code', { email: 'root@mail.test' })).status);
  check('admin sign-in now has the same limit: 3 codes, then 429', adminAsks.join(',') === '200,200,200,429', adminAsks.join(','));
  check('the admin counter is its own: the same email still gets a shop code', (await web.post('/auth/otp/request', { email: 'root@mail.test' })).status === 200);
  const wrong: number[] = [];
  for (let i = 0; i < 16; i++) wrong.push((await admin.post('/admin/auth/verify', { email: 'root@mail.test', otp: '000000' })).status);
  const lastWrong = await admin.post('/admin/auth/verify', { email: 'root@mail.test', otp: '000000' });
  check('admin code checks: 15 per email, then 429 "Too many tries"', wrong.slice(0, 15).every((s) => s === 401) && wrong[15] === 429 && /Too many tries for this email\. Try again in \d+ min\./.test(lastWrong.json.error?.message ?? ''), `${wrong.join(',')} ${err(lastWrong)}`);
  check('each 429 on a code request counts as "code_limited" (3)', (await signals('code_limited')) === 3, String(await signals('code_limited')));
  for (let i = 0; i < 17; i++) await signal('code_limited');
  await EmailJobModel.deleteMany({ kind: 'monitor_alert' });
  check('20 in 15 minutes → alert', (await checkAlerts(new Date())).includes('code_limited'));

  section('6. One network: every request counts, refused ones too');
  await RateHitModel.deleteMany({});
  smtp.state.refuse = true;
  const ip: number[] = [];
  for (let i = 0; i < 13; i++) ip.push((await web.post('/auth/otp/request', { email: `ip${String(i)}@mail.test` })).status);
  check('12 per network (set for this test), refused ones included — the 13th is 429', ip.slice(0, 12).every((s) => s === 503) && ip[12] === 429, ip.join(','));
  smtp.state.refuse = false;

  await h.close();
  await new Promise<void>((resolve) => smtp.server.close(() => { resolve(); }));
  finish();
}

main().catch(crash);
