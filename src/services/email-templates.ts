import { env } from '../config/env';

const BRAND = env.MAIL_FROM_NAME;

function layout(heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1d23">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e5e7eb">
    <div style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6366f1">${BRAND}</div>
    <h1 style="margin:12px 0 16px;font-size:20px;font-weight:700">${heading}</h1>
    ${bodyHtml}
  </div>
  <p style="max-width:520px;margin:16px auto 0;font-size:11px;color:#9ca3af;text-align:center">
    This is an automated email, please do not reply.
  </p>
</body></html>`;
}

export function otpEmail(otp: string, expiryMinutes: number) {
  return {
    subject: `${otp} is your ${BRAND} sign-in code`,
    html: layout(
      'Sign-in code',
      `<p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#4b5563">
         Enter the code below to sign in.
       </p>
       <div style="font-size:30px;font-weight:700;letter-spacing:.28em;padding:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;text-align:center">
         ${otp}
       </div>
       <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#6b7280">
         This code expires in <b>${expiryMinutes} minutes</b>.<br>
         If you did not try to sign in, you can ignore this email — nobody can
         get into your account without the code.
       </p>`,
    ),
    text: `Your ${BRAND} sign-in code: ${otp}\n\nThis code expires in ${expiryMinutes} minutes.\nIf you did not try to sign in, you can ignore this email.`,
  };
}

export function sessionRevokedEmail(deviceInfo: string, at: Date) {
  const when = at.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  return {
    subject: `Security alert — all devices were signed out of your ${BRAND} account`,
    html: layout(
      'Security alert',
      `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#4b5563">
         We saw an old sign-in token being used again on your account. That
         usually means the token ended up in someone else's hands.
       </p>
       <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#4b5563">
         As a precaution we have <b>signed out every device</b>.
       </p>
       <div style="padding:14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:13px;color:#991b1b">
         <b>Device:</b> ${deviceInfo || 'unknown'}<br>
         <b>Time:</b> ${when} IST
       </div>
       <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6b7280">
         Please sign in again. If this was not you, check your email account too.
       </p>`,
    ),
    text: `Security alert — ${BRAND}\n\nAn old sign-in token was used again on your account. As a precaution every device has been signed out.\n\nDevice: ${deviceInfo || 'unknown'}\nTime: ${when} IST\n\nPlease sign in again.`,
  };
}
