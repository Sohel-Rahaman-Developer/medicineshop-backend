import { env } from '../config/env';

// Email clients: tables, inline styles, no SVG / web fonts / CSS gradients they can't fall back from.
const BRAND = env.MAIL_FROM_NAME;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const C = { ink: '#0f172a', body: '#334155', muted: '#64748b', faint: '#94a3b8', line: '#e2e8f0', page: '#eef2f6', card: '#ffffff', soft: '#f8fafc' };
const THEMES = {
  shop: { accent: '#0fb5a8', accent2: '#0ea5e9', deep: '#0b3b43', tint: '#e6f7f5', logo: `${env.SHOP_APP_URL}/icon-192.png`, name: BRAND },
  admin: { accent: '#7c3aed', accent2: '#db2777', deep: '#3b0764', tint: '#f3e8ff', logo: `${env.ADMIN_APP_URL}/apple-icon.png`, name: `${BRAND} Admin` },
};
type Theme = (typeof THEMES)[keyof typeof THEMES];

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

interface Shell {
  theme?: Theme;
  preheader: string;
  eyebrow?: string;
  title: string;
  intro?: string;
  body: string;
  footer?: string;
}

/** The one frame: brand bar with the app icon, a white card, a quiet footer; 600 px, fluid on phones. */
function shell({ theme = THEMES.shop, preheader, eyebrow, title, intro, body, footer }: Shell) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(title)}</title>
<style>@media (max-width:480px){.pad{padding-left:22px!important;padding-right:22px!important}.d{width:38px!important;height:50px!important;font-size:24px!important;line-height:50px!important}.dc{padding:0 2px!important}.big{font-size:22px!important}}</style></head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page}">${esc(preheader)}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page}"><tr><td align="center" style="padding:28px 14px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
    <tr><td style="padding:0 4px 16px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="padding-right:10px"><img src="${theme.logo}" width="36" height="36" alt="" style="display:block;border-radius:10px"></td>
        <td style="font:800 17px/1.2 ${FONT};color:${C.ink}">${esc(theme.name)}</td>
      </tr></table>
    </td></tr>
    <tr><td style="background:${C.card};border-radius:18px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,.04),0 12px 32px -18px rgba(15,23,42,.25)">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="height:6px;background:${theme.accent};background-image:linear-gradient(90deg,${theme.accent},${theme.accent2});font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td class="pad" style="padding:34px 36px 8px">
          ${eyebrow ? `<div style="font:800 11px/1 ${FONT};letter-spacing:.14em;text-transform:uppercase;color:${theme.accent};margin-bottom:12px">${esc(eyebrow)}</div>` : ''}
          <h1 style="margin:0;font:800 24px/1.25 ${FONT};color:${C.ink};letter-spacing:-.01em">${esc(title)}</h1>
          ${intro ? `<p style="margin:12px 0 0;font:400 15px/1.6 ${FONT};color:${C.body}">${intro}</p>` : ''}
        </td></tr>
        <tr><td class="pad" style="padding:16px 36px 34px">${body}</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:20px 8px 0;text-align:center;font:400 12px/1.6 ${FONT};color:${C.faint}">
      ${footer ?? `Sent by ${esc(theme.name)} · this is an automatic email, replies are not read.`}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

/** Each digit in its own tile — easy to read, and long-press copies the whole code on phones. */
function codeBox(otp: string, theme: Theme, minutes: number) {
  const cells = otp
    .split('')
    .map((d) => `<td class="dc" style="padding:0 4px"><div class="d" style="width:46px;height:58px;border-radius:12px;background:${theme.tint};border:1px solid ${theme.accent}33;font:800 30px/58px ${FONT};color:${theme.deep};text-align:center">${esc(d)}</div></td>`)
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px auto 0"><tr>${cells}</tr></table>
  <p style="margin:14px 0 0;text-align:center;font:400 13px/1.5 ${FONT};color:${C.muted}">Code: <b style="font-family:Menlo,Consolas,monospace;color:${C.ink};letter-spacing:.12em">${esc(otp)}</b> · works for <b style="color:${C.ink}">${String(minutes)} minutes</b></p>`;
}

function button(href: string, label: string, theme: Theme) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 4px"><tr><td style="border-radius:12px;background:${theme.accent};background-image:linear-gradient(135deg,${theme.accent},${theme.accent2})">
  <a href="${esc(href)}" style="display:inline-block;padding:14px 26px;font:700 15px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:12px">${esc(label)} &rarr;</a></td></tr></table>`;
}

function note(html: string, tone: 'info' | 'warn' | 'danger' = 'info') {
  const t = { info: ['#f1f5f9', '#cbd5e1', C.body], warn: ['#fffbeb', '#fde68a', '#92400e'], danger: ['#fef2f2', '#fecaca', '#991b1b'] }[tone];
  return `<div style="margin-top:22px;padding:14px 16px;border-radius:12px;background:${t[0]};border:1px solid ${t[1]};font:400 13px/1.6 ${FONT};color:${t[2]}">${html}</div>`;
}

function rows(items: [string, string][]) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;border:1px solid ${C.line};border-radius:12px;border-collapse:separate;overflow:hidden">${items
    .map(([k, v], i) => `<tr><td style="padding:12px 16px;font:400 13px/1.4 ${FONT};color:${C.muted};${i ? `border-top:1px solid ${C.line};` : ''}background:${C.soft};width:38%">${esc(k)}</td><td style="padding:12px 16px;font:600 14px/1.4 ${FONT};color:${C.ink};${i ? `border-top:1px solid ${C.line};` : ''}">${esc(v)}</td></tr>`)
    .join('')}</table>`;
}

const p = (html: string) => `<p style="margin:0 0 12px;font:400 15px/1.6 ${FONT};color:${C.body}">${html}</p>`;

export function otpEmail(otp: string, expiryMinutes: number) {
  const t = THEMES.shop;
  return {
    subject: `${otp} is your ${BRAND} sign-in code`,
    html: shell({
      preheader: `Your sign-in code is ${otp}. It works for ${String(expiryMinutes)} minutes.`,
      eyebrow: 'Sign-in code',
      title: 'Here is your code',
      intro: `Type these 6 digits on the ${esc(BRAND)} sign-in screen.`,
      body: `${codeBox(otp, t, expiryMinutes)}${note(`<b>Didn't try to sign in?</b> Ignore this email — nobody can get in without this code. Never share it, not even with ${esc(BRAND)} staff.`)}`,
    }),
    text: `Your ${BRAND} sign-in code: ${otp}\n\nIt works for ${String(expiryMinutes)} minutes.\nDidn't try to sign in? Ignore this email. Never share the code.`,
  };
}

export function adminOtpEmail(otp: string, expiryMinutes: number) {
  const t = THEMES.admin;
  return {
    subject: `${otp} is your ${BRAND} Admin code`,
    html: shell({
      theme: t,
      preheader: `Admin sign-in code ${otp} — then your authenticator.`,
      eyebrow: 'Platform console',
      title: 'Your admin sign-in code',
      intro: 'Step 1 of 2. After this code, the console asks for your authenticator.',
      body: `${codeBox(otp, t, expiryMinutes)}${note('<b>Didn\'t ask for this?</b> Someone typed your address on the admin sign-in. They still need your authenticator — but tell the platform owner now.', 'warn')}`,
    }),
    text: `Your ${BRAND} Admin code: ${otp}\n\nIt works for ${String(expiryMinutes)} minutes. Next you'll need your authenticator.\nDidn't ask for it? Tell the platform owner now.`,
  };
}

export function sessionRevokedEmail(deviceInfo: string, at: Date) {
  const when = at.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  return {
    subject: `Security alert — every device was signed out of ${BRAND}`,
    html: shell({
      preheader: 'We signed out every device as a precaution. Sign in again with a fresh code.',
      eyebrow: 'Security alert',
      title: 'We signed you out everywhere',
      intro: 'An old sign-in token was used again on your account. That usually means it reached someone else, so every device was signed out to be safe.',
      body: `${rows([['Device', deviceInfo || 'Unknown'], ['When', `${when} IST`]])}${button(`${env.SHOP_APP_URL}/login`, 'Sign in again', THEMES.shop)}${note('<b>Wasn\'t you?</b> Change your email password too — the sign-in codes go there.', 'danger')}`,
    }),
    text: `Security alert — ${BRAND}\n\nAn old sign-in token was used again on your account, so every device has been signed out.\n\nDevice: ${deviceInfo || 'unknown'}\nWhen: ${when} IST\n\nSign in again: ${env.SHOP_APP_URL}/login\nWasn't you? Change your email password too.`,
  };
}

export function inviteEmail(input: { shopName: string; roleName: string; inviterName: string; appUrl: string }) {
  const t = THEMES.shop;
  return {
    subject: `${input.inviterName} invited you to ${input.shopName} on ${BRAND}`,
    html: shell({
      preheader: `Join ${input.shopName} as ${input.roleName} — sign in with this email, no password.`,
      eyebrow: 'Team invitation',
      title: `Join ${input.shopName}`,
      intro: `<b style="color:${C.ink}">${esc(input.inviterName)}</b> added you to the team on ${esc(BRAND)}.`,
      body: `${rows([['Shop', input.shopName], ['Your role', input.roleName], ['Invited by', input.inviterName]])}${button(`${input.appUrl}/login`, `Open ${BRAND}`, t)}${p(`<span style="font-size:13px;color:${C.muted}">Sign in with <b>this email address</b> — a code comes to your inbox, no password to remember. Then accept the invitation.</span>`)}`,
    }),
    text: `${input.inviterName} invited you to ${input.shopName} as ${input.roleName} on ${BRAND}.\n\nSign in with this email address at ${input.appUrl}/login (a code comes to your inbox) and accept the invitation.`,
  };
}

export interface AlertBlock {
  head: string;
  lines: string[];
  link?: string;
}

/** Morning digest: one card per alert, each with its own way in. */
export function digestEmail(shop: string, title: string, blocks: AlertBlock[]) {
  const t = THEMES.shop;
  const base = env.SHOP_APP_URL;
  const cards = blocks
    .map(
      (b) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border:1px solid ${C.line};border-radius:14px;border-collapse:separate"><tr>
  <td style="width:4px;background:${t.accent};border-radius:14px 0 0 14px;font-size:0">&nbsp;</td>
  <td style="padding:14px 16px">
    <div style="font:700 15px/1.35 ${FONT};color:${C.ink}">${esc(b.head)}</div>
    ${b.lines.map((l) => `<div style="margin-top:4px;font:400 13px/1.5 ${FONT};color:${C.muted}">${esc(l)}</div>`).join('')}
    ${b.link ? `<a href="${esc(base + b.link)}" style="display:inline-block;margin-top:10px;font:700 13px/1 ${FONT};color:${t.accent};text-decoration:none">Open in ${esc(BRAND)} &rarr;</a>` : ''}
  </td></tr></table>`,
    )
    .join('');
  const footer = `${esc(shop)} · change what comes by email in ${esc(BRAND)} → Notifications → Preferences.`;
  return {
    html: shell({ preheader: blocks.map((b) => b.head).join(' · ').slice(0, 140), eyebrow: shop, title, intro: 'What needs a look today, most urgent first.', body: cards, footer }),
    text: `${shop}\n${title}\n\n${blocks.map((b) => `• ${b.head}\n${b.lines.map((l) => `  ${l}`).join('\n')}${b.link ? `\n  ${base}${b.link}` : ''}`).join('\n\n')}\n\nChange what comes by email in ${BRAND} → Notifications → Preferences.`,
  };
}

export interface DaySummary {
  shop: string;
  day: string;
  bills: number;
  total: string;
  modes: [string, string][];
  discount: string;
  returns: number;
  returnsTotal: string;
  cancelled: number;
}

/** Evening summary: the day's number big, the money by mode under it, then the one thing left to do. */
export function summaryEmail(raw: DaySummary) {
  const t = THEMES.shop;
  const s = { ...raw, day: new Date(`${raw.day}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) };
  const tile = (label: string, value: string) => `<td width="50%" style="padding:16px 18px;background:${t.tint};border-radius:14px;vertical-align:top">
    <div style="font:800 11px/1 ${FONT};letter-spacing:.1em;text-transform:uppercase;color:${t.accent}">${esc(label)}</div>
    <div class="big" style="margin-top:8px;font:800 26px/1.1 ${FONT};color:${t.deep}">${esc(value)}</div></td>`;
  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:10px 0;margin:0 -10px"><tr>${tile('Sales', s.total)}${tile('Bills', String(s.bills))}</tr></table>
  ${rows([...s.modes, ['Discount given', s.discount], ['Returns', `${String(s.returns)} · ${s.returnsTotal}`], ['Cancelled bills', String(s.cancelled)]])}
  ${button(`${env.SHOP_APP_URL}/day-close`, 'Close the day', t)}
  ${p(`<span style="font-size:13px;color:${C.muted}">Count the cash and close the drawer before tomorrow's sales mix in.</span>`)}`;
  return {
    html: shell({ preheader: `${s.day}: ${String(s.bills)} bills · ${s.total}`, eyebrow: `${s.shop} · ${s.day}`, title: 'Today at the counter', body, footer: `${esc(s.shop)} · change what comes by email in ${esc(BRAND)} → Notifications → Preferences.` }),
    text: `${s.shop} · ${s.day}\nToday at the counter\n\nSales: ${s.total} · ${String(s.bills)} bills\n${s.modes.map(([k, v]) => `${k}: ${v}`).join('\n')}\nDiscount given: ${s.discount}\nReturns: ${String(s.returns)} · ${s.returnsTotal}\nCancelled bills: ${String(s.cancelled)}\n\nClose the day: ${env.SHOP_APP_URL}/day-close`,
  };
}
