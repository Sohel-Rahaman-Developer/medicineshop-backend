import { Types } from 'mongoose';
import { afterCursor, page, sortOf } from '../../core/cursor';
import { AppError } from '../../core/errors';
import { inr } from '../../utils/money';
import { audit } from '../audit/audit.model';
import { MembershipModel } from '../memberships/membership.model';
import { ShopModel } from '../shops/shop.model';
import { PlanModel, SubscriptionPaymentModel } from '../subscription/billing.model';
import { autopayOf, refund, stopAutopay } from '../subscription/autopay';
import { plans as planList, plansFor, recordManual, shapePayment } from '../subscription/subscription.service';
import { ShopTermsModel, setPrices } from '../subscription/terms';
import * as retention from '../retention/retention';
import { EmailJobModel } from '../../services/mail-queue';
import { JobRunModel } from '../notifications/jobs';
import { WebhookEventModel } from '../subscription/billing.model';
import { SubscriptionModel, statusAt } from '../subscription/subscription.model';
import { UserModel } from '../user/user.model';
import { ADMIN_ROLES, AdminAuditModel, AdminUserModel, PlatformSettingsModel, type AdminRole } from './admin.model';
import type { AdminActor } from './admin-auth';
import { forgetPlatform, platform } from './platform';

const DAY = 24 * 60 * 60 * 1000;
// Admin reads go across shops on purpose (PLAN §21.1) — tenant collections need the explicit flag.
const ALL = { crossTenant: true } as const;

/** Every admin action: why, by whom — on the admin log, and on the shop's own audit log when it touches a shop (D15). */
async function log(a: AdminActor, action: string, reason: string, text: string, shop?: { id: Types.ObjectId; name: string }, changes?: unknown, ip?: string) {
  await AdminAuditModel.create({ adminUserId: new Types.ObjectId(a.id), adminName: a.name, ...(shop ? { shopId: shop.id, shopName: shop.name } : {}), action, reason, text, ...(changes ? { changes } : {}), ip });
  if (shop) await audit({ shopId: shop.id, userId: a.id, userName: `MedShop · ${a.name}`, action: 'update', module: 'subscription', entityId: String(shop.id), entityName: shop.name, text: `MedShop (${a.name}) ${text} — ${reason}`, ip });
}

export async function overview(now = new Date()) {
  const [shops, subs, paid, failed] = await Promise.all([
    ShopModel.countDocuments({}),
    SubscriptionModel.find({}).setOptions(ALL).select('status planCode endDate').lean(),
    SubscriptionPaymentModel.aggregate<{ total: number; n: number }>([{ $match: { status: 'paid', paidAt: { $gte: new Date(now.getTime() - 30 * DAY) } } }, { $group: { _id: null, total: { $sum: '$amount' }, n: { $sum: 1 } } }]),
    SubscriptionPaymentModel.countDocuments({ status: 'failed', createdAt: { $gte: new Date(now.getTime() - 7 * DAY) } }),
  ]);
  const by: Record<string, number> = { trial: 0, active: 0, grace: 0, expired: 0, cancelled: 0 };
  for (const s of subs) by[statusAt(s, now)] = (by[statusAt(s, now)] ?? 0) + 1;
  const endingSoon = subs.filter((s) => ['trial', 'active'].includes(statusAt(s, now)) && s.endDate.getTime() - now.getTime() < 7 * DAY).length;
  return { shops, byStatus: by, endingSoon, paid30: paid[0]?.total ?? 0, payments30: paid[0]?.n ?? 0, failed7: failed };
}

export async function shops(q: { q?: string; status?: string; cursor?: string; limit: number }, now = new Date()) {
  const sort = { field: 'createdAt', dir: -1 } as const;
  const filter: Record<string, unknown> = {};
  if (q.q) filter.name = { $regex: q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  if (q.status === 'suspended') filter.status = 'suspended';
  const rows = await ShopModel.find({ ...filter, ...afterCursor(q.cursor, sort) }).sort(sortOf(sort)).limit(q.limit + 1).select('name address phone ownerUserId drugLicenseNumber drugLicenseExpiry status createdAt').lean<{ _id: Types.ObjectId; name: string; address?: { city?: string }; phone?: string; ownerUserId: Types.ObjectId; drugLicenseNumber: string; drugLicenseExpiry: Date; status: string; createdAt: Date }[]>();
  const { items, meta } = page(rows, q.limit, (r) => r.createdAt);
  const ids = items.map((s) => s._id);
  const [subs, owners, users] = await Promise.all([
    SubscriptionModel.find({ shopId: { $in: ids } }).select('shopId status planCode endDate maxUsers').lean(),
    UserModel.find({ _id: { $in: items.map((s) => s.ownerUserId) } }).select('name email').lean(),
    MembershipModel.aggregate<{ _id: Types.ObjectId; n: number; last: Date | null }>([{ $match: { shopId: { $in: ids } } }, { $group: { _id: '$shopId', n: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } }, last: { $max: '$lastActiveAt' } } }]),
  ]);
  const out = items.map((s) => {
    const sub = subs.find((x) => x.shopId.equals(s._id));
    const o = owners.find((x) => x._id.equals(s.ownerUserId));
    const u = users.find((x) => x._id.equals(s._id));
    return {
      id: String(s._id), name: s.name, city: s.address?.city ?? '', phone: s.phone ?? '', status: s.status, createdAt: s.createdAt,
      owner: { name: o?.name ?? '', email: o?.email ?? '' },
      drugLicense: { number: s.drugLicenseNumber, expiry: s.drugLicenseExpiry, expired: s.drugLicenseExpiry.getTime() < now.getTime() },
      plan: sub ? { status: statusAt(sub, now), planCode: sub.planCode, endDate: sub.endDate, maxUsers: sub.maxUsers } : null,
      users: u?.n ?? 0, lastActiveAt: u?.last ?? null,
    };
  });
  return { items: q.status && q.status !== 'suspended' ? out.filter((s) => s.plan?.status === q.status) : out, meta };
}

/** A shop as the platform sees it: who, plan, payments — never its bills, stock or customers (SECURITY §3). */
export async function shop(id: string, now = new Date()) {
  const shopId = new Types.ObjectId(id);
  const doc = await ShopModel.findById(shopId).lean();
  if (!doc) throw AppError.notFound('Shop not found');
  const [sub, owner, members, pays, log, prices, autopay] = await Promise.all([
    SubscriptionModel.findOne({ shopId }).lean(),
    UserModel.findById(doc.ownerUserId).select('name email phone').lean(),
    MembershipModel.find({ shopId }).select('designation status lastActiveAt').lean(),
    SubscriptionPaymentModel.find({ shopId, status: { $in: ['paid', 'failed'] } }).sort({ createdAt: -1 }).limit(20).lean(),
    AdminAuditModel.find({ shopId }).sort({ createdAt: -1 }).limit(20).lean(),
    plansFor(shopId, now),
    autopayOf(shopId),
  ]);
  return {
    id, name: doc.name, status: doc.status, createdAt: (doc as { createdAt?: Date }).createdAt ?? null,
    address: doc.address, phone: doc.phone, gstin: doc.gstin ?? '', drugLicense: { number: doc.drugLicenseNumber, expiry: doc.drugLicenseExpiry },
    owner: { name: owner?.name ?? '', email: owner?.email ?? '' },
    plan: sub ? { status: statusAt(sub, now), planCode: sub.planCode, startDate: sub.startDate, endDate: sub.endDate, maxUsers: sub.maxUsers, trialExtensions: sub.trialExtensions, cancelReason: sub.cancelReason ?? null } : null,
    users: { active: members.filter((m) => m.status === 'active').length, invited: members.filter((m) => m.status === 'invited').length },
    payments: pays.map(shapePayment),
    autopay,
    prices: prices.map((p) => ({ code: p.code, name: p.name, price: p.price, listPrice: p.listPrice, ownPrice: p.ownPrice, upcoming: p.upcoming })),
    log: log.map((l) => ({ id: String(l._id), at: (l as { createdAt?: Date }).createdAt ?? null, by: l.adminName, action: l.action, text: l.text, reason: l.reason })),
  };
}

export async function setStatus(a: AdminActor, id: string, status: 'active' | 'suspended', reason: string, ip?: string) {
  const doc = await ShopModel.findById(id);
  if (!doc) throw AppError.notFound('Shop not found');
  if (doc.status === status) throw AppError.conflict(`Already ${status}`);
  const before = doc.status;
  doc.set({ status });
  await doc.save();
  await log(a, status === 'suspended' ? 'shop_suspend' : 'shop_activate', reason, status === 'suspended' ? 'suspended the shop' : 'turned the shop back on', { id: doc._id, name: doc.name }, { before, after: status }, ip);
}

/** Extra days on the current plan (a trial goodwill, a support fix). An ended plan restarts from today. */
export async function extend(a: AdminActor, id: string, days: number, reason: string, ip?: string, now = new Date()) {
  const shopId = new Types.ObjectId(id);
  const doc = await ShopModel.findById(shopId).select('name').lean();
  const sub = await SubscriptionModel.findOne({ shopId });
  if (!doc || !sub) throw AppError.notFound('Shop not found');
  const from = statusAt(sub, now) === 'trial' || statusAt(sub, now) === 'active' ? sub.endDate : now;
  const end = new Date(from.getTime() + days * DAY);
  const before = sub.endDate;
  sub.set({ endDate: end, status: statusAt({ status: sub.status === 'cancelled' ? 'active' : sub.status, planCode: sub.planCode, endDate: end }, now), ...(sub.planCode === 'trial' ? { trialExtensions: sub.trialExtensions + 1 } : {}), cancelledAt: undefined, cancelReason: undefined });
  await sub.save();
  await log(a, 'plan_extend', reason, `added ${String(days)} days — now valid till ${end.toISOString().slice(0, 10)}`, { id: shopId, name: doc.name }, { before, after: end }, ip);
  return { endDate: end };
}

/** PLAN §36.1 Price & data: a shop's own price; cheaper now, dearer after 30 days. */
export async function setShopPrices(a: AdminActor, id: string, input: { code: string; price: number | null }[], reason: string, ip?: string) {
  const doc = await ShopModel.findById(id).select('name').lean();
  if (!doc) throw AppError.notFound('Shop not found');
  const lists = await planList();
  if (input.some((i) => !lists.some((l) => l.code === i.code))) throw AppError.validation('Unknown plan');
  const r = await setPrices(doc._id, input, lists, a.name);
  if (!r.changes.length) throw AppError.conflict('Nothing changed');
  const text = r.changes.map((c) => `${c.code} ${inr(c.from)} → ${inr(c.to)}${c.at === 'notice' ? ` from ${(r.priceFrom ?? new Date()).toISOString().slice(0, 10)}` : ' now'}`).join(' · ');
  await log(a, 'price_update', reason, `set the shop's price: ${text}`, { id: doc._id, name: doc.name }, r.changes, ip);
  return r;
}

/** SANDBOX A17: the email queue, the scheduler and Razorpay webhooks at a glance. */
export async function health(now = new Date()) {
  const day = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [mail, failed, runs, hooks] = await Promise.all([
    EmailJobModel.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    EmailJobModel.find({ status: 'failed' }).sort({ updatedAt: -1 }).limit(10).select('kind to lastError attempts updatedAt').lean(),
    JobRunModel.find({ at: { $gte: day } }).sort({ at: -1 }).limit(200).lean(),
    WebhookEventModel.find({}).sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  const by = (s: string) => mail.find((m) => m._id === s)?.n ?? 0;
  const kinds = new Map<string, { runs: number; last: Date }>();
  for (const r of runs) {
    const k = r.key.split(':')[0] ?? r.key;
    const v = kinds.get(k);
    kinds.set(k, { runs: (v?.runs ?? 0) + 1, last: v && v.last > r.at ? v.last : r.at });
  }
  return {
    mail: { pending: by('pending') + by('sending'), sent: by('sent'), failed: by('failed'), recentFailed: failed.map((f) => ({ id: String(f._id), kind: f.kind, to: f.to, error: f.lastError, attempts: f.attempts, at: (f as { updatedAt?: Date }).updatedAt ?? null })) },
    jobs: [...kinds.entries()].map(([kind, v]) => ({ kind, runs24h: v.runs, lastRun: v.last })),
    webhooks: hooks.map((w) => ({ id: String(w._id), event: w.event, valid: w.signatureValid, result: w.result, at: (w as { createdAt?: Date }).createdAt ?? null })),
  };
}

export async function retentionOf(id: string) {
  const shopId = new Types.ObjectId(id);
  if (!(await ShopModel.exists({ _id: shopId }))) throw AppError.notFound('Shop not found');
  const [plan, preview] = await Promise.all([retention.plan(shopId), retention.dryRun({ shopId })]);
  return { ...plan, preview };
}

/** PLAN §36.3: a longer tier applies now; a shorter one still waits the 90-day notice (the job checks). A hold needs the case name. */
export async function setRetention(a: AdminActor, id: string, v: { tier: 'legal' | 'y10'; legalHold: boolean; legalHoldReason: string; reason: string }, ip?: string) {
  const doc = await ShopModel.findById(id).select('name').lean();
  if (!doc) throw AppError.notFound('Shop not found');
  const before = await ShopTermsModel.findOne({ shopId: doc._id }).select('retention legalHold legalHoldReason').lean();
  await ShopTermsModel.updateOne({ shopId: doc._id }, { $set: { retention: v.tier, legalHold: v.legalHold, legalHoldReason: v.legalHold ? v.legalHoldReason : '' } }, { upsert: true });
  const what = [before?.retention !== v.tier ? `data kept: ${v.tier === 'y10' ? '10 years' : 'legal minimum'}` : '', Boolean(before?.legalHold) !== v.legalHold ? (v.legalHold ? `legal hold on (${v.legalHoldReason})` : 'legal hold off') : ''].filter(Boolean).join(' · ');
  await log(a, 'retention_update', v.reason, what || 'saved data settings', { id: doc._id, name: doc.name }, { before, after: v }, ip);
  return retentionOf(id);
}

export async function payments(q: { status?: string; cursor?: string; limit: number }) {
  const sort = { field: 'createdAt', dir: -1 } as const;
  const filter: Record<string, unknown> = { status: q.status ? q.status : { $in: ['paid', 'failed'] } };
  const rows = await SubscriptionPaymentModel.find({ ...filter, ...afterCursor(q.cursor, sort) }).sort(sortOf(sort)).limit(q.limit + 1).lean<{ _id: Types.ObjectId; shopId: Types.ObjectId; planName: string; amount: number; gst: number; status: string; invoiceNumber?: string; source: string; razorpayPaymentId?: string; paidAt?: Date; createdAt: Date; failureReason?: string; refunded?: number; dispute?: { status?: string | null } | null }[]>();
  const { items, meta } = page(rows, q.limit, (r) => r.createdAt);
  const names = new Map((await ShopModel.find({ _id: { $in: items.map((p) => p.shopId) } }).select('name').lean()).map((s) => [String(s._id), s.name]));
  return { items: items.map((p) => ({ id: String(p._id), shopId: String(p.shopId), shopName: names.get(String(p.shopId)) ?? '', planName: p.planName, amount: p.amount, gst: p.gst, status: p.status, invoiceNumber: p.invoiceNumber ?? null, source: p.source, paymentId: p.razorpayPaymentId ?? null, paidAt: p.paidAt ?? null, createdAt: p.createdAt, failureReason: p.failureReason ?? null, refunded: p.refunded ?? 0, dispute: p.dispute?.status ?? null })), meta };
}

/** B8c: money back (accounts / super, with a reason) — Razorpay refund, GST credit note, and the plan days when asked. */
export async function refundPayment(a: AdminActor, id: string, input: { amount: number; removeDays: boolean; reason: string }, ip?: string) {
  const r = await refund(id, input, { id: a.id, name: `MedShop · ${a.name}` });
  const doc = await ShopModel.findById(r.shopId).select('name').lean();
  await log(a, 'refund', input.reason, `refunded ${inr(r.amount)} on ${r.invoiceNumber} — credit note ${r.creditNote}${r.days ? `, ${String(r.days)} plan days removed` : ''}`, { id: r.shopId, name: doc?.name ?? '' }, undefined, ip);
  return r;
}

export async function stopShopAutopay(a: AdminActor, id: string, reason: string, ip?: string) {
  const doc = await ShopModel.findById(id).select('name').lean();
  if (!doc) throw AppError.notFound('Shop not found');
  if (!(await stopAutopay(doc._id, { id: a.id, name: `MedShop · ${a.name}` }, reason, ip))) throw AppError.conflict('Autopay is not on');
  await log(a, 'autopay_stop', reason, 'stopped autopay', { id: doc._id, name: doc.name }, undefined, ip);
}

/** Cash, cheque or bank transfer taken outside Razorpay (accounts): same extension and invoice as an online payment. */
export async function manualPayment(a: AdminActor, input: { shopId: string; planCode: string; reference: string; reason: string }, ip?: string) {
  const doc = await ShopModel.findById(input.shopId).select('name').lean();
  if (!doc) throw AppError.notFound('Shop not found');
  const p = await recordManual(new Types.ObjectId(input.shopId), input.planCode, input.reference, { id: a.id, name: `MedShop · ${a.name}` });
  await log(a, 'payment_manual', input.reason, `recorded ${inr(p.amount)} for ${p.planName} (${input.reference}) — invoice ${p.invoiceNumber ?? ''}`, { id: doc._id, name: doc.name }, undefined, ip);
  return p;
}

export async function setPlans(a: AdminActor, list: { code: string; name: string; price: number; durationDays: number; maxUsers: number; isActive: boolean }[], reason: string, ip?: string) {
  const before = await planList();
  for (const [i, p] of list.entries()) await PlanModel.updateOne({ code: p.code }, { $set: { ...p, sortOrder: i + 1 } }, { upsert: true });
  await log(a, 'plans_update', reason, `changed plans: ${list.map((p) => `${p.name} ${inr(p.price)}${p.isActive ? '' : ' (off)'}`).join(', ')}`, undefined, { before, after: list }, ip);
  return planList();
}

export async function settings() {
  const s = await PlatformSettingsModel.findById('platform').lean();
  return { trialDays: s?.trialDays ?? 14, trialMaxUsers: s?.trialMaxUsers ?? 3, graceDays: s?.graceDays ?? 7, supportEmail: s?.supportEmail ?? '', supportPhone: s?.supportPhone ?? '', maintenance: { on: s?.maintenance?.on ?? false, message: s?.maintenance?.message ?? '' } };
}

export async function saveSettings(a: AdminActor, input: Awaited<ReturnType<typeof settings>>, reason: string, ip?: string) {
  const before = await settings();
  await PlatformSettingsModel.updateOne({ _id: 'platform' }, { $set: { ...input, updatedBy: a.name } }, { upsert: true });
  forgetPlatform();
  await platform();
  await log(a, 'settings_update', reason, 'changed platform settings', undefined, { before, after: input }, ip);
  return settings();
}

export async function team() {
  const rows = await AdminUserModel.find({}).sort({ createdAt: 1 }).lean();
  return rows.map((u) => ({ id: String(u._id), email: u.email, name: u.name, role: u.role, status: u.status, totp: Boolean(u.totpEnabledAt), lastLoginAt: u.lastLoginAt ?? null }));
}

export async function invite(a: AdminActor, input: { email: string; name: string; role: AdminRole }, reason: string, ip?: string) {
  if (!ADMIN_ROLES.includes(input.role)) throw AppError.validation('Choose a role');
  const exists = await AdminUserModel.exists({ email: input.email.toLowerCase() });
  if (exists) throw AppError.conflict('Already on the platform team');
  await AdminUserModel.create({ email: input.email, name: input.name, role: input.role, invitedBy: a.name });
  await log(a, 'team_invite', reason, `added ${input.name} <${input.email}> as ${input.role}`, undefined, undefined, ip);
  return team();
}

export async function setMember(a: AdminActor, id: string, input: { role?: AdminRole; status?: 'active' | 'disabled' }, reason: string, ip?: string) {
  if (id === a.id) throw AppError.conflict('You can’t change your own role or turn yourself off');
  const u = await AdminUserModel.findById(id);
  if (!u) throw AppError.notFound('Not on the platform team');
  const before = { role: u.role, status: u.status };
  u.set(input);
  await u.save();
  await log(a, 'team_update', reason, `changed ${u.name}: ${JSON.stringify(before)} → ${JSON.stringify(input)}`, undefined, { before, after: input }, ip);
  return team();
}

export async function auditLog(q: { cursor?: string; limit: number }) {
  const sort = { field: 'createdAt', dir: -1 } as const;
  const rows = await AdminAuditModel.find({ ...afterCursor(q.cursor, sort) }).sort(sortOf(sort)).limit(q.limit + 1).lean<{ _id: Types.ObjectId; createdAt: Date; adminName: string; shopName?: string; shopId?: Types.ObjectId; action: string; reason: string; text: string }[]>();
  const { items, meta } = page(rows, q.limit, (r) => r.createdAt);
  return { items: items.map((l) => ({ id: String(l._id), at: l.createdAt, by: l.adminName, shopId: l.shopId ? String(l.shopId) : null, shopName: l.shopName ?? null, action: l.action, reason: l.reason, text: l.text })), meta };
}
