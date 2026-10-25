import { env } from '../config/env';
import { translate, type Lang } from '../core/lang';

// Email clients: tables, inline styles, no SVG / web fonts / CSS gradients they can't fall back from.
const BRAND = env.MAIL_FROM_NAME;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const C = { ink: '#0f172a', body: '#334155', muted: '#64748b', faint: '#94a3b8', line: '#e2e8f0', page: '#eef2f6', card: '#ffffff', soft: '#f8fafc' };
const THEMES = {
  shop: { accent: '#0fb5a8', accent2: '#0ea5e9', deep: '#0b3b43', tint: '#e6f7f5', logo: `${env.SHOP_APP_URL}/logo/icon-192`, name: BRAND },
  admin: { accent: '#7c3aed', accent2: '#db2777', deep: '#3b0764', tint: '#f3e8ff', logo: `${env.ADMIN_APP_URL}/logo/apple`, name: `${BRAND} Admin` },
};
type Theme = (typeof THEMES)[keyof typeof THEMES];

/** tr('English sentence') → the reader's language (core/lang words); check-words lists every tr() text. */
const words = (lang: Lang) => (text: string) => translate(lang, text);
const locale = (lang: Lang) => (lang === 'en' ? 'en-IN' : `${lang}-IN`);

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

interface Shell {
  theme?: Theme;
  preheader: string;
  eyebrow?: string;
  title: string;
  intro?: string;
  body: string;
  footer?: string;
  lang?: Lang;
}

/** The one frame: brand bar with the app icon, a white card, a quiet footer; 600 px, fluid on phones. */
function shell({ theme = THEMES.shop, preheader, eyebrow, title, intro, body, footer, lang = 'en' }: Shell) {
  const tr = words(lang);
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(title)}</title>
<style>@media (max-width:480px){.pad{padding-left:22px!important;padding-right:22px!important}.big{font-size:22px!important}}</style></head>
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
      ${footer ?? esc(tr(`Sent by ${theme.name} · this is an automatic email, replies are not read.`))}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

/** The code as one word in one tile: a double-tap or long-press selects all six digits, and they copy without spaces. */
function codeBox(otp: string, theme: Theme, minutes: number, lang: Lang = 'en') {
  const tr = words(lang);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px auto 0"><tr><td style="padding:14px 26px;border-radius:14px;background:${theme.tint};border:1px solid ${theme.accent}33;text-align:center"><span style="font:800 36px/1.1 Menlo,Consolas,'Courier New',monospace;letter-spacing:.28em;color:${theme.deep};-webkit-user-select:all;user-select:all">${esc(otp)}</span></td></tr></table>
  <p style="margin:12px 0 0;text-align:center;font:400 13px/1.5 ${FONT};color:${C.muted}">${esc(tr('Double-tap the code to copy it'))} · <b style="color:${C.ink}">${esc(tr(`works for ${String(minutes)} minutes`))}</b></p>`;
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

export function otpEmail(otp: string, expiryMinutes: number, lang: Lang = 'en') {
  const t = THEMES.shop;
  const tr = words(lang);
  return {
    subject: tr(`${otp} is your ${BRAND} sign-in code`),
    html: shell({
      lang,
      preheader: tr(`Your sign-in code is ${otp}. It works for ${String(expiryMinutes)} minutes.`),
      eyebrow: 'Sign-in code',
      title: tr('Here is your code'),
      intro: esc(tr(`Type these 6 digits on the ${BRAND} sign-in screen.`)),
      body: `${codeBox(otp, t, expiryMinutes, lang)}${note(`<b>${esc(tr('Didn’t try to sign in?'))}</b> ${esc(tr(`Ignore this email — nobody can get in without this code. Never share it, not even with ${BRAND} staff.`))}`)}`,
    }),
    text: `${tr(`Your ${BRAND} sign-in code: ${otp}`)}\n\n${tr(`It works for ${String(expiryMinutes)} minutes.`)}\n${tr('Didn’t try to sign in? Ignore this email. Never share the code.')}`,
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

export function sessionRevokedEmail(deviceInfo: string, at: Date, lang: Lang = 'en') {
  const tr = words(lang);
  const when = at.toLocaleString(locale(lang), { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const why = tr('An old sign-in token was used again on your account. That usually means it reached someone else, so every device was signed out to be safe.');
  const fix = `${tr('Wasn’t you?')} ${tr('Change your email password too — the sign-in codes go there.')}`;
  return {
    subject: tr(`Security alert — every device was signed out of ${BRAND}`),
    html: shell({
      lang,
      preheader: tr('We signed out every device as a precaution. Sign in again with a fresh code.'),
      eyebrow: 'Security alert',
      title: tr('We signed you out everywhere'),
      intro: esc(why),
      body: `${rows([['Device', deviceInfo || 'Unknown'], ['When', `${when} IST`]])}${button(`${env.SHOP_APP_URL}/login`, 'Sign in again', THEMES.shop)}${note(`<b>${esc(tr('Wasn’t you?'))}</b> ${esc(tr('Change your email password too — the sign-in codes go there.'))}`, 'danger')}`,
    }),
    text: `Security alert — ${BRAND}\n\n${why}\n\nDevice: ${deviceInfo || 'unknown'}\nWhen: ${when} IST\n\nSign in again: ${env.SHOP_APP_URL}/login\n${fix}`,
  };
}

export function inviteEmail(input: { shopName: string; roleName: string; inviterName: string; appUrl: string }, lang: Lang = 'en') {
  const t = THEMES.shop;
  const tr = words(lang);
  const how = tr('Sign in with this email address — a code comes to your inbox, no password to remember. Then accept the invitation.');
  return {
    subject: tr(`${input.inviterName} invited you to ${input.shopName} on ${BRAND}`),
    html: shell({
      lang,
      preheader: tr(`Join ${input.shopName} as ${input.roleName} — sign in with this email, no password.`),
      eyebrow: 'Team invitation',
      title: tr(`Join ${input.shopName}`),
      intro: esc(tr(`${input.inviterName} added you to the team on ${BRAND}.`)),
      body: `${rows([['Shop', input.shopName], ['Your role', input.roleName], ['Invited by', input.inviterName]])}${button(`${input.appUrl}/login`, `Open ${BRAND}`, t)}${p(`<span style="font-size:13px;color:${C.muted}">${esc(how)}</span>`)}`,
    }),
    text: `${tr(`${input.inviterName} invited you to ${input.shopName} as ${input.roleName} on ${BRAND}.`)}\n\n${how}\n${input.appUrl}/login`,
  };
}

export interface AlertBlock {
  head: string;
  lines: string[];
  link?: string;
}

/** Morning digest: one card per alert, each with its own way in. */
export function digestEmail(shop: string, title: string, blocks: AlertBlock[], lang: Lang = 'en') {
  const t = THEMES.shop;
  const tr = words(lang);
  const base = env.SHOP_APP_URL;
  const cards = blocks
    .map(
      (b) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border:1px solid ${C.line};border-radius:14px;border-collapse:separate"><tr>
  <td style="width:4px;background:${t.accent};border-radius:14px 0 0 14px;font-size:0">&nbsp;</td>
  <td style="padding:14px 16px">
    <div style="font:700 15px/1.35 ${FONT};color:${C.ink}">${esc(b.head)}</div>
    ${b.lines.map((l) => `<div style="margin-top:4px;font:400 13px/1.5 ${FONT};color:${C.muted}">${esc(l)}</div>`).join('')}
    ${b.link ? `<a href="${esc(base + b.link)}" style="display:inline-block;margin-top:10px;font:700 13px/1 ${FONT};color:${t.accent};text-decoration:none">${esc(tr(`Open in ${BRAND}`))} &rarr;</a>` : ''}
  </td></tr></table>`,
    )
    .join('');
  const prefs = tr(`Change what comes by email in ${BRAND} → Notifications → Preferences.`);
  return {
    html: shell({ lang, preheader: blocks.map((b) => b.head).join(' · ').slice(0, 140), eyebrow: shop, title, intro: esc(tr('What needs a look today, most urgent first.')), body: cards, footer: `${esc(shop)} · ${esc(prefs)}` }),
    text: `${shop}\n${title}\n\n${blocks.map((b) => `• ${b.head}\n${b.lines.map((l) => `  ${l}`).join('\n')}${b.link ? `\n  ${base}${b.link}` : ''}`).join('\n\n')}\n\n${prefs}`,
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
export function summaryEmail(raw: DaySummary, lang: Lang = 'en') {
  const t = THEMES.shop;
  const tr = words(lang);
  const s = { ...raw, day: new Date(`${raw.day}T00:00:00Z`).toLocaleDateString(locale(lang), { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) };
  const tile = (label: string, value: string) => `<td width="50%" style="padding:16px 18px;background:${t.tint};border-radius:14px;vertical-align:top">
    <div style="font:800 11px/1 ${FONT};letter-spacing:.1em;text-transform:uppercase;color:${t.accent}">${esc(label)}</div>
    <div class="big" style="margin-top:8px;font:800 26px/1.1 ${FONT};color:${t.deep}">${esc(value)}</div></td>`;
  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:10px 0;margin:0 -10px"><tr>${tile('Sales', s.total)}${tile('Bills', String(s.bills))}</tr></table>
  ${rows([...s.modes, ['Discount given', s.discount], ['Returns', `${String(s.returns)} · ${s.returnsTotal}`], ['Cancelled bills', String(s.cancelled)]])}
  ${button(`${env.SHOP_APP_URL}/day-close`, 'Close the day', t)}
  ${p(`<span style="font-size:13px;color:${C.muted}">${esc(tr('Count the cash and close the drawer before tomorrow’s sales mix in.'))}</span>`)}`;
  const head = s.bills === 1 ? tr(`${s.day}: 1 bill · ${s.total}`) : tr(`${s.day}: ${String(s.bills)} bills · ${s.total}`);
  return {
    html: shell({ lang, preheader: head, eyebrow: `${s.shop} · ${s.day}`, title: tr('Today at the counter'), body, footer: `${esc(s.shop)} · ${esc(tr(`Change what comes by email in ${BRAND} → Notifications → Preferences.`))}` }),
    text: `${s.shop} · ${s.day}\n${tr('Today at the counter')}\n\nSales: ${s.total} · ${String(s.bills)} bills\n${s.modes.map(([k, v]) => `${k}: ${v}`).join('\n')}\nDiscount given: ${s.discount}\nReturns: ${String(s.returns)} · ${s.returnsTotal}\nCancelled bills: ${String(s.cancelled)}\n\nClose the day: ${env.SHOP_APP_URL}/day-close`,
  };
}

/** D97: AI credit under the admin's line — an estimate from the recorded cost since the top-ups. */
export function aiCreditEmail(items: { name: string; leftUsd: number; alertUsd: number; loadedUsd: number; spentUsd: number }[]) {
  const t = THEMES.admin;
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const head = items.map((i) => `${i.name} about ${usd(i.leftUsd)} left`).join(' · ');
  return {
    subject: `${BRAND} — top up AI credit: ${head}`.slice(0, 160),
    html: shell({
      theme: t,
      preheader: head.slice(0, 140),
      eyebrow: 'AI credit',
      title: 'Time to top up',
      intro: 'The AI credit is under the line you set. When it runs out, bill reading and the chat stop for every shop until it is topped up.',
      body: `${rows(items.map((i) => [i.name, `about ${usd(i.leftUsd)} left (${usd(i.loadedUsd)} put in − ${usd(i.spentUsd)} used) · alert below ${usd(i.alertUsd)}`]))}${button(`${env.ADMIN_APP_URL}/ai`, 'Open AI bill reading', t)}${note('This is MedBox24’s estimate from the cost of every call. After topping up at Anthropic or Google, add the amount under AI → Credits so the estimate stays right.', 'warn')}`,
    }),
    text: `${BRAND} — AI credit is low\n\n${items.map((i) => `${i.name}: about ${usd(i.leftUsd)} left (${usd(i.loadedUsd)} put in − ${usd(i.spentUsd)} used), alert below ${usd(i.alertUsd)}`).join('\n')}\n\nTop up, then add it under AI → Credits: ${env.ADMIN_APP_URL}/ai`,
  };
}

interface PriceRise {
  name: string;
  from: Date;
  now: { input: number; output: number };
  next: { input: number; output: number };
  uses: { feature: 'read' | 'chat'; worstPaise: number; chargePaise: number; safe: boolean; needCoins: number }[];
}

/** An announced AI price rise a week ahead: what it does to bill reading and the chat, and the tokens that keep them safe. */
export function aiPriceEmail(items: PriceRise[]) {
  const t = THEMES.admin;
  const day = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const rs = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
  const what = { read: ['Bill reading', 'a page'], chat: ['The chat', 'a question'] } as const;
  const effect = (u: PriceRise['uses'][number]) =>
    `${what[u.feature][1]} can cost up to ${rs(u.worstPaise)}, its tokens bring ${rs(u.chargePaise)} — ${u.safe ? 'still safe' : `it pauses then; charge ${String(u.needCoins)} tokens ${what[u.feature][1]} before that day`}`;
  const lines = items.flatMap((i) => [
    [`${i.name} from ${day(i.from)}`, `${usd(i.now.input)} / ${usd(i.now.output)} → ${usd(i.next.input)} / ${usd(i.next.output)} per million (in / out)`] as [string, string],
    ...i.uses.map((u) => [what[u.feature][0], effect(u)] as [string, string]),
  ]);
  const head = items.map((i) => `${i.name} from ${day(i.from)}`).join(' · ');
  return {
    subject: `${BRAND} — AI price rise: ${head}`.slice(0, 160),
    html: shell({
      theme: t,
      preheader: head.slice(0, 140),
      eyebrow: 'AI prices',
      title: 'An AI price goes up soon',
      intro: 'A higher price has been announced for a model MedBox24 uses. From that day MedBox24 counts every call at the new price on its own.',
      body: `${rows(lines)}${button(`${env.ADMIN_APP_URL}/ai`, 'Open AI bill reading', t)}${note('A price that could lose money pauses that AI for every shop. Raise the tokens or pick another model before the day, under AI → Settings or Shop chat → Chat settings.', 'warn')}`,
    }),
    text: `${BRAND} — AI price rise\n\n${lines.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nCheck the tokens before the day: ${env.ADMIN_APP_URL}/ai`,
  };
}

/** D100: a field staff member's sign-in code — no authenticator after it. */
export function fieldOtpEmail(otp: string, expiryMinutes: number, lang: Lang = 'en') {
  const t = THEMES.shop;
  const tr = words(lang);
  return {
    subject: tr(`${otp} is your ${BRAND} sign-in code`),
    html: shell({
      theme: t,
      lang,
      preheader: tr(`Sign-in code ${otp}`),
      eyebrow: 'Sign in',
      title: tr('Your sign-in code'),
      body: `${codeBox(otp, t, expiryMinutes, lang)}${note(`<b>${esc(tr('Didn’t ask for this?'))}</b> ${esc(tr('Ignore this email — nobody can sign in without the code.'))}`)}`,
    }),
    text: `${tr(`Your ${BRAND} sign-in code: ${otp}`)}\n\n${tr(`It works for ${String(expiryMinutes)} minutes.`)} ${tr('Ignore this email — nobody can sign in without the code.')}`,
  };
}

const trialWords = (days: number) => (days > 0 ? `a ${String(days)}-day free trial` : 'no free trial');

/** D100: a new partner — written to a business partner, not an employee: their code, the free trial it gives, their portal. */
export function fieldWelcomeEmail(r: { name: string; code: string; trialDays: number; link: string }) {
  const t = THEMES.shop;
  return {
    subject: `Welcome aboard — your ${BRAND} code is ${r.code}`,
    html: shell({
      theme: t,
      preheader: `Shops that join with ${r.code} get ${trialWords(r.trialDays)}.`,
      eyebrow: 'Welcome',
      title: `Welcome aboard, ${r.name}`,
      intro: `You are now with ${BRAND} — this is your business as much as ours. Every medicine shop you bring to ${BRAND} is counted as yours, and you see how each one grows.`,
      body: `${rows([['Your code', r.code], ['Free trial for your shops', r.trialDays > 0 ? `${String(r.trialDays)} days` : 'None']])}${button(r.link, 'Open your desk', t)}${note(`Your desk shows your shops — on trial, paying — and lets you set up a shop with its owner. Sign in with an email code the first time, then set a password if you like.`)}`,
    }),
    text: `Welcome aboard, ${r.name}

You are now with ${BRAND}. Every shop you bring is counted as yours.
Your code: ${r.code} — shops that join with it get ${trialWords(r.trialDays)}.
Your desk: ${r.link}`,
  };
}

/** D100: one more code for a partner, with its own free trial. */
export function fieldCodeEmail(r: { name: string; code: string; trialDays: number; link: string }) {
  const t = THEMES.shop;
  return {
    subject: `Your new ${BRAND} code: ${r.code}`,
    html: shell({
      theme: t,
      preheader: `Shops that join with ${r.code} get ${trialWords(r.trialDays)}.`,
      eyebrow: 'New code',
      title: `A new code for you, ${r.name}`,
      intro: `Shops that join with this code get ${trialWords(r.trialDays)}, and every one of them is counted as yours. Your other codes keep working.`,
      body: `${rows([['New code', r.code], ['Free trial with it', r.trialDays > 0 ? `${String(r.trialDays)} days` : 'None']])}${button(r.link, 'Open your desk', t)}`,
    }),
    text: `A new code for you, ${r.name}

${r.code} — shops that join with it get ${trialWords(r.trialDays)}. Your other codes keep working.
Your desk: ${r.link}`,
  };
}

/** D100: field staff filled a shop's details; the owner signs in, checks them and accepts the Terms. */
export function ownerDraftEmail(r: { ownerName: string; shopName: string; staffName: string; trialDays: number; link: string; days: number }, lang: Lang = 'en') {
  const t = THEMES.shop;
  const tr = words(lang);
  const trial = r.trialDays > 0;
  const how = trial
    ? tr(`${r.staffName} from ${BRAND} has filled in your shop’s details. Sign in with this email, check them, accept the Terms and your ${String(r.trialDays)}-day free trial starts.`)
    : tr(`${r.staffName} from ${BRAND} has filled in your shop’s details. Sign in with this email, check them, accept the Terms and your shop starts.`);
  const wait = tr(`Nothing starts until you agree. The details wait for ${String(r.days)} days.`);
  return {
    subject: tr(`${r.shopName} is ready to start on ${BRAND}`).slice(0, 160),
    html: shell({
      theme: t,
      lang,
      preheader: trial ? tr(`${r.staffName} filled in your shop’s details — check them and start your ${String(r.trialDays)}-day free trial.`) : tr(`${r.staffName} filled in your shop’s details — check them and start.`),
      eyebrow: 'Your shop is ready',
      title: `Namaste ${r.ownerName}`,
      intro: esc(how),
      body: `${rows([['Shop', r.shopName], ['Filled by', `${r.staffName}, ${BRAND}`], ['Free trial', trial ? `${String(r.trialDays)} days` : 'None']])}${button(r.link, 'Check and start', t)}${note(esc(wait))}`,
    }),
    text: `Namaste ${r.ownerName}

${how} ${r.link}

${wait}`,
  };
}

/** A shop asked for a new product category: one tap opens the page to approve it for every shop. */
export function categoryRequestEmail(r: { name: string; shopName: string; userName: string; link: string; days: number }) {
  const t = THEMES.admin;
  return {
    subject: `${BRAND} — new category asked: ${r.name}`.slice(0, 160),
    html: shell({
      theme: t,
      preheader: `${r.shopName} asked for “${r.name}”`.slice(0, 140),
      eyebrow: 'Category request',
      title: 'A shop wants a new category',
      intro: 'It is not in the category list yet. Approve it once and every shop gets it; until then nobody can use it.',
      body: `${rows([['Category', r.name], ['Shop', r.shopName], ['Asked by', r.userName]])}${button(r.link, 'Open to approve', t)}${note(`The button opens a page with Approve and Reject — nothing changes until you tap one. The link is yours alone, works once and for ${String(r.days)} days; after that use Category requests in the admin console.`)}`,
    }),
    text: `${BRAND} — new category asked

Category: ${r.name}
Shop: ${r.shopName}
Asked by: ${r.userName}

Open to approve or reject (works once, ${String(r.days)} days): ${r.link}`,
  };
}

/** Ops alert to the super admins: what crossed its limit, and where to look. */
export function monitorAlertEmail(items: { label: string; n: number; limit: number }[], windowMin: number) {
  const t = THEMES.admin;
  const head = items.map((i) => `${i.label}: ${String(i.n)}`).join(' · ');
  return {
    subject: `${BRAND} alert — ${head}`.slice(0, 160),
    html: shell({
      theme: t,
      preheader: head.slice(0, 140),
      eyebrow: 'Platform alert',
      title: 'Something needs a look',
      intro: `In the last ${String(windowMin)} minutes these went over their limit. One email per problem per hour.`,
      body: `${rows(items.map((i) => [i.label, `${String(i.n)} (limit ${String(i.limit)})`]))}${button(`${env.ADMIN_APP_URL}/health`, 'Open Messaging & health', t)}${note('Server errors: check <b>pm2 logs pharma-api</b> on the server. Bad webhook signatures: someone may be faking Razorpay calls — nothing is credited without a valid signature.', 'warn')}`,
    }),
    text: `${BRAND} alert — last ${String(windowMin)} minutes\n\n${items.map((i) => `${i.label}: ${String(i.n)} (limit ${String(i.limit)})`).join('\n')}\n\nOpen: ${env.ADMIN_APP_URL}/health\nServer errors: pm2 logs pharma-api`,
  };
}
