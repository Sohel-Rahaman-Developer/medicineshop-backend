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
import { ALERT_WINDOW_MIN, overLimit, signal } from '../../services/monitor';
import { AdminUserModel } from '../admin/admin.model';
import { settleStuckReads } from '../ai/bill-ai';

const DAY = 24 * 60 * 60 * 1000;

// A job runs once per key (shop + IST day), however many servers tick — the unique index is the lock.
const runSchema = new Schema({ key: { type: String, required: true, unique: true }, at: { type: Date, required: true } }, { versionKey: false });
runSchema.index({ at: 1 }, { expireAfterSeconds: 40 * 24 * 60 * 60 });
export const JobRunModel = model('JobRun', runSchema);

async function claim(key: string, at: Date) {
  try {
    await JobRunModel.create({ key, at });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

async function people(shopId: Types.ObjectId) {
  const ms = await MembershipModel.find({ shopId, status: 'active' }).select('userId').lean();
  const users = await UserModel.find({ _id: { $in: ms.map((m) => m.userId) } }).select('email').lean();
  return users.filter((u) => u.email);
}

/** Morning digest (alertDigestTime): each person's email-wanted alerts, one mail each, nothing when empty. */
export async function digest(shopId: Types.ObjectId, shopName: string, now: Date) {
  let mails = 0;
  for (const u of await people(shopId)) {
    let ctx: TenantContext;
    try {
      ctx = (await contextFor(shopId, u._id)).ctx;
    } catch {
      continue;
    }
    const off = await offFor(shopId, u._id);
    const list = (await liveAlerts(ctx, now)).filter((a) => a.type !== 'DAILY_SUMMARY' && wants(off, a.type, 'email'));
    if (!list.length) continue;
    const blocks = list.map((a: Alert) => ({ head: a.title, lines: [a.body, ...a.items.map((i) => `${i.text} — ${i.sub}`)], link: a.route }));
    const m = digestEmail(shopName, `${String(list.length)} ${list.length === 1 ? 'alert' : 'alerts'} for today`, blocks);
    await queueMail({ kind: 'digest', shopId, to: u.email, subject: `${shopName} · ${list[0]?.title ?? 'alerts'}${list.length > 1 ? ` + ${String(list.length - 1)} more` : ''}`, ...m }, now);
    mails++;
  }
  return mails;
}

/** Evening summary (dailySummaryTime) to Owner / Manager who want it: today's bills, money by mode, returns. */
export async function summary(shopId: Types.ObjectId, shopName: string, now: Date) {
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
  const mail = summaryEmail({
    shop: shopName,
    day: istIsoDay(now),
    bills: bills.length,
    total: inr(total),
    modes: [...modes.entries()].map(([k, v]): [string, string] => [k === 'CREDIT' ? 'Udhaar' : k === 'UPI' ? 'UPI' : k.charAt(0) + k.slice(1).toLowerCase(), inr(v)]),
    discount: inr(bills.reduce((s, b) => s + b.totalDiscount, 0)),
    returns: rets.length,
    returnsTotal: inr(rets.reduce((s, r) => s + r.total, 0)),
    cancelled,
  });
  let mails = 0;
  for (const u of await people(shopId)) {
    let ctx: TenantContext;
    try {
      ctx = (await contextFor(shopId, u._id)).ctx;
    } catch {
      continue;
    }
    if (!(ctx.isOwner || ctx.roleKey === 'owner' || ctx.roleKey === 'manager')) continue;
    if (!wants(await offFor(shopId, u._id), 'DAILY_SUMMARY', 'email')) continue;
    await queueMail({ kind: 'summary', shopId, to: u.email, subject: `${shopName} · ${istIsoDay(now)}: ${String(bills.length)} bills · ${inr(total)}`, ...mail }, now);
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
  const ran: string[] = [];
  // Payments the webhooks missed, once an hour (B8c).
  if (env.PAYMENTS_MODE === 'razorpay' && (await claim(`reconcile:${now.toISOString().slice(0, 13)}`, now))) {
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
    if (back) ran.push(`aireads:${String(back)}`);
  }
  for (const s of shops) {
    const n = s.settings.notifications;
    const email = n?.emailEnabled ?? true;
    try {
      if (await claim(`nightly:${String(s._id)}:${day}`, now)) {
        await nightly(s._id, s.ownerUserId, now);
        ran.push(`nightly:${s.name}`);
      }
      if (email && clock >= (n?.alertDigestTime ?? '08:00') && (await claim(`digest:${String(s._id)}:${day}`, now))) {
        await digest(s._id, s.name, now);
        ran.push(`digest:${s.name}`);
      }
      if (email && clock >= (n?.dailySummaryTime ?? '22:00') && (await claim(`summary:${String(s._id)}:${day}`, now))) {
        await summary(s._id, s.name, now);
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

/** Starts the minute tick in the API process (PLAN §17: no Redis). Off in tests; on in production. */
export function startScheduler() {
  if (timer || !env.JOBS_ENABLED) return;
  const run = () => {
    tick().catch(async (err: unknown) => {
      logger.error({ err }, 'Scheduler tick failed');
      await signal('job_fail');
    });
  };
  timer = setInterval(run, 60_000);
  timer.unref();
  run();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
