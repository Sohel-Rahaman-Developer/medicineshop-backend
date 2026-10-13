import mongoose, { Types } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../core/errors';
import { signal } from '../../services/monitor';
import { hashOtp } from '../../utils/crypto';
import { istClock, istDayStart } from '../../utils/date';
import type { AdminActor } from '../admin/admin-auth';
import { log } from '../admin/admin.service';
import { OtpTokenModel } from '../auth/models/otp-token.model';
import { revokeAllForUser } from '../auth/token.service';
import { MembershipModel } from '../memberships/membership.model';
import { RoleModel } from '../roles/role.model';
import { SaleModel } from '../sales/sale.model';
import { ShopModel } from '../shops/shop.model';
import { createShop } from '../shops/shops.service';
import { createShopSchema } from '../shops/shops.validation';
import { SubscriptionModel } from '../subscription/subscription.model';
import { UserModel } from '../user/user.model';
import { HISTORY_DAYS, play, setUp } from './demo.fill';
import { DEMO_EMAIL, DEMO_EMAILS, DEMO_STAFF, DemoModel } from './demo.model';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const LEASE_MS = 60 * 60_000;
const OWNER = { name: 'Amit Banerjee', phone: '98300 41122' };
export const DEMO_SHOP = 'MedBox24 Demo Pharmacy';
const EMAILS = { owner: DEMO_EMAIL, manager: DEMO_STAFF[0].email, cashier: DEMO_STAFF[1].email, stock: DEMO_STAFF[2].email };

type JobKind = 'create' | 'reset' | 'nightly' | 'topup';

/** The day the demo shop's story starts: 09:00 IST, 60 days ago. */
const startOf = (now: Date) => new Date(istDayStart(now).getTime() - HISTORY_DAYS * DAY + 9 * HOUR);

async function counts(shopId: Types.ObjectId, now: Date) {
  const day0 = istDayStart(now);
  const ist = new Date(now.getTime() + 5.5 * HOUR);
  const week0 = new Date(day0.getTime() - ((ist.getUTCDay() + 6) % 7) * DAY);
  const month0 = new Date(day0.getTime() - (ist.getUTCDate() - 1) * DAY);
  const [rows] = await SaleModel.aggregate<Record<'today' | 'week' | 'month' | 'all', { n: number; total: number }[]>>([
    { $match: { shopId, status: { $ne: 'cancelled' } } },
    {
      $facet: Object.fromEntries(
        (
          [
            ['today', day0],
            ['week', week0],
            ['month', month0],
            ['all', new Date(0)],
          ] as const
        ).map(([k, from]) => [k, [{ $match: { billDate: { $gte: from } } }, { $group: { _id: null, n: { $sum: 1 }, total: { $sum: '$grandTotal' } } }]]),
      ),
    },
  ]);
  const one = (k: 'today' | 'week' | 'month' | 'all') => ({ bills: rows?.[k][0]?.n ?? 0, total: rows?.[k][0]?.total ?? 0 });
  return { today: one('today'), week: one('week'), month: one('month'), all: one('all') };
}

/** What the admin console's Demo account page shows. */
export async function demoInfo(now = new Date()) {
  const d = await DemoModel.findById('demo').lean();
  const shop = d?.shopId ? await ShopModel.findById(d.shopId).select('name').lean() : null;
  const job = d?.job ? { ...d.job, state: d.job.state === 'running' && (!d.busyUntil || d.busyUntil < now) ? 'failed' : d.job.state, error: d.job.state === 'running' && (!d.busyUntil || d.busyUntil < now) ? 'Stopped by a server restart — the next nightly reset makes it again' : (d.job.error ?? null) } : null;
  return {
    email: DEMO_EMAIL,
    staff: DEMO_STAFF.map((s) => ({ email: s.email, role: s.designation })),
    shop: shop ? { id: String(shop._id), name: shop.name } : null,
    code: { set: Boolean(d?.codeHash), setAt: d?.codeSetAt ?? null, setBy: d?.codeSetBy ?? null },
    lockedUntil: d?.lockedUntil && d.lockedUntil > now ? d.lockedUntil : null,
    filledTo: d?.filledTo ?? null,
    resetAt: d?.resetAt ?? null,
    job,
    counts: shop ? await counts(shop._id, now) : null,
  };
}

async function claim(kind: JobKind, by: string, now = new Date()) {
  return DemoModel.findOneAndUpdate(
    { _id: 'demo', shopId: { $ne: null }, $or: [{ busyUntil: null }, { busyUntil: { $lt: now } }] },
    { $set: { busyUntil: new Date(now.getTime() + LEASE_MS), job: { kind, state: 'running', by, startedAt: now, done: 0, total: 0 } } },
    { returnDocument: 'after' },
  ).lean();
}

/** Everything the demo shop holds goes; the shop itself is made again under the same id. */
async function wipe(shopId: Types.ObjectId) {
  for (const name of mongoose.modelNames()) {
    const m = mongoose.model(name);
    if (name === 'AdminAuditLog' || name === 'Demo' || !('shopId' in m.schema.paths)) continue;
    await m.collection.deleteMany({ shopId });
  }
  await ShopModel.collection.deleteOne({ _id: shopId });
}

async function people() {
  const now = new Date();
  const owner = await UserModel.findOneAndUpdate({ email: DEMO_EMAIL }, { $set: { name: OWNER.name, phone: OWNER.phone, status: 'active' }, $setOnInsert: { email: DEMO_EMAIL, emailVerifiedAt: now } }, { upsert: true, returnDocument: 'after' }).lean();
  const staff = [];
  for (const s of DEMO_STAFF) staff.push(await UserModel.findOneAndUpdate({ email: s.email }, { $set: { name: s.name, status: 'active' }, $setOnInsert: { email: s.email } }, { upsert: true, returnDocument: 'after' }).lean());
  return { owner, staff };
}

/** The shop as a new owner makes it, then marked demo: free for life, ten users, three staff. */
async function build(shopId: Types.ObjectId | undefined, start: Date) {
  const { owner, staff } = await people();
  const input = createShopSchema.parse({
    owner: OWNER,
    shop: { name: DEMO_SHOP, address: { line1: '14B Park Street', city: 'Kolkata', state: 'West Bengal', pincode: '700016' }, phone: '033 2229 4410', drugLicenseNumber: 'WB/KOL/RLF20B/2021/0418', drugLicenseExpiry: '2031-03', pricingMode: 'MRP_INCLUSIVE' },
    termsVersion: env.TERMS_VERSION,
    agree: true,
  });
  const { id } = await createShop(String(owner._id), input, {}, shopId);
  const sid = new Types.ObjectId(id);
  await ShopModel.collection.updateOne({ _id: sid }, { $set: { demo: true, createdAt: new Date(start.getTime() - DAY) } });
  await SubscriptionModel.updateOne({ shopId: sid }, { $set: { planCode: 'demo', status: 'active', startDate: start, endDate: new Date('2099-12-31T18:29:59.999Z'), maxUsers: 10 } });
  const roles = await RoleModel.find({ shopId: sid }).select('systemKey').lean();
  for (const [i, s] of DEMO_STAFF.entries()) {
    const user = staff[i];
    const role = roles.find((r) => r.systemKey === s.role);
    if (!user || !role) throw AppError.internal();
    await MembershipModel.create({ shopId: sid, userId: user._id, roleId: role._id, designation: s.designation, status: 'active', joinedAt: start, lastActiveAt: start });
  }
  await DemoModel.updateOne({ _id: 'demo' }, { $set: { shopId: sid, userId: owner._id } }, { upsert: true });
  return sid;
}

async function progress(done: number, total: number) {
  await DemoModel.updateOne({ _id: 'demo' }, { $set: { 'job.done': done, 'job.total': total, busyUntil: new Date(Date.now() + LEASE_MS) } });
}

/** Makes the demo shop's data again (60 days up to now), or adds what has happened since the last fill. */
async function run(kind: JobKind, by: string) {
  const d = await claim(kind, by);
  if (!d?.shopId) return false;
  const now = new Date();
  try {
    let shopId = d.shopId;
    let from = d.filledTo ?? now;
    if (kind !== 'topup' || !d.filledTo) {
      const start = startOf(now);
      // A new demo shop is already built; a reset makes it again from nothing.
      if (kind !== 'create') {
        await wipe(shopId);
        shopId = await build(shopId, start);
      }
      await setUp(shopId, EMAILS, start);
      from = start;
    }
    const r = await play(shopId, EMAILS, from, now, progress);
    await DemoModel.updateOne(
      { _id: 'demo' },
      { $set: { filledTo: now, ...(kind === 'topup' ? {} : { resetAt: now }), busyUntil: null, 'job.state': 'done', 'job.finishedAt': new Date(), 'job.done': r.total, 'job.total': r.total, 'job.skipped': r.skipped, ...(r.skipped > r.total * 0.3 ? { 'job.error': `${String(r.skipped)} of ${String(r.total)} steps were skipped` } : {}) } },
    );
    if (kind !== 'topup') logger.info({ kind, steps: r.total, skipped: r.skipped }, 'Demo shop data made');
    return true;
  } catch (err) {
    logger.error({ err, kind }, 'Demo shop job failed');
    await DemoModel.updateOne({ _id: 'demo' }, { $set: { busyUntil: null, 'job.state': 'failed', 'job.finishedAt': new Date(), 'job.error': err instanceof Error ? err.message.slice(0, 300) : 'Failed' } });
    await signal('job_fail');
    return false;
  }
}

const background = (kind: JobKind, by: string) => {
  run(kind, by).catch((err: unknown) => {
    logger.error({ err, kind }, 'Demo shop job failed');
  });
};

export async function createDemo(a: AdminActor, reason: string, ip?: string) {
  const d = await DemoModel.findById('demo').select('shopId').lean();
  if (d?.shopId && (await ShopModel.exists({ _id: d.shopId }))) throw AppError.conflict('The demo shop is already there — use Reset demo data to make it again');
  const user = await UserModel.findOne({ email: DEMO_EMAIL }).select('_id').lean();
  if (user && !d?.shopId && (await MembershipModel.exists({ userId: user._id }).setOptions({ crossTenant: true }))) throw AppError.conflict(`${DEMO_EMAIL} already belongs to a shop — it can’t become the demo account`);
  const shopId = await build(d?.shopId ?? undefined, startOf(new Date()));
  await log(a, 'demo_create', reason, 'made the demo shop (free for life, for showing MedBox24)', { id: shopId, name: DEMO_SHOP }, undefined, ip);
  await DemoModel.updateOne({ _id: 'demo' }, { $set: { busyUntil: null, filledTo: null } });
  background('create', a.name);
  return demoInfo();
}

export async function resetDemo(a: AdminActor, reason: string, ip?: string) {
  const d = await DemoModel.findById('demo').select('shopId busyUntil').lean();
  if (!d?.shopId) throw AppError.notFound('Make the demo shop first');
  if (d.busyUntil && d.busyUntil > new Date()) throw AppError.conflict('The demo data is being made right now — wait for it to finish');
  await log(a, 'demo_reset', reason, 'made the demo shop’s data again', { id: d.shopId, name: DEMO_SHOP }, undefined, ip);
  background('reset', a.name);
  return demoInfo();
}

/** The code the marketing team signs in with. Saving it signs every demo device out and lifts a lock. */
export async function setDemoCode(a: AdminActor, code: string, reason: string, ip?: string) {
  const d = await DemoModel.findById('demo').select('shopId userId').lean();
  if (!d?.shopId || !d.userId) throw AppError.notFound('Make the demo shop first');
  if (/^(\d)\1{5}$/.test(code) || '0123456789'.includes(code) || '9876543210'.includes(code)) throw AppError.validation('Choose a code that is hard to guess — not 111111 or 123456', [{ field: 'body.code', message: 'Too easy to guess' }]);
  await DemoModel.updateOne({ _id: 'demo' }, { $set: { codeHash: await hashOtp(code), codeSetAt: new Date(), codeSetBy: a.name, fails: [] }, $unset: { lockedUntil: 1 } });
  await OtpTokenModel.updateMany({ audience: 'shop', email: { $in: DEMO_EMAILS }, consumedAt: null }, { $set: { consumedAt: new Date() } });
  let out = 0;
  for (const u of await UserModel.find({ email: { $in: DEMO_EMAILS } }).select('_id').lean()) out += await revokeAllForUser(u._id, 'user_revoked');
  await log(a, 'demo_code', reason, `set a new demo sign-in code${out ? ` — ${String(out)} signed-in device(s) signed out` : ''}`, { id: d.shopId, name: DEMO_SHOP }, undefined, ip);
  return demoInfo();
}

/** Scheduler: a fresh 60 days every night at 03:00 IST; through the day, the bills of each hour as it passes. */
export async function demoTick(now = new Date()) {
  const d = await DemoModel.findById('demo').select('shopId resetAt busyUntil').lean();
  if (!d?.shopId || (d.busyUntil && d.busyUntil > now)) return null;
  const at3 = new Date(istDayStart(now).getTime() + 3 * HOUR);
  const kind: JobKind = istClock(now) >= '03:00' && (!d.resetAt || d.resetAt < at3) ? 'nightly' : 'topup';
  return (await run(kind, 'scheduler')) ? kind : null;
}
