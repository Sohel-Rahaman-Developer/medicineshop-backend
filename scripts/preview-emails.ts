// Every email as an .html file to open in a browser: `npm run preview:emails -- <out dir>`.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminOtpEmail, digestEmail, inviteEmail, otpEmail, sessionRevokedEmail, summaryEmail } from '../src/services/email-templates';

const out = process.argv[2] ?? '.';
const mails: Record<string, { html: string }> = {
  'otp': otpEmail('482915', 10),
  'admin-otp': adminOtpEmail('730264', 10),
  'invite': inviteEmail({ shopName: 'Shri Ram Medical Store', roleName: 'Cashier', inviterName: 'Rohit Agarwal', appUrl: 'https://med.trackcloud.in' }),
  'security': sessionRevokedEmail('Chrome on Android · 49.37.12.8', new Date()),
  'digest': digestEmail('Shri Ram Medical Store', '3 alerts for today', [
    { head: '4 batches expire within 30 days', lines: ['₹2,840 at cost — return them to the supplier or sell first', 'Dolo 650 · DL2409 — 12 Oct', 'Pan 40 · PN771 — 19 Oct'], link: '/expiry' },
    { head: '6 products are low on stock', lines: ['Azithral 500 — 2 strips left', 'Volini Gel 30 g — 1 tube left'], link: '/reorder' },
    { head: 'Sharma Distributors: ₹18,400 due in 3 days', lines: ['Invoice SD/26/1189 · due 6 Oct'], link: '/suppliers' },
  ]),
  'summary': summaryEmail({ shop: 'Shri Ram Medical Store', day: '2026-10-03', bills: 86, total: '₹41,230', modes: [['Cash', '₹18,900'], ['UPI', '₹19,480'], ['Card', '₹1,600'], ['Udhaar', '₹1,250']], discount: '₹640', returns: 2, returnsTotal: '₹310', cancelled: 1 }),
};
for (const [name, m] of Object.entries(mails)) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the developer names the output folder
  writeFileSync(join(out, `${name}.html`), m.html);
}
process.stdout.write(`${String(Object.keys(mails).length)} emails written to ${out}\n`);
