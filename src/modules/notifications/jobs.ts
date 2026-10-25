import { hostname } from 'node:os';
import { Schema, model, type Types } from 'mongoose';
import { summariseRecent } from '../retention/retention';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { contextFor, type TenantContext } from '../../core/middleware/tenant';
import { istClock, istDayStart, istIsoDay } from '../../utils/date';
import { inr } from '../../utils/money';
import { drainMail, queueMail } from '../../services/mail-queue';
import * as loyalty from '../loyalty/loyalty.service';
import { MembershipModel } from '../memberships/membership.model';
import { SaleReturnModel } from '../sales/sale-return.model';
import { SaleModel } from '../sales/sale.model';
import { ShopModel } from '../shops/shop.model';
import { reconcile } from '../subscription/reconcile';
import { UserModel } from '../user/user.model';
import { liveAlerts, type Alert } from './alerts.service';
import { offFor, wants } from './notifications.service';
import { digestEmail, monitorAlertEmail, summaryEmail } from '../../services/email-templates';
import { translate } from '../../core/lang';
import { ALERT_WINDOW_MIN, overLimit, signal } from '../../services/monitor';
import { AdminUserModel } from '../admin/admin.model';
import { settleStuckReads } from '../ai/bill-ai';
import { settleStuckQuestions } from '../ask/ask.service';
import { demoTick } from '../demo/demo.service';
import { welcomeMissing } from '../ai/welcome';
import { lowCredits } from '../ai/credits';
import { aiSettings } from '../ai/ai-settings';
import { noticesDue } from '../ai/price-changes';
import { aiCreditEmail, aiPriceEmail } from '../../services/email-templates';
import { gateway } from '../subscription/gateway';

const DAY = 24 * 60 * 60 * 1000;

// A job runs once per key (shop + IST day), however many servers tick — the unique index is the lock.
const runSchema = new Schema({ key: { type: String, required: true, unique: true }, at: { type: Date, required: true } }, { versionKey: false });
runSchema.index({ at: 1 }, { expireAfterSeconds: 40 * 24 * 60 * 60 });
export const JobRunModel = model('JobRun', runSchema);

// One API worker runs the minute tick; the lease passes on by itself when its holder stops renewing (restart, crash).
const leaseSchema = new Schema({ _id: { type: String, required: true }, owner: { type: String, required: true }, until: { type: Date, required: true } }, { versionKey: false });
export const LeaseModel = model('Lease', leaseSchema);
const ME = `${hostname()}:${String(process.pid)}`;
const LEASE_MS = 90_000;

/** True when this worker holds the scheduler lease — or just took it over. */
export async function leader(now = new Date(), me = ME): Promise<boolean> {
  try {
    const row = await LeaseModel.findOneAndUpdate({ _id: 'scheduler', $or: [{ until: { $lt: now } }, { owner: me }] }, { $set: { owner: me, until: new Date(now.getTime() + LEASE_MS) } }, { upsert: true, returnDocument: 'after' }).lean();
    return row.owner === me;
  } catch (err) {
    // Someone else holds it: the upsert met their row.
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

async function claim(key: string, at: Date) {
  try {
    await JobRunModel.create({ key, at });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

/** Extra addresses from Settings → Alerts get what the owner gets. */
export interface Copies {
  ownerId: Types.ObjectId;
  to: string[];
}

/** Everyone who may get the mail, each in their own language; a copy reads in the owner's. */
async function people(shopId: Types.ObjectId, copies?: Copies) {
  const ms = await MembershipModel.find({ shopId, status: 'active' }).select('userId').lean();
  const users = (await UserModel.find({ _id: { $in: ms.map((m) => m.userId) } }).select('email lang').lean()).filter((u) => u.email).map((u) => ({ _id: u._id, email: u.email, lang: u.lang ?? 'en' }));
  const known = new Set(users.map((u) => u.email.toLowerCase()));
  const extra = (copies?.to ?? []).filter((e) => !known.has(e.toLowerCase()));
  const ownerLang = copies ? ((await UserModel.findById(copies.ownerId).select('lang').lean())?.lang ?? 'en') : 'en';
  return [...users, ...(copies ? extra.map((email) => ({ _id: copies.ownerId, email, lang: ownerLang })) : [])];
}

/** Morning digest (alertDigestTime): each person's email-wanted alerts, one mail each, nothing when empty. */
export async function digest(shopId: Types.ObjectId, shopName: string, now: Date, copies?: Copies) {
  let mails = 0;
  for (const u of await people(shopId, copies)) {
    let ctx: TenantContext;
    try {
      ctx = (await contextFor(shopId, u._id)).ctx;
    } catch {
      continue;
    }
    const off = await offFor(shopId, u._id);
    const list = (await liveAlerts(ctx, now)).filter((a) => a.type !== 'DAILY_SUMMARY' && wants(off, a.type, 'email'));
    if (!list.length) continue;
    const tr = (text: string) => translate(u.lang, text);
    const blocks = list.map((a: Alert) => ({ head: tr(a.title), lines: [tr(a.body), ...a.items.map((i) => `${i.text} — ${tr(i.sub)}`)], link: a.route }));
    const m = digestEmail(shopName, list.length === 1 ? tr('1 alert for today') : tr(`${String(list.length)} alerts for today`), blocks, u.lang);
    const first = blocks[0]?.head ?? '';
    const more = list.length - 1;
    await queueMail({ kind: 'digest', shopId, to: u.email, subject: more === 0 ? `${shopName} · ${first}` : more === 1 ? `${shopName} · ${first} ${tr('+ 1 more')}` : `${shopName} · ${first} ${tr(`+ ${String(more)} more`)}`, ...m }, now);
    mails++;
  }
  return mails;
}

/** Evening summary (dailySummaryTime) to Owner / Manager who want it: today's bills, money by mode, returns. */
export async function summary(shopId: Types.ObjectId, shopName: string, now: Date, copies?: Copies) {
  const d0 = istDayStart(now);
  const range = { $gte: d0, $lt: new Date(d0.getTime() + DAY) };
  const [bills, cancelled, rets] = await Promise.all([
    SaleModel.find({ shopId, billDate: range, status: { $ne: 'cancelled' } }).select('grandTotal totalDiscount payments').lean(),
    SaleModel.countDocuments({ shopId, cancelledAt: range }),
    SaleReturnModel.find({ shopId, returnDate: range }).select('total').lean(),
  ]);
  const modes = new Map<string, number>();
  for (const b of bills) for (const p of b.payments) modes.set(p.mode, (modes.get(p.mode) ?? 0) + p.amount);
  const total = bills.reduce((s, b) => s + b.grandTotal, 0);
  const facts = {
    shop: shopName,
    day: istIsoDay(now),
    bills: bills.length,
    total: inr(total),
    modes: [...modes.entries()].map(([k, v]): [string, string] => [k === 'CREDIT' ? 'Udhaar' : k === 'UPI' ? 'UPI' : k.charAt(0) + k.slice(1).toLowerCase(), inr(v)]),
    discount: inr(bills.reduce((s, b) => s + b.totalDiscount, 0)),
    returns: rets.length,
    returnsTotal: inr(rets.reduce((s, r) => s + r.total, 0)),
    cancelled,
  };
  let mails = 0;
  for (const u of await people(shopId, copies)) {
    let ctx: TenantContext;
    try {
      ctx = (await contextFor(shopId, u._id)).ctx;
    } catch {
      continue;
    }
    if (!(ctx.isOwner || ctx.roleKey === 'owner' || ctx.roleKey === 'manager')) continue;
    if (!wants(await offFor(shopId, u._id), 'DAILY_SUMMARY', 'email')) continue;
    const tr = (text: string) => translate(u.lang, text);
    const head = bills.length === 1 ? tr(`${istIsoDay(now)}: 1 bill · ${inr(total)}`) : tr(`${istIsoDay(now)}: ${String(bills.length)} bills · ${inr(total)}`);
    await queueMail({ kind: 'summary', shopId, to: u.email, subject: `${shopName} · ${head}`, ...summaryEmail(facts, u.lang) }, now);
    mails++;
  }
  return mails;
}

/** Nightly: points past their date expire and today's birthdays get their bonus (PLAN §16). */
async function nightly(shopId: Types.ObjectId, ownerId: Types.ObjectId, now: Date) {
  const ctx = (await contextFor(shopId, ownerId)).ctx;
  await loyalty.expireDue(ctx, now);
  // PLAN §36.3: the day lines that outlive bill detail.
  await summariseRecent(shopId, now);
  return loyalty.birthdays(ctx, now);
}

/** One minute of the scheduler: mail out, then each shop's due jobs once per IST day. */
export async function tick(now = new Date()) {
  const mail = await drainMail(now);
  const day = istIsoDay(now);
  const clock = istClock(now);
  const shops = await ShopModel.find({ status: 'active' }).select('name ownerUserId settings.notifications').lean();
  // Today's shop jobs already done, in one read — not three round trips per shop every minute.
  const keys = shops.flatMap((s) => ['nightly', 'digest', 'summary'].map((k) => `${k}:${String(s._id)}:${day}`));
  const done = new Set((await JobRunModel.find({ key: { $in: keys } }).select('key').lean()).map((r) => r.key));
  const fresh = (key: string) => !done.has(key) && claim(key, now);
  const ran: string[] = [];
  // Payments the webhooks missed, once an hour (B8c).
  if ((await gateway()).mode === 'razorpay' && (await claim(`reconcile:${now.toISOString().slice(0, 13)}`, now))) {
    await reconcile(now).catch(async (err: unknown) => {
      logger.error({ err }, 'Payment reconcile failed');
      await signal('job_fail', now);
    });
    ran.push('reconcile');
  }
  // D78: an AI read cut off by a restart gives its coins back (every 10 minutes).
  if (await claim(`aireads:${now.toISOString().slice(0, 15)}`, now)) {
    const back = await settleStuckReads(now).catch(async (err: unknown) => {
      logger.error({ err }, 'AI read settle failed');
      await signal('job_fail', now);
      return 0;
    });
    const asks = await settleStuckQuestions(now).catch(async (err: unknown) => {
      logger.error({ err }, 'AI question settle failed');
      await signal('job_fail', now);
      return 0;
    });
    if (asks) ran.push(`asks:${String(asks)}`);
    if (back) ran.push(`aireads:${String(back)}`);
    // D96: shops made before the welcome coins get theirs too.
    const welcomed = await welcomeMissing().catch(async (err: unknown) => {
      logger.error({ err }, 'Welcome coins failed');
      await signal('job_fail', now);
      return 0;
    });
    if (welcomed) ran.push(`welcome:${String(welcomed)}`);
    // D97: AI credit under the admin's line → the super admins, once a day per provider.
    const low = await lowCredits().catch(async (err: unknown) => {
      logger.error({ err }, 'AI credit check failed');
      await signal('job_fail', now);
      return [];
    });
    const fresh = [];
    for (const c of low) if (await claim(`aicredit:${c.provider}:${day}`, now)) fresh.push(c);
    if (fresh.length) {
      const mail = aiCreditEmail(fresh);
      for (const a of await AdminUserModel.find({ role: 'super', status: 'active' }).select('email').lean()) await queueMail({ kind: 'ai_credit', to: a.email, ...mail }, now);
      ran.push(`aicredit:${fresh.map((c) => c.provider).join(',')}`);
    }
    // An announced price rise for a model in use → the super admins, once, a week before.
    const rises = await aiSettings(now).then((s) => noticesDue(s, now)).catch(async (err: unknown) => {
      logger.error({ err }, 'AI price notice failed');
      await signal('job_fail', now);
      return [];
    });
    const told = [];
    for (const c of rises) if (await claim(`aiprice:${c.model}:${c.from.toISOString()}`, now)) told.push(c);
    if (told.length) {
      const mail = aiPriceEmail(told);
      for (const a of await AdminUserModel.find({ role: 'super', status: 'active' }).select('email').lean()) await queueMail({ kind: 'ai_price', to: a.email, ...mail }, now);
      ran.push(`aiprice:${told.map((c) => c.model).join(',')}`);
    }
  }
  // The demo shop's bills keep up with the clock, and it starts afresh each night; it runs beside the tick.
  if (await claim(`demo:${now.toISOString().slice(0, 15)}`, now)) {
    demoTick(now).catch(async (err: unknown) => {
      logger.error({ err }, 'Demo shop job failed');
      await signal('job_fail', now);
    });
  }
  for (const s of shops) {
    const n = s.settings.notifications;
    const email = n?.emailEnabled ?? true;
    try {
      if (await fresh(`nightly:${String(s._id)}:${day}`)) {
        await nightly(s._id, s.ownerUserId, now);
        ran.push(`nightly:${s.name}`);
      }
      if (email && clock >= (n?.alertDigestTime ?? '08:00') && (await fresh(`digest:${String(s._id)}:${day}`))) {
        await digest(s._id, s.name, now, { ownerId: s.ownerUserId, to: n?.extraEmails ?? [] });
        ran.push(`digest:${s.name}`);
      }
      if (email && clock >= (n?.dailySummaryTime ?? '22:00') && (await fresh(`summary:${String(s._id)}:${day}`))) {
        await summary(s._id, s.name, now, { ownerId: s.ownerUserId, to: n?.extraEmails ?? [] });
        ran.push(`summary:${s.name}`);
      }
    } catch (err) {
      logger.error({ err, shopId: String(s._id) }, 'Scheduled job failed');
      await signal('job_fail', now);
    }
  }
  const alerted = await checkAlerts(now).catch((err: unknown) => {
    logger.error({ err }, 'Alert check failed');
    return [];
  });
  if (alerted.length) ran.push(`alert:${alerted.join(',')}`);
  return { mail, ran };
}

/** A signal over its limit emails every active super admin — once per signal per clock hour. */
export async function checkAlerts(now = new Date()) {
  const fresh: Awaited<ReturnType<typeof overLimit>> = [];
  for (const o of await overLimit(now)) if (await claim(`alert:${o.kind}:${now.toISOString().slice(0, 13)}`, now)) fresh.push(o);
  if (!fresh.length) return [];
  const mail = monitorAlertEmail(fresh, ALERT_WINDOW_MIN);
  const admins = await AdminUserModel.find({ role: 'super', status: 'active' }).select('email').lean();
  for (const a of admins) await queueMail({ kind: 'monitor_alert', to: a.email, ...mail }, now);
  return fresh.map((o) => o.kind);
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Starts the minute tick (PLAN §17: no Redis): every worker asks for the lease, only its holder ticks. Off in tests. */
export function startScheduler() {
  if (timer || !env.JOBS_ENABLED) return;
  const run = () => {
    // The last minute is still going: skip this one rather than pile up.
    if (running) return;
    running = true;
    leader()
      .then((lead) => (lead ? tick() : null))
      .catch(async (err: unknown) => {
        logger.error({ err }, 'Scheduler tick failed');
        await signal('job_fail');
      })
      .finally(() => { running = false; });
  };
  timer = setInterval(run, 60_000);
  timer.unref();
  run();
}

/** Stops the tick and hands the lease on, so another worker takes over within a minute. */
export async function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  await LeaseModel.updateOne({ _id: 'scheduler', owner: ME }, { $set: { until: new Date(0) } }).catch(() => undefined);
}
